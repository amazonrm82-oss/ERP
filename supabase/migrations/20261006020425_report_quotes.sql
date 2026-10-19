-- QUO-17: the quotes report (spec: "quotes sent, acceptance rate, average time to acceptance, value of open quotes").
--
-- public.report_quotes(org, from, to, owner) is security invoker like every report_* function: RLS on quotes (their deal,
-- else their contact; a detached quote for owners/admins/managers), on activities and on quote_decisions decides what is
-- counted. Amounts are agorot in ILS (quotes.currency is ILS only).
--
-- * One chain counts once. A quote that has a newer version that was sent (quotes.previous_id points at it and that version
--   has sent_at) is superseded and left out of every figure; its chain is counted through its newest sent version, which is
--   the one the customer can still see and answer (QUO-11 review). A draft version supersedes nothing.
-- * Sent in the period: sent_at in [from, to), whatever the quote's status is now; split by status.
-- * Acceptance rate = accepted / (accepted + rejected) of those quotes; null while fewer than 5 are decided (`rate_min`).
-- * Average time to acceptance, in hours, over the accepted quotes of the period: from sent_at to the decision. The decision
--   time is quote_decisions.decided_at when the caller may read it (owners and admins), else the time of the quote's
--   "accepted" timeline entry (app.quote_timeline_entry writes it in the same transaction as the status change, so the two
--   are the same moment), which whoever reads the deal or contact may read. An accepted quote with neither (a detached quote
--   whose timeline entry went with its record) is not measured; `accepted_measured` says how many were.
-- * Open value = the stored total of quotes that are sent or viewed now and whose validity has not passed in the business's
--   time zone (the rule of app.quote_link_open), whenever they were sent: the current state, not the period.
-- * p_owner limits everything to quotes whose owner_id is that person.

create or replace function public.report_quotes(p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with live as (
    -- the newest sent version of each chain (and every quote that has no sent newer version)
    select q.id, q.owner_id, q.status, q.sent_at, q.total_agorot, q.valid_until
      from public.quotes q
     where q.organization_id = p_org
       and q.status <> 'draft'
       and q.sent_at is not null
       and (p_owner is null or q.owner_id = p_owner)
       and not exists (select 1 from public.quotes n
                        where n.organization_id = q.organization_id and n.previous_id = q.id and n.sent_at is not null)
  ), today as (
    select (now() at time zone coalesce(nullif(o.timezone, ''), 'Asia/Jerusalem'))::date as d
      from public.organizations o where o.id = p_org
  ), period as (
    select l.* from live l where l.sent_at >= p_from and l.sent_at < p_to
  ), accepted_at as (
    select p.id, p.owner_id,
           coalesce(
             (select d.decided_at from public.quote_decisions d
               where d.organization_id = p_org and d.quote_id = p.id and d.decision = 'accepted'),
             (select min(a.created_at) from public.activities a
               where a.organization_id = p_org and a.type = 'system'
                 and a.metadata ->> 'kind' = 'quote_accepted' and a.metadata ->> 'quote_id' = p.id::text)
           ) - p.sent_at as took
      from period p
     where p.status = 'accepted'
  ), open_now as (
    select l.* from live l
     where l.status in ('sent', 'viewed')
       and (l.valid_until is null or l.valid_until >= (select d from today))
  ), owners as (
    select owner_id from period union select owner_id from open_now
  ), per as (
    select o.owner_id,
           (select count(*) from period p where p.owner_id is not distinct from o.owner_id) as sent,
           (select count(*) from period p where p.owner_id is not distinct from o.owner_id and p.status = 'accepted') as accepted,
           (select count(*) from period p where p.owner_id is not distinct from o.owner_id and p.status = 'rejected') as rejected,
           (select coalesce(sum(p.total_agorot), 0) from period p
             where p.owner_id is not distinct from o.owner_id and p.status = 'accepted') as accepted_amount,
           (select round(extract(epoch from avg(a.took)) / 3600.0, 1) from accepted_at a
             where a.owner_id is not distinct from o.owner_id and a.took is not null) as avg_hours_to_accept,
           (select count(*) from open_now n where n.owner_id is not distinct from o.owner_id) as open_count,
           (select coalesce(sum(n.total_agorot), 0) from open_now n where n.owner_id is not distinct from o.owner_id) as open_amount
      from owners o
  )
  select jsonb_build_object(
    'rate_min', 5,
    'totals', jsonb_build_object(
      'sent', (select count(*) from period),
      'viewed', (select count(*) from period where status = 'viewed'),
      'waiting', (select count(*) from period where status = 'sent'),
      'accepted', (select count(*) from period where status = 'accepted'),
      'rejected', (select count(*) from period where status = 'rejected'),
      'expired', (select count(*) from period where status = 'expired'),
      'cancelled', (select count(*) from period where status = 'cancelled'),
      'acceptance_rate', (select case when count(*) filter (where status in ('accepted', 'rejected')) >= 5
                                      then round(100.0 * count(*) filter (where status = 'accepted')
                                                 / count(*) filter (where status in ('accepted', 'rejected')), 1) end
                            from period),
      'accepted_amount', (select coalesce(sum(total_agorot), 0) from period where status = 'accepted'),
      'avg_hours_to_accept', (select round(extract(epoch from avg(took)) / 3600.0, 1) from accepted_at where took is not null),
      'accepted_measured', (select count(*) from accepted_at where took is not null),
      'open_count', (select count(*) from open_now),
      'open_amount', (select coalesce(sum(total_agorot), 0) from open_now)
    ),
    'by_owner', coalesce((
      select jsonb_agg(jsonb_build_object(
               'owner_id', r.owner_id,
               'sent', r.sent,
               'accepted', r.accepted,
               'rejected', r.rejected,
               'acceptance_rate', case when r.accepted + r.rejected >= 5
                                       then round(100.0 * r.accepted / (r.accepted + r.rejected), 1) end,
               'accepted_amount', r.accepted_amount,
               'avg_hours_to_accept', r.avg_hours_to_accept,
               'open_count', r.open_count,
               'open_amount', r.open_amount)
             order by r.sent desc, r.open_amount desc, r.owner_id)
        from per r), '[]'::jsonb)
  );
$$;
revoke all on function public.report_quotes(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.report_quotes(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The export log knows the new report key (the body of 020331 with 'quotes')
-- ----------------------------------------------------------------------------
create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if not app.can_export(p_org) then
      raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
    -- DLI-06: gross profit carries costs
    if p_report = 'profit' and not app.can_view_costs(p_org) then
      raise exception 'the gross profit report is for those who may see costs' using errcode = '42501';
    end if;
    -- QUO-17: the quotes report belongs to the quotes capability
    if p_report = 'quotes' and not app.org_has_feature(p_org, 'quotes') then
      raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;
