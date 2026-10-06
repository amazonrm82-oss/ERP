-- 20261006001100_reports: part 9 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- Manager dashboard: this period against the previous one, plus the pipeline now
-- ----------------------------------------------------------------------------
create or replace function public.report_summary(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_prev_from timestamptz, p_prev_to timestamptz,
  p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with leads as (
    select l.created_at from public.leads l
     where l.organization_id = p_org and l.deleted_at is null
       and l.created_at >= least(p_from, p_prev_from) and l.created_at < greatest(p_to, p_prev_to)
       and (p_owner is null or l.owner_id = p_owner)
  ), closed as (
    select d.status, d.amount_agorot, d.closed_at from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status <> 'open'
       and d.closed_at >= least(p_from, p_prev_from) and d.closed_at < greatest(p_to, p_prev_to)
       and (p_owner is null or d.owner_id = p_owner)
  ), open_deals as (
    select d.amount_agorot, d.probability from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
       and (p_owner is null or d.owner_id = p_owner)
  )
  select jsonb_build_object(
    'leads', (select count(*) from leads where created_at >= p_from and created_at < p_to),
    'leads_prev', (select count(*) from leads where created_at >= p_prev_from and created_at < p_prev_to),
    'won', (select count(*) from closed where status = 'won' and closed_at >= p_from and closed_at < p_to),
    'won_prev', (select count(*) from closed where status = 'won' and closed_at >= p_prev_from and closed_at < p_prev_to),
    'won_amount', (select coalesce(sum(amount_agorot), 0) from closed where status = 'won' and closed_at >= p_from and closed_at < p_to),
    'won_amount_prev', (select coalesce(sum(amount_agorot), 0) from closed where status = 'won' and closed_at >= p_prev_from and closed_at < p_prev_to),
    'lost', (select count(*) from closed where status = 'lost' and closed_at >= p_from and closed_at < p_to),
    'lost_prev', (select count(*) from closed where status = 'lost' and closed_at >= p_prev_from and closed_at < p_prev_to),
    'open', (select count(*) from open_deals),
    'open_amount', (select coalesce(sum(amount_agorot), 0) from open_deals),
    'weighted_amount', (select coalesce(round(sum(amount_agorot * probability / 100.0)), 0)::bigint from open_deals),
    'overdue_tasks', (select count(*) from public.tasks t
                       where t.organization_id = p_org and t.deleted_at is null and t.status = 'open'
                         and t.due_at < now() and (p_owner is null or t.owner_id = p_owner)));
$$;

-- ----------------------------------------------------------------------------
-- Grants: signed-in users only; RLS inside does the rest
-- ----------------------------------------------------------------------------
revoke all on function app.safe_uuid(text) from public, anon;
revoke all on function app.contact_types() from public, anon;
revoke all on function app.report_pipeline(uuid, uuid) from public, anon;
grant execute on function app.safe_uuid(text) to authenticated, service_role;
grant execute on function app.contact_types() to authenticated, service_role;
grant execute on function app.report_pipeline(uuid, uuid) to authenticated, service_role;
