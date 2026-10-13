-- =============================================================================
-- Activation metric (GAP-06)
-- =============================================================================
-- Until now nothing told the platform team whether a business that signed up
-- started to work. An organization is "activated" the first time a real lead of
-- it got an answer within 24 hours. This is the first piece of the health score
-- (TRU-05) and the "time to first value" number of additions spec 20.2.
--
-- What counts (the same "contact" as app.stamp_last_contact(), LEAD-02):
-- * a timeline entry with created_by set (logged by a person, not by the
--   system), type = any (app.contact_types()), not private (GAP-05), linked to a
--   lead of the same organization, and not planned (occurred_at not more than
--   5 minutes ahead of now());
-- * on a real lead: import_job_id is null (not imported) and not in the recycle
--   bin. Form, manual and API leads count. Sample data (USR-04) has no marker on
--   leads yet; when it gets one, this check must learn it;
-- * within 24 hours: least(occurred_at, now()) <= lead.created_at + 24 hours.
--   An entry logged later but dated inside the 24 hours counts, like the reports
--   (report_response_time) count it.
-- The moment kept is the contact time, never earlier than the lead itself:
-- greatest(least(occurred_at, now()), lead.created_at). A lead's created_at can
-- be sent by the client on insert, so it is read as least(created_at, now()).
--
-- Storage: app.org_activation, one row per organization, written once by the
-- trigger activities_activation (insert ... on conflict do nothing) and never
-- changed or cleared afterwards, even if the entry or the lead is deleted later.
-- Schema app: no API access at all (RVW-15: RLS on, no policies, no grants).
-- Only counts and times are kept, no customer data (no lead id, no text).
-- The platform panel reads it through platform_list_orgs(), platform_org() and
-- platform_metrics(), redefined here from their only version (0013) with the
-- activation added and nothing else changed.
--
-- One-time fill: organizations that already reached this point get their row
-- from the existing timeline, by the same rules (earliest qualifying contact).
-- It only inserts rows into the new table; no existing row of any table is
-- changed. Every statement is safe to run twice.

create table if not exists app.org_activation (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  -- the moment the first real lead got its answer
  activated_at    timestamptz not null,
  -- when that lead arrived (so the panel can show how fast the answer was)
  lead_created_at timestamptz not null,
  recorded_at     timestamptz not null default now()
);

-- RVW-15: every app table has RLS on (no policies, not forced); clients have no grants
alter table app.org_activation enable row level security;
revoke all on app.org_activation from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The trigger: the first qualifying contact marks the organization, once
-- ----------------------------------------------------------------------------
create or replace function app.mark_org_activation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead_created timestamptz;
  v_at timestamptz;
begin
  if new.lead_id is null
     or new.created_by is null
     or new.is_private is true
     or not (new.type = any (app.contact_types()))
     or new.occurred_at > now() + interval '5 minutes' then
    return null;
  end if;
  if exists (select 1 from app.org_activation a where a.organization_id = new.organization_id) then
    return null;
  end if;

  -- created_at can be sent by the client on insert: never later than now
  select least(l.created_at, now()) into v_lead_created
    from public.leads l
   where l.organization_id = new.organization_id
     and l.id = new.lead_id
     and l.import_job_id is null
     and l.deleted_at is null;
  if v_lead_created is null then
    return null;
  end if;

  v_at := greatest(least(new.occurred_at, now()), v_lead_created);
  if v_at > v_lead_created + interval '24 hours' then
    return null;
  end if;

  insert into app.org_activation (organization_id, activated_at, lead_created_at)
  values (new.organization_id, v_at, v_lead_created)
  on conflict (organization_id) do nothing;
  return null;
end;
$$;
revoke all on function app.mark_org_activation() from public, anon, authenticated;

-- same columns as activities_last_contact: a note made public, or an entry moved
-- to a lead, counts from then
create or replace trigger activities_activation
  after insert or update of occurred_at, type, created_by, lead_id, is_private on public.activities
  for each row execute function app.mark_org_activation();

