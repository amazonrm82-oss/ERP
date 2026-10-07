-- 20261006001400_account_security: part 3 of 3. Run the parts in order.
revoke all on function public.org_login_events(uuid, integer) from public, anon;
grant execute on function public.mfa_required_orgs() to authenticated;
grant execute on function public.my_sessions() to authenticated;
grant execute on function public.org_login_events(uuid, integer) to authenticated;
