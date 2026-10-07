-- TEST ONLY. A minimal stand-in for what every Supabase project already has:
-- the three API roles, the auth schema with auth.users and auth.uid(), the
-- extensions schema, and Supabase's default privileges (which hand ALL on new
-- public objects to anon/authenticated/service_role -- our migrations must
-- take those back, and the tests prove that they do).
-- Never run this file against a real Supabase project.

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

create schema auth;
create schema extensions;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  last_sign_in_at    timestamptz,
  created_at         timestamptz not null default now()
);

-- the parts of Supabase Auth's own tables that the app reads
create table auth.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  refreshed_at timestamp,
  aal          text,
  user_agent   text,
  ip           inet
);

create table auth.mfa_factors (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status  text not null default 'unverified'
);

create table auth.audit_log_entries (
  id         uuid primary key default gen_random_uuid(),
  payload    json,
  created_at timestamptz default now(),
  ip_address varchar(64) not null default ''
);

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ), '')::uuid
$$;

grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
