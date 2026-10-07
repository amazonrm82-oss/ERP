-- =============================================================================
-- 0013 Platform admin (the product owner's panel) and customer-approved support access
-- =============================================================================
-- * app.platform_staff: who works on the platform, with a platform role
--   (owner | support | finance | readonly). Not exposed by the API; the first
--   owner is added by hand in the SQL Editor.
-- * Every platform function demands a second factor: the session's JWT must say
--   aal = 'aal2' (Supabase MFA). A stolen password alone opens nothing.
-- * app.platform_log: every platform action. Append-only, even for the database
--   owner (a trigger refuses UPDATE and DELETE).
-- * Platform staff see account and usage data only. Customer data is visible
--   only while the customer has granted support access (support_access_grants),
--   and then read-only: app.role_in() gives them the 'viewer' role.
-- Every statement is safe to run twice.

create table if not exists app.platform_staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'support', 'finance', 'readonly')),
  created_by uuid,
  created_at timestamptz not null default now()
);
revoke all on app.platform_staff from public, anon, authenticated;

create table if not exists app.platform_log (
  id              bigint generated always as identity primary key,
  actor_id        uuid,
  action          text not null,
  organization_id uuid,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists platform_log_org_idx on app.platform_log (organization_id, created_at desc);
revoke all on app.platform_log from public, anon, authenticated;

create or replace function app.platform_log_is_permanent() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'the platform log cannot be changed' using errcode = '42501';
end;
$$;

create or replace trigger platform_log_permanent before update or delete on app.platform_log
  for each row execute function app.platform_log_is_permanent();

-- platform role of the caller, only with a second factor in this session
create or replace function app.platform_role() returns text
language sql stable security definer
set search_path = ''
as $$
  select s.role from app.platform_staff s
   where s.user_id = auth.uid()
     and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') = 'aal2';
$$;

-- raises unless the caller has one of the roles (owner always passes)
create or replace function app.require_platform(p_roles text[]) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role text := app.platform_role();
begin
  if v_role is null or not (v_role = 'owner' or v_role = any (p_roles)) then
    raise exception 'platform access denied' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

create or replace function app.log_platform(p_action text, p_org uuid, p_details jsonb) returns void
language sql security definer
set search_path = ''
as $$
  insert into app.platform_log (actor_id, action, organization_id, details)
  values (auth.uid(), p_action, p_org, coalesce(p_details, '{}'::jsonb));
$$;

-- ----------------------------------------------------------------------------
-- Support access: the customer (owner or admin) lets platform support in, for a while
-- ----------------------------------------------------------------------------
create table if not exists public.support_access_grants (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  granted_by      uuid default auth.uid() references auth.users (id) on delete set null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);
create index if not exists support_access_grants_org_idx on public.support_access_grants (organization_id, expires_at desc);

alter table public.support_access_grants enable row level security;
revoke all on public.support_access_grants from anon, authenticated;
grant all on public.support_access_grants to service_role;
grant select on public.support_access_grants to authenticated;
grant insert (organization_id, expires_at) on public.support_access_grants to authenticated;
grant update (revoked_at) on public.support_access_grants to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'support_access_grants' and policyname = 'support_access_grants_select') then
    create policy support_access_grants_select on public.support_access_grants for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'support_access_grants' and policyname = 'support_access_grants_insert') then
    create policy support_access_grants_insert on public.support_access_grants for insert to authenticated
      with check (app.is_admin(organization_id) and granted_by = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'support_access_grants' and policyname = 'support_access_grants_update') then
    create policy support_access_grants_update on public.support_access_grants for update to authenticated
      using (app.is_admin(organization_id)) with check (app.is_admin(organization_id));
  end if;
end;
$$;

create or replace trigger support_access_grants_touch before insert or update on public.support_access_grants
  for each row execute function app.touch_row();
create or replace trigger support_access_grants_audit after insert or update on public.support_access_grants
  for each row execute function app.audit_row();

-- true while the caller is platform support (with a second factor) and the
-- organization has an open grant
create or replace function app.support_session(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.platform_role() in ('owner', 'support'), false)
     and exists (select 1 from public.support_access_grants g
                  where g.organization_id = p_org and g.revoked_at is null and g.expires_at > now());
