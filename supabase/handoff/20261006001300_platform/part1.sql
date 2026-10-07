-- 20261006001300_platform: part 1 of 11. Run the parts in order.
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