-- ----------------------------------------------------------------------------
-- One-time fill from the existing timeline (insert only)
-- ----------------------------------------------------------------------------
insert into app.org_activation (organization_id, activated_at, lead_created_at)
select distinct on (x.organization_id) x.organization_id, x.v_at, x.lead_created_at
  from (
    select a.organization_id,
           greatest(least(a.occurred_at, now()), least(l.created_at, now())) as v_at,
           least(l.created_at, now()) as lead_created_at
      from public.activities a
      join public.leads l on l.organization_id = a.organization_id and l.id = a.lead_id
     where a.created_by is not null
       and a.type = any (app.contact_types())
       and a.is_private is not true
       and a.occurred_at <= now() + interval '5 minutes'
       and l.import_job_id is null
       and l.deleted_at is null
  ) x
 where x.v_at <= x.lead_created_at + interval '24 hours'
 order by x.organization_id, x.v_at, x.lead_created_at
on conflict (organization_id) do nothing;

-- ----------------------------------------------------------------------------
-- Platform panel: the three read functions of 0013, plus the activation
-- ----------------------------------------------------------------------------
create or replace function public.platform_list_orgs(
  p_search text default null, p_status text default null, p_plan text default null,
  p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  with base as (
    select o.id, o.name, o.slug, o.status::text as status, o.created_at, o.deleted_at,
           s.plan_key, s.status::text as subscription_status, s.seats, s.trial_ends_at,
           (select count(*) from public.memberships m where m.organization_id = o.id and m.status = 'active') as members,
           coalesce(u.records_count, 0) as records,
           (select au.email from public.memberships m join auth.users au on au.id = m.user_id
             where m.organization_id = o.id and m.role = 'owner' limit 1) as owner_email,
           act.activated_at
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.org_usage u on u.organization_id = o.id
      left join app.org_activation act on act.organization_id = o.id
  ), filtered as (
    select * from base b
     where (p_status is null or b.status = p_status)
       and (p_plan is null or b.plan_key = p_plan)
       and (p_search is null or b.name ilike '%' || p_search || '%' or b.slug ilike '%' || p_search || '%'
            or b.owner_email ilike '%' || p_search || '%')
  )
  select jsonb_build_object(
           'total', (select count(*) from filtered),
           'rows', coalesce((select jsonb_agg(f order by f.created_at desc)
                               from (select * from filtered order by created_at desc
                                     limit least(greatest(coalesce(p_limit, 50), 1), 200)
                                     offset greatest(coalesce(p_offset, 0), 0)) f), '[]'::jsonb))
    into v_result;
  return v_result;
end;
$$;

create or replace function public.platform_org(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return (
    select jsonb_build_object(
      'org', jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status, 'industry', o.industry,
                                'team_size', o.team_size, 'created_at', o.created_at, 'deleted_at', o.deleted_at),
      'subscription', to_jsonb(s) - 'provider_customer_ref' - 'provider_subscription_ref',
      'plan', jsonb_build_object('name_he', p.name_he, 'limits', p.limits, 'features', p.features),
      'records', coalesce((select u.records_count from public.org_usage u where u.organization_id = o.id), 0),
      'members', (select jsonb_object_agg(r.role, r.n) from (
                    select m.role::text as role, count(*) as n from public.memberships m
                     where m.organization_id = o.id and m.status = 'active' group by m.role) r),
      'owner', (select jsonb_build_object('email', au.email, 'name', pr.full_name, 'last_sign_in_at', au.last_sign_in_at)
                  from public.memberships m join auth.users au on au.id = m.user_id
                  left join public.profiles pr on pr.id = m.user_id
                 where m.organization_id = o.id and m.role = 'owner' limit 1),
      'last_sign_in_at', (select max(au.last_sign_in_at) from public.memberships m join auth.users au on au.id = m.user_id
                           where m.organization_id = o.id),
      'counts', jsonb_build_object(
        'automations', (select count(*) from public.automations a where a.organization_id = o.id and a.is_active),
        'forms', (select count(*) from public.forms f where f.organization_id = o.id),
        'pipelines', (select count(*) from public.pipelines pl where pl.organization_id = o.id and pl.deleted_at is null)),
      'support_until', (select max(g.expires_at) from public.support_access_grants g
                         where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now()),
      -- GAP-06: null until the first real lead got an answer within 24 hours
      'activation', (select jsonb_build_object('activated_at', act.activated_at, 'lead_created_at', act.lead_created_at)
                       from app.org_activation act where act.organization_id = o.id))
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.plans p on p.key = s.plan_key
     where o.id = p_org);
end;
$$;

create or replace function public.platform_metrics() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_mrr bigint;
  v_paying integer;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  -- monthly recurring revenue before VAT: active, paid plans; annual prices are per month already
  select coalesce(sum(case when s.billing_cycle = 'annual' then p.price_annual_agorot else p.price_monthly_agorot end
                      * coalesce(s.seats, 1)), 0),
         count(*)
    into v_mrr, v_paying
    from public.subscriptions s
    join public.plans p on p.key = s.plan_key
    join public.organizations o on o.id = s.organization_id
   where s.status = 'active' and o.status in ('active', 'past_due') and o.deleted_at is null
     and p.price_monthly_agorot > 0;
  return jsonb_build_object(
    'mrr_agorot', v_mrr,
    'paying_orgs', v_paying,
    'arpa_agorot', case when v_paying > 0 then v_mrr / v_paying end,
    'orgs_total', (select count(*) from public.organizations o where o.deleted_at is null),
    'by_status', (select jsonb_object_agg(x.status, x.n) from (
                    select o.status::text as status, count(*) as n from public.organizations o
                     where o.deleted_at is null group by o.status) x),
    'by_plan', (select jsonb_object_agg(x.plan_key, x.n) from (
                  select s.plan_key, count(*) as n from public.subscriptions s
                  join public.organizations o on o.id = s.organization_id and o.deleted_at is null
                  group by s.plan_key) x),
    'new_by_month', (select jsonb_agg(x order by x.month) from (
                       select to_char(date_trunc('month', o.created_at), 'YYYY-MM') as month, count(*) as n
                         from public.organizations o
                        where o.created_at > date_trunc('month', now()) - interval '11 months'
                        group by 1) x),
    -- of the organizations whose trial is over, how many pay
    'trial_conversion', (select jsonb_build_object('ended', count(*), 'paying', count(*) filter (where s.status = 'active' and p.price_monthly_agorot > 0))
                           from public.subscriptions s join public.plans p on p.key = s.plan_key
                          where s.trial_ends_at < now()),
    'cancelled_30d', (select count(*) from public.organizations o where o.status = 'cancelled' and o.updated_at > now() - interval '30 days'),
    'users_total', (select count(*) from auth.users),
    'active_users_1d', (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '1 day'),
    'active_users_30d', (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '30 days'),
    'quiet_orgs', (select count(*) from public.organizations o
                    where o.deleted_at is null and o.status in ('trial', 'active', 'past_due')
                      and not exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id
                                       where m.organization_id = o.id and u.last_sign_in_at > now() - interval '14 days')),
    -- GAP-06: organizations (not deleted) whose first real lead got an answer within 24 hours,
    -- and the median time from sign-up to that moment
    'activation', (select jsonb_build_object(
                            'activated', count(*),
                            'median_hours', round((percentile_cont(0.5) within group (
                                              order by extract(epoch from greatest(act.activated_at - o.created_at, interval '0')) / 3600))::numeric, 1))
                     from app.org_activation act
                     join public.organizations o on o.id = act.organization_id
                    where o.deleted_at is null),
    'health', jsonb_build_object(
      'outbox_backlog', (select count(*) from public.outbox_events e where e.processed_at is null),
      'automation_failures_24h', (select count(*) from public.automation_runs r where r.status = 'failed' and r.created_at > now() - interval '1 day'),
      'push_pending', (select count(*) from public.notifications n where n.pushed_at is null and n.created_at > now() - interval '1 hour')));
end;
$$;

revoke all on function public.platform_list_orgs(text, text, text, integer, integer) from public, anon;
revoke all on function public.platform_org(uuid) from public, anon;
revoke all on function public.platform_metrics() from public, anon;
grant execute on function public.platform_list_orgs(text, text, text, integer, integer) to authenticated;
grant execute on function public.platform_org(uuid) to authenticated;
grant execute on function public.platform_metrics() to authenticated;
