-- 20261006001300_platform: part 10 of 11. Run the parts in order.
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
