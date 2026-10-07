-- 20261006001300_platform: part 3 of 11. Run the parts in order.
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