$$;

-- the membership role only (no support session)
create or replace function app.membership_role(p_org uuid) returns public.membership_role
language sql stable security definer
set search_path = ''
as $$
  select m.role from public.memberships m
   where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active';
$$;

-- Same as in 0001, plus: platform support in an open support session is a viewer.
-- coalesce stops at the first non-null, so members never pay for the second lookup.
create or replace function app.role_in(p_org uuid) returns public.membership_role
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.membership_role(p_org),
                  case when app.support_session(p_org) then 'viewer'::public.membership_role end);
$$;

-- Same as in 0001, plus: a support session reads every record of the organization
-- (support has to see what the customer sees), but never edits (role 'viewer').
create or replace function app.can_read_record(p_org uuid, p_owner uuid, p_team uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.membership_role(p_org);
  v_visibility public.record_visibility;
begin
  if v_role is null then
    return app.support_session(p_org);
  end if;
  if v_role in ('owner', 'admin') then
    return true;
  end if;
  if p_owner is not null and p_owner = auth.uid() then
    return true;
  end if;

  select o.record_visibility into v_visibility
  from public.organizations o where o.id = p_org;

  if v_visibility = 'org' then
    return true;
  end if;
  if p_team is null then
    return false;
  end if;
  if v_visibility = 'team' and app.in_team(p_team) then
    return true;
  end if;
  if v_role = 'manager' and app.manages_team(p_team) then
    return true;
  end if;
  return false;
end;
$$;

-- The app asks this when the user is not a member: is it an open support session?
create or replace function public.support_session_info(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not app.support_session(p_org) then
    return null;
  end if;
  return jsonb_build_object('expires_at', (
    select max(g.expires_at) from public.support_access_grants g
     where g.organization_id = p_org and g.revoked_at is null and g.expires_at > now()));
end;
$$;

-- ----------------------------------------------------------------------------
-- Platform functions. Each one checks the platform role (with aal2) first.
-- ----------------------------------------------------------------------------

-- who am I on the platform: null for customers; needs_mfa until the second factor
create or replace function public.platform_me() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'role', s.role,
           'needs_mfa', coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') <> 'aal2')
    from app.platform_staff s where s.user_id = auth.uid();
$$;

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
             where m.organization_id = o.id and m.role = 'owner' limit 1) as owner_email
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.org_usage u on u.organization_id = o.id
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

-- account and usage data of one organization (no customer records)
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
                         where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now()))
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.plans p on p.key = s.plan_key
     where o.id = p_org);
end;
$$;

-- plan, seats and trial end of one organization (finance)
create or replace function public.platform_update_subscription(
  p_org uuid, p_plan_key text, p_seats integer, p_trial_ends_at timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
begin
  perform app.require_platform(array['finance']);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.plans p where p.key = p_plan_key) then
    raise exception 'unknown plan' using errcode = '22023';
  end if;
  select jsonb_build_object('plan_key', s.plan_key, 'seats', s.seats, 'trial_ends_at', s.trial_ends_at)
    into v_old from public.subscriptions s where s.organization_id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  update public.subscriptions
     set plan_key = p_plan_key, seats = p_seats, trial_ends_at = p_trial_ends_at, updated_at = now()
   where organization_id = p_org;
  perform app.log_platform('subscription.update', p_org, jsonb_build_object(
    'old', v_old, 'new', jsonb_build_object('plan_key', p_plan_key, 'seats', p_seats, 'trial_ends_at', p_trial_ends_at),
    'reason', left(p_reason, 500)));
end;
$$;

