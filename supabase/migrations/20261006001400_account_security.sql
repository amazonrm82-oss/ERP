-- =============================================================================
-- 0014 Account security: organization-wide two-step verification, sessions, logins
-- =============================================================================
-- * organizations.require_mfa: when on, a member whose session has not passed
--   two-step verification (JWT aal <> 'aal2') is not a member as far as the
--   database is concerned: app.membership_role() returns null for them, so every
--   policy hides the organization until they verify. Only a session that has
--   itself passed two-step verification may turn the requirement on.
-- * The same holds for a user who turned on two-step verification for their own
--   account: without the code in this session, they see no organization data.
-- * public.mfa_required_orgs(): the organizations the caller is locked out of
--   for these reasons, so the app can send them to verify instead of a 404.
-- * public.my_sessions(): the caller's own signed-in devices (auth.sessions).
-- * public.org_login_events(): sign-ins and sign-outs of an organization's
--   members (auth.audit_log_entries), for the organization's admins.
-- Every statement is safe to run twice.

alter table public.organizations add column if not exists require_mfa boolean not null default false;
grant update (require_mfa) on public.organizations to authenticated;

create or replace function app.session_aal() returns text
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '');
$$;

-- true when the caller has a verified authenticator (Supabase MFA) on their account
create or replace function app.has_verified_factor() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified');
$$;

-- Same as in 0013, plus two-step verification: a session that has not passed it
-- is not a member when the organization requires it, or when the user turned it
-- on for their own account (so a stolen password alone opens nothing).
create or replace function app.membership_role(p_org uuid) returns public.membership_role
language sql stable security definer
set search_path = ''
as $$
  select m.role from public.memberships m
    join public.organizations o on o.id = m.organization_id
   where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
     and (app.session_aal() = 'aal2' or (not o.require_mfa and not app.has_verified_factor()));
$$;

-- turning the requirement on needs a verified session, or the admin locks themselves out
create or replace function app.guard_require_mfa() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.require_mfa and not old.require_mfa and auth.uid() is not null and app.session_aal() <> 'aal2' then
    raise exception 'turn on two-step verification for yourself first' using errcode = 'P0001', hint = 'mfa:self_first';
  end if;
  return new;
end;
$$;

create or replace trigger organizations_require_mfa before update of require_mfa on public.organizations
  for each row execute function app.guard_require_mfa();

create or replace function public.mfa_required_orgs() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.name), '[]'::jsonb)
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.deleted_at is null
   where m.user_id = auth.uid() and m.status = 'active' and app.session_aal() <> 'aal2'
     and (o.require_mfa or app.has_verified_factor());
$$;

-- for screens outside an organization: does this session still owe the code?
create or replace function public.mfa_status() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('enrolled', app.has_verified_factor(), 'aal', app.session_aal());
$$;

-- the caller's own sessions; is_current marks the one making this call
create or replace function public.my_sessions() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'created_at', s.created_at, 'last_active_at', coalesce(s.refreshed_at, s.updated_at, s.created_at),
           'user_agent', s.user_agent, 'ip', host(s.ip), 'aal', s.aal,
           'is_current', s.id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'session_id'))
           order by coalesce(s.refreshed_at, s.updated_at, s.created_at) desc), '[]'::jsonb)
    from auth.sessions s
   where s.user_id = auth.uid();
$$;

-- sign-ins, sign-outs and password events of the organization's members (admins only),
-- within the plan's audit log window
create or replace function public.org_login_events(p_org uuid, p_limit integer default 200) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_days numeric;
begin
  if not app.is_admin(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  v_days := coalesce(app.org_limit(p_org, 'audit_log_days'), 3650);
  return coalesce((
    select jsonb_agg(x order by x.created_at desc) from (
      select e.created_at, e.payload ->> 'action' as action, e.ip_address as ip,
             app.safe_uuid(e.payload ->> 'actor_id') as user_id
        from auth.audit_log_entries e
       where e.payload ->> 'action' in ('login', 'logout', 'user_recovery_requested', 'user_updated_password', 'user_modified', 'token_revoked')
         and e.created_at > now() - make_interval(days => v_days::int)
         and (e.payload ->> 'actor_id') in (
               select m.user_id::text from public.memberships m where m.organization_id = p_org)
       order by e.created_at desc
       limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::jsonb);
end;
$$;

revoke all on function app.session_aal() from public, anon;
grant execute on function app.session_aal() to authenticated, service_role;
revoke all on function app.guard_require_mfa() from public, anon;
grant execute on function app.guard_require_mfa() to authenticated, service_role;
revoke all on function app.has_verified_factor() from public, anon;
grant execute on function app.has_verified_factor() to authenticated, service_role;
revoke all on function public.mfa_status() from public, anon;
grant execute on function public.mfa_status() to authenticated;
revoke all on function public.mfa_required_orgs() from public, anon;
revoke all on function public.my_sessions() from public, anon;
revoke all on function public.org_login_events(uuid, integer) from public, anon;
grant execute on function public.mfa_required_orgs() to authenticated;
grant execute on function public.my_sessions() to authenticated;
grant execute on function public.org_login_events(uuid, integer) to authenticated;
