-- GAP-01: "send me a test notification".
--
-- public.send_test_notification(org) writes one notification of kind 'system'
-- (never muted, always pushed: app.apply_notification_settings) to the caller,
-- in an organization they are an active member of, so the normal pipeline
-- delivers it: the bell through Realtime, the phone through app.dispatch_push(),
-- which is woken at once here instead of waiting for the next minute.
--
-- Rate limit: 3 per user per 10-minute window, counted in app.push_tests
-- (schema app: no API access, no client grants, RLS on with no policies).
-- An over-limit call answers {ok: false, reason: 'rate', retry_seconds}
-- instead of raising, like mfa_recover().
--
-- Every statement is safe to run twice.

create table if not exists app.push_tests (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  window_started_at timestamptz not null,
  window_count      integer not null default 0
);

alter table app.push_tests enable row level security;
revoke all on app.push_tests from public, anon, authenticated;

create or replace function public.send_test_notification(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row app.push_tests;
begin
  if v_user is null or p_org is null or app.membership_role(p_org) is null then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations o
     where o.id = p_org and o.deleted_at is null
       and o.status in ('trial', 'active', 'past_due', 'read_only')
  ) then
    raise exception 'the organization is not active' using errcode = 'P0001', hint = 'org:suspended';
  end if;

  -- one row per user, locked for the count; a window older than 10 minutes starts over
  insert into app.push_tests as t (user_id, window_started_at, window_count)
  values (v_user, now(), 0)
  on conflict (user_id) do update
    set window_started_at = case when t.window_started_at <= now() - interval '10 minutes' then now() else t.window_started_at end,
        window_count = case when t.window_started_at <= now() - interval '10 minutes' then 0 else t.window_count end
  returning * into v_row;

  if v_row.window_count >= 3 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'rate',
      'retry_seconds', greatest(1, ceil(extract(epoch from (v_row.window_started_at + interval '10 minutes' - now())))::integer)
    );
  end if;

  update app.push_tests t set window_count = t.window_count + 1 where t.user_id = v_user;

  insert into public.notifications (organization_id, user_id, type, title, body)
  values (p_org, v_user, 'system', 'התראת בדיקה', 'אם ההודעה הזו הגיעה, ההתראות במכשיר הזה עובדות.');

  -- push now rather than at the next minute; does nothing where push is not set up.
  -- A failure here must not lose the test notification: the minute cron sends it.
  begin
    perform app.dispatch_push();
  exception when others then
    null;
  end;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.send_test_notification(uuid) from public, anon;
grant execute on function public.send_test_notification(uuid) to authenticated;
