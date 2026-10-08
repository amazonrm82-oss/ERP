-- 20261006003700_mfa_personal_tables: part 2 of 2. Run the parts in order.
-- profiles: your own row always; colleagues only in a verified session
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (app.shares_org(id) and app.session_verified()));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) and app.session_verified())
  with check (id = (select auth.uid()) and app.session_verified());

-- saved_views: the "own view" branches checked the owner alone
drop policy if exists saved_views_select on public.saved_views;
create policy saved_views_select on public.saved_views for select to authenticated
  using (app.session_verified() and (
    owner_id = (select auth.uid())
    or (scope = 'org' and app.is_member(organization_id))
    or (scope = 'team' and app.is_member(organization_id) and app.in_team(team_id))));
drop policy if exists saved_views_delete on public.saved_views;
create policy saved_views_delete on public.saved_views for delete to authenticated
  using (app.session_verified() and (owner_id = (select auth.uid()) or app.is_admin(organization_id)));

-- backup codes: clearing them needs the same as creating them, unless the authenticator is already gone
create or replace function public.mfa_recovery_codes_clear() returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or (app.session_aal() <> 'aal2' and app.has_verified_factor()) then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa:aal2_required';
  end if;
  delete from app.mfa_recovery_codes where user_id = auth.uid();
end;
$$;
revoke all on function public.mfa_recovery_codes_clear() from public, anon;
grant execute on function public.mfa_recovery_codes_clear() to authenticated;
