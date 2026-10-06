-- 20261006001100_reports: part 6 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- 8. Sales cycle: days to win, days from the first lead contact, days in each stage
-- ----------------------------------------------------------------------------
create or replace function public.report_cycle_length(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with won as (
    select extract(epoch from d.closed_at - d.created_at) / 86400 as days,
           (select extract(epoch from d.closed_at - l.created_at) / 86400
              from public.leads l
             where l.organization_id = d.organization_id and l.converted_deal_id = d.id
             limit 1) as days_from_lead
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  ), changes as (
    select app.safe_uuid(a.metadata ->> 'from_stage_id') as stage_id, a.occurred_at,
           coalesce(lag(a.occurred_at) over (partition by a.deal_id order by a.occurred_at), d.created_at) as entered_at
      from public.activities a
      join public.deals d on d.organization_id = a.organization_id and d.id = a.deal_id and d.deleted_at is null
     where a.organization_id = p_org and a.type = 'stage_change'
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  )
  select jsonb_build_object(
    'won', (select count(*) from won),
    'avg_days', (select round(avg(days)::numeric, 1) from won),
    'median_days', (select round((percentile_cont(0.5) within group (order by days))::numeric, 1) from won),
    'from_lead', (select count(days_from_lead) from won),
    'avg_days_from_lead', (select round(avg(days_from_lead)::numeric, 1) from won),
    'stages', coalesce((
      select jsonb_agg(r order by r.position) from (
        select s.id as stage_id, s.name, s.position, count(*) as moves,
               round(avg(extract(epoch from c.occurred_at - c.entered_at) / 86400)::numeric, 1) as avg_days
          from changes c
          join public.stages s on s.organization_id = p_org and s.id = c.stage_id and s.kind = 'open'
         where c.occurred_at >= p_from and c.occurred_at < p_to
         group by s.id, s.name, s.position) r), '[]'::jsonb));
$$;
