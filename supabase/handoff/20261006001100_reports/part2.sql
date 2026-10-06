-- 20261006001100_reports: part 2 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- 2. Funnel: leads created -> contacted -> converted -> won, and how far the
--    pipeline's deals got (a stage counts as reached when the deal is or was in
--    it, or in a later open stage, or won)
-- ----------------------------------------------------------------------------
create or replace function public.report_funnel(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null, p_pipeline uuid default null)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_pipeline uuid := app.report_pipeline(p_org, p_pipeline);
  v_leads jsonb;
  v_stages jsonb;
  v_closed jsonb;
begin
  select jsonb_build_object(
           'created', count(*),
           'contacted', count(*) filter (where l.converted_at is not null or exists (
              select 1 from public.activities a
               where a.organization_id = l.organization_id and a.lead_id = l.id
                 and a.created_by is not null and a.type = any (app.contact_types()))),
           'converted', count(l.converted_at),
           'won', count(d.id) filter (where d.status = 'won'))
    into v_leads
    from public.leads l
    left join public.deals d on d.organization_id = l.organization_id and d.id = l.converted_deal_id
                            and d.deleted_at is null
   where l.organization_id = p_org and l.deleted_at is null
     and l.created_at >= p_from and l.created_at < p_to
     and (p_owner is null or l.owner_id = p_owner);

  with d as (
    select d.id, d.status, st.kind, st.position
      from public.deals d
      join public.stages st on st.organization_id = d.organization_id and st.id = d.stage_id
     where d.organization_id = p_org and d.pipeline_id = v_pipeline and d.deleted_at is null
       and d.created_at >= p_from and d.created_at < p_to
       and (p_owner is null or d.owner_id = p_owner)
  ), hist as (
    select a.deal_id, max(s.position) as position
      from public.activities a
      join public.stages s on s.organization_id = a.organization_id and s.kind = 'open'
                          and s.id in (app.safe_uuid(a.metadata ->> 'from_stage_id'), app.safe_uuid(a.metadata ->> 'to_stage_id'))
     where a.organization_id = p_org and a.type = 'stage_change' and a.deal_id in (select id from d)
     group by a.deal_id
  ), reach as (
    select case when d.status = 'won' then 2147483647
                else greatest(case when d.kind = 'open' then d.position else -1 end, coalesce(h.position, -1)) end as position
      from d left join hist h on h.deal_id = d.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'stage_id', s.id, 'name', s.name, 'position', s.position,
           'reached', (select count(*) from reach r where r.position >= s.position))
           order by s.position), '[]'::jsonb)
    into v_stages
    from public.stages s
   where s.organization_id = p_org and s.pipeline_id = v_pipeline and s.kind = 'open';

  select jsonb_build_object(
           'deals', count(*),
           'won', count(*) filter (where d.status = 'won'),
           'lost', count(*) filter (where d.status = 'lost'))
    into v_closed
    from public.deals d
   where d.organization_id = p_org and d.pipeline_id = v_pipeline and d.deleted_at is null
     and d.created_at >= p_from and d.created_at < p_to
     and (p_owner is null or d.owner_id = p_owner);

  return jsonb_build_object('leads', v_leads, 'pipeline_id', v_pipeline, 'stages', v_stages, 'deals', v_closed);
end;
$$;
