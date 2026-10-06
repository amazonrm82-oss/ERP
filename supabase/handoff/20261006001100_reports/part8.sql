-- 20261006001100_reports: part 8 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- 10. Revenue: won deals by month, by owner, top customers
-- ----------------------------------------------------------------------------
create or replace function public.report_revenue(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with tz as (
    select coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem') as name
  ), won as (
    select d.amount_agorot, d.owner_id, d.company_id, d.contact_id,
           date_trunc('month', d.closed_at at time zone (select name from tz))::date as month
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  )
  select jsonb_build_object(
    'by_month', coalesce((
      select jsonb_agg(r order by r.month) from (
        select month, count(*) as deals, sum(amount_agorot) as amount from won group by month) r), '[]'::jsonb),
    'by_owner', coalesce((
      select jsonb_agg(r order by r.amount desc) from (
        select owner_id, count(*) as deals, sum(amount_agorot) as amount from won group by owner_id) r), '[]'::jsonb),
    'by_customer', coalesce((
      select jsonb_agg(r order by r.amount desc) from (
        select w.company_id, w.contact_id, coalesce(c.name, ct.full_name) as name,
               count(*) as deals, sum(w.amount_agorot) as amount
          from won w
          left join public.companies c on c.organization_id = p_org and c.id = w.company_id
          left join public.contacts ct on ct.organization_id = p_org and ct.id = w.contact_id
         group by w.company_id, w.contact_id, coalesce(c.name, ct.full_name)
         order by sum(w.amount_agorot) desc
         limit 10) r), '[]'::jsonb));
$$;
