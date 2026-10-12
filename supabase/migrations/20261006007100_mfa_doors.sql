-- =============================================================================
-- 0071 Two-step verification: the doors 0037 left open (RVW-13, follows FXS-03)
-- =============================================================================
-- 0037 closed the personal tables to a session that has not passed the second
-- step, but four security definer functions still checked only that a user is
-- signed in:
-- * public.set_notification_settings(): a password-only session could mute a
--   user's notifications (every kind but 'system').
-- * public.my_sessions(): a password-only session could list the user's
--   devices and IP addresses.
-- * public.my_agreement() (0016): the signed copy with IP address, browser,
--   full name, email and signature.
-- * public.mfa_recovery_codes_status() (0015): how many backup codes are left.
-- All four now start with the same check as 0037's policies, app.session_verified()
-- (aal2, or no second step needed: no verified authenticator and no
-- organization that requires one), so users without two-step verification are
-- not affected. Bodies, search_path and grants are otherwise unchanged (the
-- kinds list lives in the notification_settings check constraint, see 0068).
-- They raise 42501 with hint mfa:aal2_required; the app shows a short note
-- instead of the data (src/lib/errors.ts needsSecondStep()).
-- agreement_status() (only the version, used to gate every page) and
-- sign_agreement() stay as they are.
-- Every statement is safe to run twice.

create or replace function public.set_notification_settings(p_muted text[], p_no_push text[]) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not app.session_verified() then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa:aal2_required';
  end if;
  insert into public.notification_settings (user_id, muted, no_push, updated_at)
  values (auth.uid(), coalesce(p_muted, '{}'), coalesce(p_no_push, '{}'), now())
  on conflict (user_id) do update
    set muted = excluded.muted, no_push = excluded.no_push, updated_at = now();
end;
$$;
revoke all on function public.set_notification_settings(text[], text[]) from public, anon;
grant execute on function public.set_notification_settings(text[], text[]) to authenticated;

create or replace function public.my_sessions() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not app.session_verified() then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa:aal2_required';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'created_at', s.created_at, 'last_active_at', coalesce(s.refreshed_at, s.updated_at, s.created_at),
             'user_agent', s.user_agent, 'ip', host(s.ip), 'aal', s.aal,
             'is_current', s.id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'session_id'))
             order by coalesce(s.refreshed_at, s.updated_at, s.created_at) desc), '[]'::jsonb)
      from auth.sessions s
     where s.user_id = auth.uid());
end;
$$;
revoke all on function public.my_sessions() from public, anon;
grant execute on function public.my_sessions() to authenticated;

create or replace function public.my_agreement() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not app.session_verified() then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa:aal2_required';
  end if;
  return (
    select to_jsonb(x) from (
      select s.id, s.version, s.documents, s.content_hash, s.full_name, s.method, s.signature, s.ip, s.user_agent, s.signed_at,
             (select u.email from auth.users u where u.id = s.user_id) as email
        from app.agreement_signatures s where s.user_id = auth.uid() order by s.signed_at desc limit 1) x);
end;
$$;
revoke all on function public.my_agreement() from public, anon;
grant execute on function public.my_agreement() to authenticated;

create or replace function public.mfa_recovery_codes_status() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not app.session_verified() then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa:aal2_required';
  end if;
  return jsonb_build_object(
    'remaining', case when app.has_verified_factor()
                   then (select count(*) from app.mfa_recovery_codes c where c.user_id = auth.uid() and c.used_at is null)
                   else 0 end,
    'created_at', (select max(c.created_at) from app.mfa_recovery_codes c where c.user_id = auth.uid()));
end;
$$;
revoke all on function public.mfa_recovery_codes_status() from public, anon;
grant execute on function public.mfa_recovery_codes_status() to authenticated;
