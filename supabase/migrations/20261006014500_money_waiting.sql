-- =============================================================================
-- Money waiting (MNY-01)
-- =============================================================================
-- public.report_money_waiting(org, owner): how much money the business can bring in
-- by handling what is already in the system (additions spec 18.6). Built only from
-- the modules that exist today; quotes, debts, renewals and dormant customers join
-- when their modules are built (each a key of its own, counted once).
--
-- * to_close (the main number): open deals that need a decision, from
--   public.report_pipeline_cleanup (MNY-05, the same rules): stuck by time in stage
--   (the report_stuck_deals rule) and overdue (expected close date passed, not
--   stuck), each deal once; postponed deals are left out until their day.
--   deals: the cleanup's rows (at most 300; group = stuck, else overdue).
-- * estimate (shown apart, never in the main number): unhandled leads valued by the
--   average won deal (additions spec 22.9: deals won in the last 90 days, only when
--   there are at least five; otherwise average and amount are null).
--   Unhandled = the rule of the waiting-leads screen (SPD-02,
--   src/features/leads/waiting.ts): an open status, not converted, not imported, not
--   in the bin, and no contact entry logged by a person (app.contact_types()) that is
--   not private (a private note is not an answer, and would make the result depend
--   on who looks). A lead someone else took ("לקחתי", SPD-01: taken_at set, owned by
--   another person) is left out as on the waiting screen (takenLeadsFilter in
--   src/features/leads/take.ts): it stays only for its owner, owners and admins, and
--   managers of its team or a parent team (app.manages_team). Keep the two in step.
--   leads: the 100 newest of them.
-- * The average is over the won deals the caller sees (RLS), not the whole business's.
-- * p_owner narrows deals and leads to one person; the average is not narrowed.
-- * SECURITY INVOKER, like every report: RLS decides which deals and leads count.
-- Every statement is safe to run twice. Nothing is removed.

create or replace function public.report_money_waiting(p_org uuid, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with cleanup as (
    select public.report_pipeline_cleanup(p_org, p_owner) as c
  ), won as (
    select count(*) as deals, avg(w.amount_agorot) as average
      from public.deals w
     where w.organization_id = p_org and w.deleted_at is null and w.status = 'won'
       and w.closed_at >= now() - interval '90 days'
  ), l as (
    select l.id, l.full_name, l.company_name, l.phone, l.phone_e164, l.email, l.owner_id, l.created_at
      from public.leads l
      join public.lead_statuses st on st.organization_id = l.organization_id and st.id = l.status_id
     where l.organization_id = p_org and l.deleted_at is null and l.converted_at is null
       and l.import_job_id is null and st.kind = 'open'
       and (p_owner is null or l.owner_id = p_owner)
       and not exists (
         select 1 from public.activities a
          where a.organization_id = l.organization_id and a.lead_id = l.id
            and a.created_by is not null and a.type = any (app.contact_types())
            and not a.is_private)
       and (l.taken_at is null
            or l.owner_id = (select auth.uid())
            or app.membership_role(p_org) in ('owner', 'admin')
            or (app.membership_role(p_org) = 'manager' and l.team_id is not null and app.manages_team(l.team_id)))
  ), avg_value as (
    select case when won.deals >= 5 then round(won.average)::bigint end as average, won.deals from won
  )
  select jsonb_build_object(
    'today', c -> 'today',
    'to_close', jsonb_build_object(
      'deals', (c -> 'stuck' ->> 'deals')::bigint + (c -> 'overdue' ->> 'deals')::bigint,
      'amount', (c -> 'stuck' ->> 'amount')::bigint + (c -> 'overdue' ->> 'amount')::bigint),
    'stuck', c -> 'stuck',
    'overdue', c -> 'overdue',
    'deals', c -> 'deals',
    'estimate', (
      select jsonb_build_object(
               'leads', (select count(*) from l),
               'won_deals', av.deals,
               'average', av.average,
               'amount', av.average * (select count(*) from l),
               'days', 90,
               'min_deals', 5)
        from avg_value av),
    'leads', coalesce((
      select jsonb_agg(z order by z.created_at desc, z.id)
        from (select * from l order by l.created_at desc, l.id limit 100) z), '[]'::jsonb))
    from cleanup
   where c is not null;
$$;

revoke all on function public.report_money_waiting(uuid, uuid) from public, anon;
grant execute on function public.report_money_waiting(uuid, uuid) to authenticated;
