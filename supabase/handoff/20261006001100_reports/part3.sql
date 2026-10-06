-- 20261006001100_reports: part 3 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- 3. Lead response time per owner: minutes from creation to first contact
-- ----------------------------------------------------------------------------
create or replace function public.report_response_time(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with l as (
    select l.owner_id,
           (select greatest(extract(epoch from min(a.occurred_at) - l.created_at) / 60, 0)
              from public.activities a
             where a.organization_id = l.organization_id and a.lead_id = l.id
               and a.created_by is not null and a.type = any (app.contact_types())) as minutes
      from public.leads l
     where l.organization_id = p_org and l.deleted_at is null
       and l.created_at >= p_from and l.created_at < p_to
       and (p_owner is null or l.owner_id = p_owner)
  )
  select coalesce(jsonb_agg(r order by r.leads desc), '[]'::jsonb)
    from (
      select owner_id,
             count(*) as leads,
             count(minutes) as contacted,
             round(avg(minutes)::numeric, 1) as avg_minutes,
             round((percentile_cont(0.5) within group (order by minutes))::numeric, 1) as median_minutes,
             count(*) filter (where minutes <= 60) as within_hour
        from l
       group by owner_id
    ) r;
$$;

-- ----------------------------------------------------------------------------
-- 4. Rep performance: deals won and lost in the period, open pipeline now
-- ----------------------------------------------------------------------------
create or replace function public.report_rep_performance(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.won_amount desc, r.open_count desc), '[]'::jsonb)
    from (
      select d.owner_id,
             count(*) filter (where d.status = 'won' and d.closed_at >= p_from and d.closed_at < p_to) as won,
             coalesce(sum(d.amount_agorot) filter (where d.status = 'won' and d.closed_at >= p_from and d.closed_at < p_to), 0) as won_amount,
             count(*) filter (where d.status = 'lost' and d.closed_at >= p_from and d.closed_at < p_to) as lost,
             count(*) filter (where d.status = 'open') as open_count,
             coalesce(sum(d.amount_agorot) filter (where d.status = 'open'), 0) as open_amount
        from public.deals d
       where d.organization_id = p_org and d.deleted_at is null
         and (p_pipeline is null or d.pipeline_id = p_pipeline)
         and (d.status = 'open' or (d.closed_at >= p_from and d.closed_at < p_to))
       group by d.owner_id
    ) r;
$$;
