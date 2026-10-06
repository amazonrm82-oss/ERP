-- =============================================================================
-- 0001 foundation: tenants (organizations), users, memberships, teams, plans
-- =============================================================================
-- Tenancy model: one shared database, every business row carries
-- organization_id, and isolation is enforced by Row Level Security.
-- Helper functions live in the private schema `app`, which is NOT exposed
-- through the Supabase API. Only functions in `public` are callable as RPC.

create extension if not exists pg_trgm with schema extensions;

create schema if not exists app;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type public.membership_role as enum ('owner', 'admin', 'manager', 'member', 'viewer');
create type public.membership_status as enum ('active', 'suspended');
create type public.seat_type as enum ('full', 'view');
create type public.org_status as enum ('trial', 'active', 'past_due', 'read_only', 'suspended', 'cancelled');
create type public.record_visibility as enum ('org', 'team', 'own');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled');
create type public.billing_cycle as enum ('monthly', 'annual');

-- ----------------------------------------------------------------------------
-- Plans (reference data, same for every tenant)
-- ----------------------------------------------------------------------------
create table public.plans (
  key                  text primary key,
  name_he              text not null,
  name_en              text not null,
  -- price per seat per month, in agorot, before VAT
  price_monthly_agorot integer not null check (price_monthly_agorot >= 0),
  price_annual_agorot  integer not null check (price_annual_agorot >= 0),
  -- numeric limits; a missing key or JSON null means "unlimited"
  limits               jsonb not null default '{}'::jsonb,
  -- boolean feature flags
  features             jsonb not null default '{}'::jsonb,
  is_public            boolean not null default true,
  position             integer not null default 0
);

insert into public.plans (key, name_he, name_en, price_monthly_agorot, price_annual_agorot, position, limits, features) values
  ('free', 'חינם', 'Free', 0, 0, 0,
    '{"max_users": 2, "max_records": 1000, "max_pipelines": 1, "max_custom_fields_per_object": 10, "max_active_automations": 3, "max_automation_runs_per_month": 500, "max_forms": 1, "storage_gb": 1, "audit_log_days": 7, "ai_credits_per_month": 50}',
    '{"email_sync": false, "whatsapp_inbox": false, "telephony": false, "quotes": false, "custom_reports": false, "custom_roles": false, "view_seats": false, "custom_objects": false, "api": false, "field_permissions": false, "sso": false}'),
  ('basic', 'בסיס', 'Basic', 6900, 5900, 1,
    '{"max_users": null, "max_records": 25000, "max_pipelines": 3, "max_custom_fields_per_object": 50, "max_active_automations": 20, "max_automation_runs_per_month": 5000, "max_forms": 5, "storage_gb": 10, "audit_log_days": 30, "ai_credits_per_user_per_month": 300}',
    '{"email_sync": true, "whatsapp_inbox": true, "telephony": false, "quotes": true, "custom_reports": true, "custom_roles": false, "view_seats": false, "custom_objects": false, "api": true, "field_permissions": false, "sso": false}'),
  ('pro', 'מקצועי', 'Pro', 13900, 11900, 2,
    '{"max_users": null, "max_records": 250000, "max_pipelines": 15, "max_custom_fields_per_object": 200, "max_active_automations": 100, "max_automation_runs_per_month": 50000, "max_forms": null, "storage_gb": 50, "audit_log_days": 365, "ai_credits_per_user_per_month": 1000}',
    '{"email_sync": true, "whatsapp_inbox": true, "telephony": true, "quotes": true, "custom_reports": true, "custom_roles": true, "view_seats": true, "custom_objects": true, "api": true, "field_permissions": false, "sso": false}'),
  ('business', 'עסקי', 'Business', 21900, 18900, 3,
    '{"max_users": null, "max_records": 1000000, "max_pipelines": null, "max_custom_fields_per_object": 500, "max_active_automations": 300, "max_automation_runs_per_month": 250000, "max_forms": null, "storage_gb": 200, "audit_log_days": 730, "ai_credits_per_user_per_month": 3000}',
    '{"email_sync": true, "whatsapp_inbox": true, "telephony": true, "quotes": true, "custom_reports": true, "custom_roles": true, "view_seats": true, "custom_objects": true, "api": true, "field_permissions": true, "sso": true}');

