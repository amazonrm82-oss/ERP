-- =============================================================================
-- 0011 Reports: the ten built-in reports and the manager dashboard summary
-- =============================================================================
-- Every function here is SECURITY INVOKER: it runs as the signed-in user, so
-- Row Level Security decides which leads, deals and activities are counted.
-- A member whose organization shows only "own" records sees a report of their
-- own records; a non-member gets empty results.
-- Each function returns jsonb; the app formats it. Amounts are agorot.
-- "Contact with the customer" = an activity a person logged (created_by set)
-- of type note, call, meeting, email, whatsapp or sms.

-- uuid from text, or null when the text is not a uuid (metadata is client-writable)
create or replace function app.safe_uuid(p_text text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then p_text::uuid end;
$$;

create or replace function app.contact_types() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['note', 'call', 'meeting', 'email', 'whatsapp', 'sms'];
$$;

-- the pipeline a report looks at: the one asked for, or the organization's default
create or replace function app.report_pipeline(p_org uuid, p_pipeline uuid) returns uuid
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select p.id from public.pipelines p
      where p.organization_id = p_org and p.id = p_pipeline and p.deleted_at is null),
    (select p.id from public.pipelines p
      where p.organization_id = p_org and p.is_default and p.deleted_at is null limit 1));
$$;

-- ----------------------------------------------------------------------------
-- 1. Leads by source (and campaign): count, converted, won deals, revenue
-- ----------------------------------------------------------------------------
create or replace function public.report_leads_by_source(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.leads desc), '[]'::jsonb)
    from (
      select l.source_id, s.name as source_name, nullif(btrim(l.campaign), '') as campaign,
             count(*) as leads,
             count(l.converted_at) as converted,
             count(d.id) filter (where d.status = 'won') as won,
             coalesce(sum(d.amount_agorot) filter (where d.status = 'won'), 0) as revenue
        from public.leads l
        left join public.lead_sources s on s.organization_id = l.organization_id and s.id = l.source_id
        left join public.deals d on d.organization_id = l.organization_id and d.id = l.converted_deal_id
                                and d.deleted_at is null
       where l.organization_id = p_org and l.deleted_at is null
         and l.created_at >= p_from and l.created_at < p_to
         and (p_owner is null or l.owner_id = p_owner)
       group by l.source_id, s.name, nullif(btrim(l.campaign), '')
    ) r;
$$;

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

-- ----------------------------------------------------------------------------
-- 5. Activity: what each person logged, tasks completed, and a daily series
-- ----------------------------------------------------------------------------
create or replace function public.report_activity(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with tz as (
    select coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem') as name
  ), acts as (
    select a.created_by as user_id, a.type, (a.occurred_at at time zone (select name from tz))::date as day
      from public.activities a
     where a.organization_id = p_org and a.created_by is not null and a.type = any (app.contact_types())
       and a.occurred_at >= p_from and a.occurred_at < p_to
       and (p_owner is null or a.created_by = p_owner)
  ), done as (
    select t.owner_id as user_id, (t.completed_at at time zone (select name from tz))::date as day
      from public.tasks t
     where t.organization_id = p_org and t.deleted_at is null and t.status = 'done'
       and t.completed_at >= p_from and t.completed_at < p_to
       and (p_owner is null or t.owner_id = p_owner)
  ), users as (
    select user_id from acts union select user_id from done
  ), days as (
    select day from acts union select day from done
  )
  select jsonb_build_object(
    'by_user', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', u.user_id,
               'note', (select count(*) from acts a where a.user_id = u.user_id and a.type = 'note'),
               'call', (select count(*) from acts a where a.user_id = u.user_id and a.type = 'call'),
               'meeting', (select count(*) from acts a where a.user_id = u.user_id and a.type = 'meeting'),
               'messages', (select count(*) from acts a where a.user_id = u.user_id and a.type in ('email', 'whatsapp', 'sms')),
               'tasks_done', (select count(*) from done t where t.user_id = u.user_id)))
        from users u where u.user_id is not null), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', d.day,
               'activities', (select count(*) from acts a where a.day = d.day),
               'tasks_done', (select count(*) from done t where t.day = d.day))
             order by d.day)
        from days d), '[]'::jsonb));
$$;

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

-- ----------------------------------------------------------------------------
-- 9. Stuck deals: open deals idle too long, or with no next step (open task)
-- ----------------------------------------------------------------------------
create or replace function public.report_stuck_deals(
  p_org uuid, p_pipeline uuid default null, p_owner uuid default null, p_days integer default 14)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.idle_days desc, r.amount_agorot desc), '[]'::jsonb)
    from (
      select x.*, (x.idle_days >= x.limit_days) as idle,
             (x.next_task_at is null) as no_next_step
        from (
          select d.id, d.name, d.amount_agorot, d.owner_id, d.pipeline_id, s.name as stage_name,
                 coalesce(s.rot_days, greatest(coalesce(p_days, 14), 1)) as limit_days,
                 floor(extract(epoch from now() - d.stage_entered_at) / 86400)::int as days_in_stage,
                 la.last_at as last_activity_at,
                 floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400)::int as idle_days,
                 (select min(coalesce(t.due_at, t.created_at)) from public.tasks t
                   where t.organization_id = d.organization_id and t.deal_id = d.id
                     and t.status = 'open' and t.deleted_at is null) as next_task_at
            from public.deals d
            join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
            left join lateral (
              select max(a.occurred_at) as last_at from public.activities a
               where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null
            ) la on true
           where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
             and (p_pipeline is null or d.pipeline_id = p_pipeline)
             and (p_owner is null or d.owner_id = p_owner)
        ) x
       where x.idle_days >= x.limit_days or x.next_task_at is null
       order by x.idle_days desc
       limit 200
    ) r;
$$;

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

revoke all on function public.report_leads_by_source(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_funnel(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_response_time(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_rep_performance(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_activity(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_forecast(uuid, uuid, uuid) from public, anon;
revoke all on function public.report_lost_reasons(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_cycle_length(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_stuck_deals(uuid, uuid, uuid, integer) from public, anon;
revoke all on function public.report_revenue(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_summary(uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid) from public, anon;

grant execute on function public.report_leads_by_source(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_funnel(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_response_time(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_rep_performance(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_activity(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_forecast(uuid, uuid, uuid) to authenticated;
grant execute on function public.report_lost_reasons(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_cycle_length(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_stuck_deals(uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.report_revenue(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_summary(uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid) to authenticated;
