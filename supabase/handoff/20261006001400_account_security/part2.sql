-- 20261006001400_account_security: part 2 of 3. Run the parts in order.
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