-- ----------------------------------------------------------------------------
-- Organizations (tenants)
-- ----------------------------------------------------------------------------
create table public.organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(btrim(name)) between 1 and 120),
  slug              text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  industry          text,
  team_size         text,
  phone             text,
  locale            text not null default 'he',
  timezone          text not null default 'Asia/Jerusalem',
  currency          char(3) not null default 'ILS',
  record_visibility public.record_visibility not null default 'org',
  status            public.org_status not null default 'trial',
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

-- ----------------------------------------------------------------------------
-- Profiles (one per auth user, global across organizations)
-- ----------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  phone      text,
  avatar_url text,
  locale     text not null default 'he',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Memberships (user <-> organization, carries role and seat)
-- ----------------------------------------------------------------------------
create table public.memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            public.membership_role not null default 'member',
  seat_type       public.seat_type not null default 'full',
  status          public.membership_status not null default 'active',
  -- false = skipped by automatic lead distribution (vacation, etc.)
  is_available    boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id),
  -- a viewer always sits on a view seat and nobody else does
  constraint memberships_viewer_seat check ((role = 'viewer') = (seat_type = 'view'))
);

create index memberships_user_idx on public.memberships (user_id);
-- exactly one owner per organization
create unique index memberships_one_owner_idx on public.memberships (organization_id) where role = 'owner';

-- ----------------------------------------------------------------------------
-- Teams
-- ----------------------------------------------------------------------------
create table public.teams (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  parent_team_id  uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, parent_team_id) references public.teams (organization_id, id) on delete set null (parent_team_id),
  constraint teams_not_own_parent check (parent_team_id is distinct from id)
);

create table public.team_members (
  organization_id uuid not null,
  team_id         uuid not null,
  user_id         uuid not null,
  is_manager      boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete cascade,
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);

create index team_members_user_idx on public.team_members (organization_id, user_id);

-- ----------------------------------------------------------------------------
-- Invitations
-- ----------------------------------------------------------------------------
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email           text not null check (email = lower(email) and email like '%_@_%'),
  role            public.membership_role not null default 'member' check (role <> 'owner'),
  -- only the SHA-256 of the token is stored; the raw token is shown once
  token_hash      text not null unique,
  invited_by      uuid references auth.users (id) on delete set null,
  expires_at      timestamptz not null default (now() + interval '7 days'),
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index invitations_org_idx on public.invitations (organization_id);