-- per-organization limit and feature overrides (owner only). {} clears them.
create or replace function public.platform_set_overrides(p_org uuid, p_limits jsonb, p_features jsonb, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_key text;
  v_old jsonb;
begin
  perform app.require_platform(array[]::text[]);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_limits, '{}')) <> 'object' or jsonb_typeof(coalesce(p_features, '{}')) <> 'object' then
    raise exception 'overrides must be objects' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(coalesce(p_limits, '{}')) loop
    if jsonb_typeof(p_limits -> v_key) not in ('number', 'null') then
      raise exception 'limit % must be a number or null', v_key using errcode = '22023';
    end if;
  end loop;
  for v_key in select jsonb_object_keys(coalesce(p_features, '{}')) loop
    if jsonb_typeof(p_features -> v_key) <> 'boolean' then
      raise exception 'feature % must be true or false', v_key using errcode = '22023';
    end if;
  end loop;
  select jsonb_build_object('limits', s.limit_overrides, 'features', s.feature_overrides)
    into v_old from public.subscriptions s where s.organization_id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  update public.subscriptions
     set limit_overrides = coalesce(p_limits, '{}'), feature_overrides = coalesce(p_features, '{}'), updated_at = now()
   where organization_id = p_org;
  perform app.log_platform('subscription.overrides', p_org, jsonb_build_object(
    'old', v_old, 'new', jsonb_build_object('limits', p_limits, 'features', p_features), 'reason', left(p_reason, 500)));
end;
$$;

-- suspend, restore, make read-only... (owner only)
create or replace function public.platform_set_org_status(p_org uuid, p_status public.org_status, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.org_status;
begin
  perform app.require_platform(array[]::text[]);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select o.status into v_old from public.organizations o where o.id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  update public.organizations set status = p_status where id = p_org;
  perform app.log_platform('organization.status', p_org,
    jsonb_build_object('old', v_old, 'new', p_status, 'reason', left(p_reason, 500)));
end;
$$;

-- edit a plan without a deploy (owner only)
create or replace function public.platform_update_plan(
  p_key text, p_name_he text, p_price_monthly_agorot integer, p_price_annual_agorot integer,
  p_limits jsonb, p_features jsonb, p_is_public boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
begin
  perform app.require_platform(array[]::text[]);
  if coalesce(btrim(p_name_he), '') = '' or p_price_monthly_agorot < 0 or p_price_annual_agorot < 0
     or jsonb_typeof(p_limits) <> 'object' or jsonb_typeof(p_features) <> 'object' then
    raise exception 'invalid plan' using errcode = '22023';
  end if;
  select to_jsonb(p) into v_old from public.plans p where p.key = p_key;
  if v_old is null then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
  update public.plans
     set name_he = btrim(p_name_he), price_monthly_agorot = p_price_monthly_agorot, price_annual_agorot = p_price_annual_agorot,
         limits = p_limits, features = p_features, is_public = coalesce(p_is_public, true)
   where key = p_key;
  perform app.log_platform('plan.update', null, jsonb_build_object('key', p_key, 'old', v_old));
end;
$$;

-- business and usage numbers (any platform role)
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
    'health', jsonb_build_object(
      'outbox_backlog', (select count(*) from public.outbox_events e where e.processed_at is null),
      'automation_failures_24h', (select count(*) from public.automation_runs r where r.status = 'failed' and r.created_at > now() - interval '1 day'),
      'push_pending', (select count(*) from public.notifications n where n.pushed_at is null and n.created_at > now() - interval '1 hour')));
end;
$$;

-- the internal team (owner only)
create or replace function public.platform_staff_list() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array[]::text[]);
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'role', s.role, 'email', u.email,
                                                       'name', p.full_name, 'created_at', s.created_at) order by s.created_at)
                     from app.platform_staff s join auth.users u on u.id = s.user_id
                     left join public.profiles p on p.id = s.user_id), '[]'::jsonb);
end;
$$;

