-- 20261006001600_mfa_reset_and_agreement: part 5 of 5. Run the parts in order.
revoke all on function public.org_members_mfa(uuid) from public, anon;
revoke all on function public.org_reset_member_mfa(uuid, uuid) from public, anon;
revoke all on function public.platform_find_user(text) from public, anon;
revoke all on function public.platform_reset_mfa(uuid, text, text) from public, anon;
revoke all on function public.sign_agreement(text, jsonb, text, text, text) from public, anon;
revoke all on function public.agreement_status() from public, anon;
revoke all on function public.my_agreement() from public, anon;
grant execute on function public.org_members_mfa(uuid) to authenticated;
grant execute on function public.org_reset_member_mfa(uuid, uuid) to authenticated;
grant execute on function public.platform_find_user(text) to authenticated;
grant execute on function public.platform_reset_mfa(uuid, text, text) to authenticated;
grant execute on function public.sign_agreement(text, jsonb, text, text, text) to authenticated;
grant execute on function public.agreement_status() to authenticated;
grant execute on function public.my_agreement() to authenticated;