-- ----------------------------------------------------------------------------
-- Subscriptions (one per organization). Written only by the server.
-- ----------------------------------------------------------------------------
create table public.subscriptions (
  organization_id           uuid primary key references public.organizations (id) on delete cascade,
  plan_key                  text not null references public.plans (key),
  status                    public.subscription_status not null default 'trialing',
  billing_cycle             public.billing_cycle not null default 'monthly',
  -- purchased full seats; null = not limited by purchase (trial)
  seats                     integer check (seats is null or seats >= 1),
  trial_ends_at             timestamptz,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean not null default false,
  -- per-organization overrides of plan limits / features (set by platform staff)
  limit_overrides           jsonb not null default '{}'::jsonb,
  feature_overrides         jsonb not null default '{}'::jsonb,
  provider                  text,
  provider_customer_ref     text,
  provider_subscription_ref text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- live counters used to enforce plan limits without counting rows on every insert
create table public.org_usage (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  records_count   bigint not null default 0 check (records_count >= 0),
  updated_at      timestamptz not null default now()
);

-- =============================================================================
-- Helper functions (schema app). SECURITY DEFINER so that policies can look at
-- memberships without recursing into the memberships policies themselves.
-- =============================================================================

-- role of the current user in an organization, null when not an active member
create or replace function app.role_in(p_org uuid) returns public.membership_role
language sql stable security definer
set search_path = ''
as $$
  select m.role
  from public.memberships m
  where m.organization_id = p_org
    and m.user_id = auth.uid()
    and m.status = 'active'
$$;

create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app.role_in(p_org) is not null $$;

create or replace function app.is_admin(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select coalesce(app.role_in(p_org) in ('owner', 'admin'), false) $$;

-- false while the organization is read-only / suspended / cancelled / deleted
create or replace function app.org_writable(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org
      and o.deleted_at is null
      and o.status in ('trial', 'active', 'past_due')
  )
$$;

create or replace function app.org_exists(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select exists (select 1 from public.organizations o where o.id = p_org) $$;

-- true when the current user may create or change data at all in this org
create or replace function app.can_write(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org) in ('owner', 'admin', 'manager', 'member'), false)
     and app.org_writable(p_org)
$$;

create or replace function app.in_team(p_team uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team and tm.user_id = auth.uid()
  )
$$;

-- true when the current user is a manager of the team or of any ancestor team
create or replace function app.manages_team(p_team uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  with recursive chain as (
    select t.id, t.parent_team_id, 1 as depth
    from public.teams t where t.id = p_team
    union all
    select t.id, t.parent_team_id, c.depth + 1
    from public.teams t
    join chain c on t.id = c.parent_team_id
    where c.depth < 10
  )
  select exists (
    select 1
    from chain c
    join public.team_members tm on tm.team_id = c.id
    where tm.user_id = auth.uid() and tm.is_manager
  )
$$;

-- Record-level read access: (organization, owner, team) of the row.
create or replace function app.can_read_record(p_org uuid, p_owner uuid, p_team uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
  v_visibility public.record_visibility;
begin
  if v_role is null then
    return false;
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

-- Record-level edit access. Members edit what they own; managers edit their
-- teams' records; admins edit everything. Viewers never edit.
create or replace function app.can_edit_record(p_org uuid, p_owner uuid, p_team uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if v_role is null or v_role = 'viewer' or not app.org_writable(p_org) then
    return false;
  end if;
  if v_role in ('owner', 'admin') then
    return true;
  end if;
  if p_owner is not null and p_owner = auth.uid() then
    return true;
  end if;
  if v_role = 'manager' and p_team is not null and app.manages_team(p_team) then
    return true;
  end if;
  return false;
end;
$$;

-- Deleting (including moving to the recycle bin) is for admins and for
-- managers on their teams' records. Plain members cannot delete.
create or replace function app.can_delete_record(p_org uuid, p_owner uuid, p_team uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if v_role is null or not app.org_writable(p_org) then
    return false;
  end if;
  if v_role in ('owner', 'admin') then
    return true;
  end if;
  if v_role = 'manager' then
    if p_owner is not null and p_owner = auth.uid() then
      return true;
    end if;
    if p_team is not null and app.manages_team(p_team) then
      return true;
    end if;
  end if;
  return false;
end;
$$;

-- Effective numeric limit for an organization; null = unlimited.
create or replace function app.org_limit(p_org uuid, p_key text) returns numeric
language sql stable security definer
set search_path = ''
as $$
  select case
    when s.limit_overrides ? p_key then (s.limit_overrides ->> p_key)::numeric
    else (p.limits ->> p_key)::numeric
  end
  from public.subscriptions s
  join public.plans p on p.key = s.plan_key
  where s.organization_id = p_org
$$;

create or replace function app.org_has_feature(p_org uuid, p_key text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when s.feature_overrides ? p_key then (s.feature_overrides ->> p_key)::boolean
      else (p.features ->> p_key)::boolean
    end
    from public.subscriptions s
    join public.plans p on p.key = s.plan_key
    where s.organization_id = p_org
  ), false)
$$;

-- Israeli phone numbers to E.164. Returns null when the input has no digits.
create or replace function app.normalize_phone(p_phone text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_digits text;
  v_plus boolean;
begin
  if p_phone is null then
    return null;
  end if;
  v_plus := btrim(p_phone) like '+%';
  v_digits := regexp_replace(p_phone, '[^0-9]', '', 'g');
  if v_digits = '' then
    return null;
  end if;
  if v_plus then
    return '+' || v_digits;
  end if;
  if v_digits like '00%' then
    return '+' || substr(v_digits, 3);
  end if;
  if v_digits like '972%' and char_length(v_digits) between 11 and 12 then
    return '+' || v_digits;
  end if;
  if v_digits like '0%' and char_length(v_digits) between 9 and 10 then
    return '+972' || substr(v_digits, 2);
  end if;
  return '+' || v_digits;
end;
$$;

-- =============================================================================
-- Generic triggers
-- =============================================================================

-- Stamps created_by / updated_by / updated_at and makes organization_id immutable.
create or replace function app.touch_row() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
begin
  -- Column references are nested under the `?` checks on purpose: PL/pgSQL
  -- raises on new.<column> when the table has no such column.
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      -- a signed-in user cannot claim that someone else created the row
      if v_new ? 'created_by' then
        new.created_by := auth.uid();
      end if;
      if v_new ? 'updated_by' then
        new.updated_by := auth.uid();
      end if;
    end if;
    return new;
  end if;

  if v_new ? 'organization_id' then
    if new.organization_id is distinct from old.organization_id then
      raise exception 'organization_id cannot be changed' using errcode = '42501';
    end if;
  end if;
  if v_new ? 'created_by' then
    new.created_by := old.created_by;
  end if;
  if v_new ? 'created_at' then
    new.created_at := old.created_at;
  end if;
  if v_new ? 'updated_by' then
    new.updated_by := coalesce(auth.uid(), old.updated_by);
  end if;
  if v_new ? 'updated_at' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_row();
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_row();
create trigger memberships_touch before update on public.memberships
  for each row execute function app.touch_row();
create trigger teams_touch before update on public.teams
  for each row execute function app.touch_row();
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function app.touch_row();

-- A profile row for every new auth user.
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- Seat check, separate and SECURITY DEFINER because it must lock and read
-- rows the calling user may not be allowed to touch.
create or replace function app.assert_seat_available(p_org uuid, p_membership uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_max_users numeric;
  v_seats integer;
  v_used integer;
begin
  -- serialize seat changes per organization
  perform 1 from public.subscriptions s where s.organization_id = p_org for update;
  select app.org_limit(p_org, 'max_users'), s.seats
    into v_max_users, v_seats
    from public.subscriptions s where s.organization_id = p_org;
  select count(*) into v_used
    from public.memberships m
    where m.organization_id = p_org
      and m.status = 'active' and m.seat_type = 'full'
      and m.id <> p_membership;
  if v_max_users is not null and v_used + 1 > v_max_users then
    raise exception 'plan user limit reached (%)', v_max_users using errcode = 'P0001', hint = 'limit:max_users';
  end if;
  if v_seats is not null and v_used + 1 > v_seats then
    raise exception 'no free seats (% purchased)', v_seats using errcode = 'P0001', hint = 'limit:seats';
  end if;
end;
$$;

-- Membership rules that policies alone cannot express.
-- SECURITY INVOKER on purpose: current_user tells a direct client write
-- (role `authenticated`) apart from a write made inside one of our own
-- SECURITY DEFINER functions or by the server (service role).
create or replace function app.guard_membership() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'DELETE' then
    if v_client then
      -- the organization row is already gone when this fires from its cascade
      if old.role = 'owner' and app.org_exists(old.organization_id) then
        raise exception 'the owner cannot be removed; transfer ownership first' using errcode = '42501';
      end if;
      if old.role = 'admin' and old.user_id <> auth.uid()
         and app.role_in(old.organization_id) = 'admin' then
        raise exception 'only the owner can remove another admin' using errcode = '42501';
      end if;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'user_id cannot be changed' using errcode = '42501';
    end if;
    if v_client then
      -- ownership moves only through public.transfer_ownership()
      if (old.role = 'owner') <> (new.role = 'owner') then
        raise exception 'ownership changes only through transfer_ownership()' using errcode = '42501';
      end if;
      if old.role = 'owner' and new.status <> 'active' then
        raise exception 'the owner cannot be suspended' using errcode = '42501';
      end if;
      -- nobody changes their own role, seat or status
      if old.user_id = auth.uid()
         and (new.role is distinct from old.role or new.status is distinct from old.status
              or new.seat_type is distinct from old.seat_type) then
        raise exception 'you cannot change your own role, seat or status' using errcode = '42501';
      end if;
      if old.role = 'admin' and old.user_id <> auth.uid()
         and app.role_in(new.organization_id) = 'admin' then
        raise exception 'only the owner can change another admin' using errcode = '42501';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' and v_client and new.role = 'owner' then
    raise exception 'an owner is created only with the organization' using errcode = '42501';
  end if;

  -- seat limit: counts active full seats
  if new.status = 'active' and new.seat_type = 'full'
     and (tg_op = 'INSERT' or old.status <> 'active' or old.seat_type <> 'full') then
    perform app.assert_seat_available(new.organization_id, new.id);
  end if;

  -- view seats need the feature
  if new.seat_type = 'view' and (tg_op = 'INSERT' or old.seat_type <> 'view')
     and not app.org_has_feature(new.organization_id, 'view_seats') then
    raise exception 'view-only seats are not included in this plan' using errcode = 'P0001', hint = 'feature:view_seats';
  end if;

  return new;
end;
$$;

create trigger memberships_guard before insert or update or delete on public.memberships
  for each row execute function app.guard_membership();
