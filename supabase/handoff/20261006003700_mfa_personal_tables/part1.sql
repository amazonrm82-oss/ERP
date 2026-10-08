-- 20261006003700_mfa_personal_tables: part 1 of 2. Run the parts in order.
-- =============================================================================
-- 0037 Two-step verification also guards a user's personal tables (FXS-03)
-- =============================================================================
-- app.membership_role() already gives no role to a session that skipped the
-- second step, so business data stays closed. But some tables are checked by
-- user id alone, and a password-only session could still read its
-- notifications (customer names, tasks), its colleagues' profiles and its
-- saved views, register a device for push and clear its backup codes.
-- app.session_verified(): the session passed the second step (aal2), or it
-- needs none (no verified authenticator, and no organization that requires
-- one). It is added to the policies of notifications, push_subscriptions,
-- notification_settings, profiles (colleagues; your own row stays readable,
-- the code-entry page shows it) and saved_views, and to
-- mfa_recovery_codes_clear().
-- Every statement is safe to run twice.

create or replace function app.session_verified() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.session_aal() = 'aal2'
      or (not app.has_verified_factor()
          and not exists (select 1 from public.memberships m
                            join public.organizations o on o.id = m.organization_id
                           where m.user_id = auth.uid() and m.status = 'active' and o.require_mfa));
$$;
revoke all on function app.session_verified() from public, anon;
grant execute on function app.session_verified() to authenticated, service_role;

-- notifications
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and app.session_verified());
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid()) and app.session_verified())
  with check (user_id = (select auth.uid()) and app.session_verified());
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()) and app.session_verified());

-- push_subscriptions
drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()) and app.session_verified());
drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and app.session_verified());
drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()) and app.session_verified());

-- notification_settings (written only through set_notification_settings())
drop policy if exists notification_settings_select on public.notification_settings;
create policy notification_settings_select on public.notification_settings for select to authenticated
  using (user_id = (select auth.uid()) and app.session_verified());
