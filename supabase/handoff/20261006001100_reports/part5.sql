-- 20261006001100_reports: part 5 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- 6. Revenue forecast: open deals by expected close month, weighted by probability
-- ----------------------------------------------------------------------------
create or replace function public.report_forecast(
  p_org uuid, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.month nulls last), '[]'::jsonb)
    from (
      select date_trunc('month', d.expected_close_date)::date as month,
             count(*) as deals,
             coalesce(sum(d.amount_agorot), 0) as amount,
             coalesce(round(sum(d.amount_agorot * d.probability / 100.0)), 0)::bigint as weighted
        from public.deals d
       where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
         and (p_pipeline is null or d.pipeline_id = p_pipeline)
         and (p_owner is null or d.owner_id = p_owner)
       group by 1
    ) r;
$$;

-- ----------------------------------------------------------------------------
-- 7. Loss reasons: by reason, by the stage the deal was in before it was lost, by owner
-- ----------------------------------------------------------------------------
create or replace function public.report_lost_reasons(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with lost as (
    select d.id, d.owner_id, d.amount_agorot, nullif(btrim(d.lost_reason), '') as reason,
           (select app.safe_uuid(a.metadata ->> 'from_stage_id')
              from public.activities a
             where a.organization_id = d.organization_id and a.deal_id = d.id and a.type = 'stage_change'
               and app.safe_uuid(a.metadata ->> 'to_stage_id') = d.stage_id
             order by a.occurred_at desc limit 1) as from_stage_id
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'lost'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  )
  select jsonb_build_object(
    'by_reason', coalesce((
      select jsonb_agg(r order by r.deals desc) from (
        select reason, count(*) as deals, coalesce(sum(amount_agorot), 0) as amount
          from lost group by reason) r), '[]'::jsonb),
    'by_stage', coalesce((
      select jsonb_agg(r order by r.position nulls last) from (
        select l.from_stage_id as stage_id, s.name, s.position, count(*) as deals
          from lost l
          left join public.stages s on s.organization_id = p_org and s.id = l.from_stage_id
         group by l.from_stage_id, s.name, s.position) r), '[]'::jsonb),
    'by_owner', coalesce((
      select jsonb_agg(r order by r.deals desc) from (
        select owner_id, count(*) as deals, coalesce(sum(amount_agorot), 0) as amount
          from lost group by owner_id) r), '[]'::jsonb));
$$;
