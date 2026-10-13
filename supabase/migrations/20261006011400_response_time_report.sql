-- =============================================================================
-- Response time report: share answered within the target, by source and by hour (SPD-06)
-- =============================================================================
-- The response time report showed the average and median minutes from a lead's
-- creation to the first contact (an activity a person logged of type note, call,
-- meeting, email, whatsapp or sms), per owner. It now also shows:
--
-- * within_target: leads answered within the response target, per owner. The
--   target comes from app.response_target_minutes(org), one place. Until CAP-10
--   (wave 2) gives the organization its own target it is 15 minutes, the example
--   target of SPEC.md 8.2 ("יעד למגע ראשון, למשל 15 דקות"). The share is out of
--   all the leads of the period, like within_hour: a lead with no contact yet is
--   not answered within the target.
-- * public.report_response_breakdown(): the same measures per lead source and
--   per hour of the day the lead arrived, in the organization's time zone.
--
-- The minutes of a lead nobody contacted are null (fixed here, see below). A
-- private note is not contact with the customer (same rule as LEAD-02, 0067).
--
-- Both are SECURITY INVOKER, like every report: RLS decides which leads and
-- activities are counted. Time is still wall-clock time; business hours (CAP-09)
-- come in wave 2.

create or replace function app.response_target_minutes(p_org uuid) returns integer
language sql stable
set search_path = ''
as $$
  select 15;
$$;

revoke all on function app.response_target_minutes(uuid) from public, anon;
grant execute on function app.response_target_minutes(uuid) to authenticated, service_role;

-- 0011 body, plus within_target, and one fix: greatest() skips nulls, so
-- greatest(null, 0) was 0 and a lead nobody contacted counted as contacted in
-- 0 minutes (contacted = leads, "leads with no contact" always 0, and the
-- average pulled down). A lead with no contact now has minutes = null again.
create or replace function public.report_response_time(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with l as (
    select l.owner_id,
           (select case when min(a.occurred_at) is not null
                        then greatest(extract(epoch from min(a.occurred_at) - l.created_at) / 60, 0) end
              from public.activities a
             where a.organization_id = l.organization_id and a.lead_id = l.id
               and a.created_by is not null and a.type = any (app.contact_types())
               and not a.is_private) as minutes
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
             count(*) filter (where minutes <= 60) as within_hour,
             count(*) filter (where minutes <= app.response_target_minutes(p_org)) as within_target
        from l
       group by owner_id
    ) r;
$$;

create or replace function public.report_response_breakdown(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with tz as (
    select coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem') as name
  ), l as (
    select l.source_id,
           extract(hour from l.created_at at time zone (select name from tz))::integer as hour,
           (select case when min(a.occurred_at) is not null
                        then greatest(extract(epoch from min(a.occurred_at) - l.created_at) / 60, 0) end
              from public.activities a
             where a.organization_id = l.organization_id and a.lead_id = l.id
               and a.created_by is not null and a.type = any (app.contact_types())
               and not a.is_private) as minutes
      from public.leads l
     where l.organization_id = p_org and l.deleted_at is null
       and l.created_at >= p_from and l.created_at < p_to
       and (p_owner is null or l.owner_id = p_owner)
  ), target as (
    select app.response_target_minutes(p_org) as minutes
  ), by_source as (
    select l.source_id, s.name as source_name,
           count(*) as leads,
           count(l.minutes) as contacted,
           count(*) filter (where l.minutes <= (select minutes from target)) as within_target,
           round(avg(l.minutes)::numeric, 1) as avg_minutes,
           round((percentile_cont(0.5) within group (order by l.minutes))::numeric, 1) as median_minutes
      from l
      left join public.lead_sources s on s.organization_id = p_org and s.id = l.source_id
     group by l.source_id, s.name
  ), by_hour as (
    select l.hour,
           count(*) as leads,
           count(l.minutes) as contacted,
           count(*) filter (where l.minutes <= (select minutes from target)) as within_target,
           round(avg(l.minutes)::numeric, 1) as avg_minutes,
           round((percentile_cont(0.5) within group (order by l.minutes))::numeric, 1) as median_minutes
      from l
     group by l.hour
  )
  select jsonb_build_object(
           'target_minutes', (select minutes from target),
           'by_source', coalesce((select jsonb_agg(r order by r.leads desc, r.source_name collate "C") from by_source r), '[]'::jsonb),
           'by_hour', coalesce((select jsonb_agg(r order by r.hour) from by_hour r), '[]'::jsonb));
$$;

revoke all on function public.report_response_time(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_response_breakdown(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.report_response_time(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_response_breakdown(uuid, timestamptz, timestamptz, uuid) to authenticated;
