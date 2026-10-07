-- 20261006001400_account_security: part 1 of 3. Run the parts in order.
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