-- add or change a team member by email; role null removes them. The last owner cannot leave.
create or replace function public.platform_set_staff(p_email text, p_role text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  perform app.require_platform(array[]::text[]);
  if p_role is not null and p_role not in ('owner', 'support', 'finance', 'readonly') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'no user with this email; they must sign up first' using errcode = 'P0002';
  end if;
  if (p_role is null or p_role <> 'owner')
     and exists (select 1 from app.platform_staff s where s.user_id = v_user and s.role = 'owner')
     and (select count(*) from app.platform_staff s where s.role = 'owner') = 1 then
    raise exception 'the last platform owner cannot be removed' using errcode = 'P0001', hint = 'platform:last_owner';
  end if;
  if p_role is null then
    delete from app.platform_staff where user_id = v_user;
  else
    insert into app.platform_staff (user_id, role, created_by) values (v_user, p_role, auth.uid())
    on conflict (user_id) do update set role = excluded.role;
  end if;
  perform app.log_platform('staff.set', null, jsonb_build_object('email', lower(btrim(p_email)), 'role', p_role));
end;
$$;

create or replace function public.platform_log_list(p_org uuid default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return coalesce((
    select jsonb_agg(x order by x.id desc) from (
      select l.id, l.action, l.organization_id, o.name as organization_name, l.details, l.created_at, u.email as actor_email
        from app.platform_log l
        left join auth.users u on u.id = l.actor_id
        left join public.organizations o on o.id = l.organization_id
       where p_org is null or l.organization_id = p_org
       order by l.id desc
       limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end;
$$;

-- support opens a customer's organization: logged on the platform and in the customer's own audit log
create or replace function public.platform_open_support(p_org uuid) returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  perform app.require_platform(array['support']);
  select max(g.expires_at) into v_until from public.support_access_grants g
   where g.organization_id = p_org and g.revoked_at is null and g.expires_at > now();
  if v_until is null then
    raise exception 'the customer has not granted support access' using errcode = '42501', hint = 'platform:no_grant';
  end if;
  perform app.log_platform('support.open', p_org, jsonb_build_object('until', v_until));
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'support_open', 'organizations', p_org, jsonb_build_object('until', v_until));
  return v_until;
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
revoke all on function app.platform_log_is_permanent() from public, anon, authenticated;
revoke all on function app.platform_role() from public, anon;
revoke all on function app.require_platform(text[]) from public, anon, authenticated;
revoke all on function app.log_platform(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.support_session(uuid) from public, anon;
revoke all on function app.membership_role(uuid) from public, anon;
grant execute on function app.platform_role() to authenticated, service_role;
grant execute on function app.support_session(uuid) to authenticated, service_role;
grant execute on function app.membership_role(uuid) to authenticated, service_role;

revoke all on function public.support_session_info(uuid) from public, anon;
revoke all on function public.platform_me() from public, anon;
revoke all on function public.platform_list_orgs(text, text, text, integer, integer) from public, anon;
revoke all on function public.platform_org(uuid) from public, anon;
revoke all on function public.platform_update_subscription(uuid, text, integer, timestamptz, text) from public, anon;
revoke all on function public.platform_set_overrides(uuid, jsonb, jsonb, text) from public, anon;
revoke all on function public.platform_set_org_status(uuid, public.org_status, text) from public, anon;
revoke all on function public.platform_update_plan(text, text, integer, integer, jsonb, jsonb, boolean) from public, anon;
revoke all on function public.platform_metrics() from public, anon;
revoke all on function public.platform_staff_list() from public, anon;
revoke all on function public.platform_set_staff(text, text) from public, anon;
revoke all on function public.platform_log_list(uuid, integer) from public, anon;
revoke all on function public.platform_open_support(uuid) from public, anon;

grant execute on function public.support_session_info(uuid) to authenticated;
grant execute on function public.platform_me() to authenticated;
grant execute on function public.platform_list_orgs(text, text, text, integer, integer) to authenticated;
grant execute on function public.platform_org(uuid) to authenticated;
grant execute on function public.platform_update_subscription(uuid, text, integer, timestamptz, text) to authenticated;
grant execute on function public.platform_set_overrides(uuid, jsonb, jsonb, text) to authenticated;
grant execute on function public.platform_set_org_status(uuid, public.org_status, text) to authenticated;
grant execute on function public.platform_update_plan(text, text, integer, integer, jsonb, jsonb, boolean) to authenticated;
grant execute on function public.platform_metrics() to authenticated;
grant execute on function public.platform_staff_list() to authenticated;
grant execute on function public.platform_set_staff(text, text) to authenticated;
grant execute on function public.platform_log_list(uuid, integer) to authenticated;
grant execute on function public.platform_open_support(uuid) to authenticated;
