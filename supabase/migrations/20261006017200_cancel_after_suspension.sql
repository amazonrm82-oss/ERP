-- =============================================================================
-- 0172 'cancelled' 90 days after suspension, with notices before. Built OFF behind one
-- platform switch (BIL-09, owner's decision of 13 October 2026, "מושהה, לא מבוטל" (5))
-- =============================================================================
-- "Cancelled" is a stage of its own: 90 days after a business was suspended, with
-- warnings before. Nothing is deleted or anonymised here: deletion never runs without the
-- owner's explicit approval and is not built. A cancelled business stays closed like a
-- suspended one (0161: no role but the owner's, who may still download the full export),
-- and its public forms stop taking leads.
--
-- * app.org_suspensions: one row per time a business was suspended. Trigger
--   organizations_track_suspension opens a row when organizations.status becomes
--   'suspended' and ends it when the status leaves 'suspended' ('restored', or 'cancelled').
--   Businesses already suspended when this migration runs count from now (the start of
--   their suspension was not recorded).
-- * app.suspension_cancel_settings: one row, the switch. Default OFF. Changed only by
--   public.platform_set_suspension_cancel() (platform owner, aal2), logged in
--   app.platform_log ('suspension_cancel.switch').
-- * pg_cron 'crm-suspension-cancel' runs app.run_suspension_cancel() daily at 04:20 UTC.
--   OFF: it does nothing. ON: an open suspension gets its cancel day, the start of the
--   business's local day after greatest(suspended + 90 days, now + 30 days), so the first
--   notice is never short. The owner gets 'system' notices, once each: 30, 7 and 1 days
--   before (an earlier one that was missed is not sent late). The move happens only after
--   the 1-day notice went out on an earlier run; a 1-day notice sent on or after the day
--   moves the day to the next local day, so the date it names is the real one.
-- * Switching off clears the planned days and notices of the open suspensions, so a later
--   switch-on warns from the start. A business already cancelled stays cancelled.
-- * A business restored from suspended (any other status) ends its row and is left alone;
--   suspended again later, it starts a new 90 days.
-- Every statement is safe to run twice.

create table if not exists app.suspension_cancel_settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  enabled_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table app.suspension_cancel_settings enable row level security;
revoke all on app.suspension_cancel_settings from public, anon, authenticated;
insert into app.suspension_cancel_settings (id) values (true) on conflict (id) do nothing;

create table if not exists app.org_suspensions (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  suspended_at    timestamptz not null default now(),
  cancel_at       timestamptz,
  notice_30_at    timestamptz,
  notice_7_at     timestamptz,
  notice_1_at     timestamptz,
  cancelled_at    timestamptz,
  ended_at        timestamptz,
  ended_reason    text check (ended_reason in ('restored', 'cancelled')),
  created_at      timestamptz not null default now()
);
create unique index if not exists org_suspensions_open_idx
  on app.org_suspensions (organization_id) where ended_at is null;
alter table app.org_suspensions enable row level security;
revoke all on app.org_suspensions from public, anon, authenticated;

-- opens a suspension when the status becomes 'suspended', ends it when the status leaves it
create or replace function app.track_suspension() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status = 'suspended' and old.status is distinct from 'suspended' then
    insert into app.org_suspensions (organization_id, suspended_at) values (new.id, now())
    on conflict (organization_id) where ended_at is null do nothing;
  elsif old.status = 'suspended' and new.status is distinct from 'suspended' then
    update app.org_suspensions
       set ended_at = now(), ended_reason = case when new.status = 'cancelled' then 'cancelled' else 'restored' end
     where organization_id = new.id and ended_at is null;
  end if;
  return null;
end;
$$;
revoke all on function app.track_suspension() from public, anon, authenticated;

create or replace trigger organizations_track_suspension after update of status on public.organizations
  for each row execute function app.track_suspension();

-- the businesses suspended before this migration count from now
insert into app.org_suspensions (organization_id, suspended_at)
select o.id, now() from public.organizations o
 where o.status = 'suspended'
   and not exists (select 1 from app.org_suspensions s where s.organization_id = o.id and s.ended_at is null);

-- one 'system' notice to the active owner of a business
create or replace function app.suspension_cancel_notify(p_org uuid, p_title text, p_body text) returns void
language sql security definer
set search_path = ''
as $$
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', p_title, p_body
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role = 'owner';
$$;
revoke all on function app.suspension_cancel_notify(uuid, text, text) from public, anon, authenticated;

-- Applies the rule. p_now and p_org exist for the tests; the cron passes neither.
create or replace function app.run_suspension_cancel(p_now timestamptz default now(), p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  t record;
  v_tz text;
  v_at timestamptz;
  v_day text;
  v_body text;
  v_planned integer := 0;
  v_notices integer := 0;
  v_cancelled integer := 0;
begin
  select st.enabled into v_enabled from app.suspension_cancel_settings st where st.id for share;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('enabled', false);
  end if;

  for t in
    select s.*, o.timezone
      from app.org_suspensions s
      join public.organizations o on o.id = s.organization_id
     where s.ended_at is null
       and o.status = 'suspended'
       and o.deleted_at is null
       and (p_org is null or s.organization_id = p_org)
     order by s.id
     for update of s
  loop
    v_tz := coalesce(t.timezone, 'Asia/Jerusalem');
    if t.cancel_at is null then
      -- the start of the local day after 90 days of suspension, and at least 30 days from now
      v_at := app.trial_end_day_start(v_tz,
                (greatest(t.suspended_at + interval '90 days', p_now + interval '30 days') at time zone v_tz)::date + 1);
      update app.org_suspensions set cancel_at = v_at where id = t.id;
      t.cancel_at := v_at;
      v_planned := v_planned + 1;
    end if;

    v_body := 'הגישה לעסק סגורה עד לתשלום. כדי שהמנוי לא יבוטל, בחרו חבילה לפני כן. '
              || 'אחרי הביטול הטפסים באתר יפסיקו לקלוט לידים. אפשר להוריד את כל הנתונים בכל זמן.';
    if t.notice_1_at is not null and t.notice_1_at < t.cancel_at and p_now >= t.cancel_at then
      update app.org_suspensions set cancelled_at = p_now where id = t.id;
      -- the trigger ends the suspension as 'cancelled'
      update public.organizations set status = 'cancelled' where id = t.organization_id and status = 'suspended';
      perform app.log_platform('suspension.cancelled', t.organization_id, jsonb_build_object('suspended_at', t.suspended_at));
      v_cancelled := v_cancelled + 1;
    elsif t.notice_1_at is null and p_now >= t.cancel_at - interval '1 day' then
      -- late (on the day itself or after): the cancel day moves to the next local day
      v_at := t.cancel_at;
      if p_now >= v_at then
        v_at := app.trial_end_day_start(v_tz, (p_now at time zone v_tz)::date + 1);
      end if;
      v_day := to_char(v_at at time zone v_tz, 'DD.MM.YYYY');
      perform app.suspension_cancel_notify(t.organization_id, 'מחר, ' || v_day || ', המנוי של העסק יבוטל', v_body);
      update app.org_suspensions
         set notice_1_at = p_now, cancel_at = v_at,
             notice_7_at = coalesce(notice_7_at, p_now), notice_30_at = coalesce(notice_30_at, p_now)
       where id = t.id;
      v_notices := v_notices + 1;
    elsif t.notice_7_at is null and p_now >= t.cancel_at - interval '7 days' then
      v_day := to_char(t.cancel_at at time zone v_tz, 'DD.MM.YYYY');
      perform app.suspension_cancel_notify(t.organization_id, 'עוד שבוע, ב-' || v_day || ', המנוי של העסק יבוטל', v_body);
      update app.org_suspensions set notice_7_at = p_now, notice_30_at = coalesce(notice_30_at, p_now) where id = t.id;
      v_notices := v_notices + 1;
    elsif t.notice_30_at is null and p_now >= t.cancel_at - interval '30 days' then
      v_day := to_char(t.cancel_at at time zone v_tz, 'DD.MM.YYYY');
      perform app.suspension_cancel_notify(t.organization_id, 'ב-' || v_day || ' המנוי של העסק יבוטל', v_body);
      update app.org_suspensions set notice_30_at = p_now where id = t.id;
      v_notices := v_notices + 1;
    end if;
  end loop;

  return jsonb_build_object('enabled', true, 'planned', v_planned, 'notices', v_notices, 'cancelled', v_cancelled);
end;
$$;
revoke all on function app.run_suspension_cancel(timestamptz, uuid) from public, anon, authenticated;

-- the switch and what it covers, for every platform role
create or replace function public.platform_suspension_cancel_status() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.suspension_cancel_settings;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  select * into v_row from app.suspension_cancel_settings st where st.id;
  return jsonb_build_object(
    'enabled', coalesce(v_row.enabled, false),
    'enabled_at', v_row.enabled_at,
    'updated_at', v_row.updated_at,
    'suspended', (select count(*) from app.org_suspensions s join public.organizations o on o.id = s.organization_id
                   where s.ended_at is null and o.status = 'suspended' and o.deleted_at is null),
    'planned', (select count(*) from app.org_suspensions s where s.ended_at is null and s.cancel_at is not null),
    'cancelled', (select count(*) from app.org_suspensions s
                   where s.ended_reason = 'cancelled' and s.cancelled_at is not null
                     and exists (select 1 from public.organizations o where o.id = s.organization_id and o.status = 'cancelled'))
  );
end;
$$;
revoke all on function public.platform_suspension_cancel_status() from public, anon;
grant execute on function public.platform_suspension_cancel_status() to authenticated;

-- the platform owner turns the switch on or off
create or replace function public.platform_set_suspension_cancel(p_enabled boolean) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old boolean;
  v_cleared integer := 0;
begin
  perform app.require_platform(array[]::text[]);
  if p_enabled is null then
    raise exception 'invalid value' using errcode = '22023';
  end if;
  insert into app.suspension_cancel_settings (id) values (true) on conflict (id) do nothing;
  select st.enabled into v_old from app.suspension_cancel_settings st where st.id for update;
  if v_old = p_enabled then
    return jsonb_build_object('enabled', p_enabled, 'changed', false);
  end if;

  if p_enabled then
    update app.suspension_cancel_settings
       set enabled = true, enabled_at = now(), updated_by = auth.uid(), updated_at = now() where id;
  else
    update app.suspension_cancel_settings
       set enabled = false, updated_by = auth.uid(), updated_at = now() where id;
    -- off = no cancel days: a later switch-on plans and warns from the start
    update app.org_suspensions
       set cancel_at = null, notice_30_at = null, notice_7_at = null, notice_1_at = null
     where ended_at is null and cancel_at is not null;
    get diagnostics v_cleared = row_count;
  end if;

  perform app.log_platform('suspension_cancel.switch', null, jsonb_build_object('old', v_old, 'new', p_enabled, 'cleared', v_cleared));
  return jsonb_build_object('enabled', p_enabled, 'changed', true, 'cleared', v_cleared);
end;
$$;
revoke all on function public.platform_set_suspension_cancel(boolean) from public, anon;
grant execute on function public.platform_set_suspension_cancel(boolean) to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-suspension-cancel', '20 4 * * *', 'select app.run_suspension_cancel();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
