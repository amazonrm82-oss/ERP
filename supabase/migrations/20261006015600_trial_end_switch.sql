-- =============================================================================
-- 0156 Trial end: grace, read-only, closed. Built OFF behind one platform switch
-- (BIL-08 partial, owner's decision of 13 October 2026)
-- =============================================================================
-- Until now nothing happens when a trial ends: subscriptions.trial_ends_at is only
-- shown, organizations.status stays 'trial' (writable) and the plan stays 'pro'.
--
-- * app.trial_end_settings: one row, the switch. Default OFF. Changed only by
--   public.platform_set_trial_end() (platform owner), logged in app.platform_log.
-- * app.platform_assignments: when platform staff last set a business's plan, seats or
--   trial (platform_update_subscription) or its status (platform_set_org_status).
--   Server only. Both functions are redefined here with their latest bodies plus the
--   marker and nothing else.
-- * The rule covers a business whose trial has ended and nobody assigned by hand
--   (app.trial_end_candidates()): organizations.status = 'trial', subscriptions.status
--   = 'trialing', trial_ends_at set and passed, not deleted, no platform assignment at
--   or after that trial end, and no transition of this switch-on that already ended
--   ('manual' or 'closed') after that trial end.
-- * ON: each covered business gets a transition (app.trial_end_transitions). Grace starts
--   at greatest(switch on, trial end). Read-only starts at the beginning of the business's
--   local day after day 14 (org time zone); closed at the beginning of the local day
--   7 days after the day it became
--   read-only ('suspended': access to the business is closed until payment; owner's decision
--   of 8 October 2026; the closure itself is built separately). Owners and admins get
--   'system' notifications, once each: when the grace
--   starts, 7 days and 1 day before read-only, on the read-only day, and 1 day before
--   closing. A change happens only after its 1-day notice went out on an earlier run; a
--   notice sent late moves its date to the next local day, so every date shown is the
--   day the change really happens. The plan is never touched (never 'free').
--   The daily job starts the transitions; switching on only records the moment.
-- * OFF: app.run_trial_end() does nothing; switching off ends the open transitions
--   and gives back 'trial' to a business this rule made read-only (while it still is).
--   A business the rule already closed stays closed.
-- * pg_cron 'crm-trial-end' runs app.run_trial_end() daily at 04:10 UTC.
-- Every statement is safe to run twice.

create table if not exists app.trial_end_settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  enabled_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table app.trial_end_settings enable row level security;
revoke all on app.trial_end_settings from public, anon, authenticated;
insert into app.trial_end_settings (id) values (true) on conflict (id) do nothing;

create table if not exists app.trial_end_transitions (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  grace_starts_at   timestamptz not null,
  read_only_at      timestamptz not null,
  closes_at         timestamptz not null,
  notice_start_at   timestamptz,
  notice_7_at       timestamptz,
  notice_1_at       timestamptz,
  read_only_done_at timestamptz,
  notice_close_1_at timestamptz,
  closed_done_at    timestamptz,
  ended_at          timestamptz,
  ended_reason      text check (ended_reason in ('closed', 'switch_off', 'manual')),
  created_at        timestamptz not null default now()
);
create unique index if not exists trial_end_transitions_open_idx
  on app.trial_end_transitions (organization_id) where ended_at is null;
alter table app.trial_end_transitions enable row level security;
revoke all on app.trial_end_transitions from public, anon, authenticated;

create table if not exists app.platform_assignments (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  assigned_at     timestamptz not null default now(),
  -- the last hand assignment: plan / seats / trial date, or the business status
  kind            text not null default 'subscription' check (kind in ('subscription', 'status'))
);
alter table app.platform_assignments enable row level security;
revoke all on app.platform_assignments from public, anon, authenticated;

create or replace function app.mark_platform_assignment(p_org uuid, p_kind text) returns void
language sql security definer
set search_path = ''
as $$
  insert into app.platform_assignments (organization_id, assigned_at, kind) values (p_org, now(), p_kind)
  on conflict (organization_id) do update set assigned_at = excluded.assigned_at, kind = excluded.kind;
$$;
revoke all on function app.mark_platform_assignment(uuid, text) from public, anon, authenticated;

-- platform_update_subscription: the body of plan_pricing (0147), plus the assignment marker
create or replace function public.platform_update_subscription(
  p_org uuid, p_plan_key text, p_seats integer, p_trial_ends_at timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_availability text;
begin
  perform app.require_platform(array['finance']);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.plans p where p.key = p_plan_key) then
    raise exception 'unknown plan' using errcode = '22023';
  end if;
  select jsonb_build_object('plan_key', s.plan_key, 'seats', s.seats, 'trial_ends_at', s.trial_ends_at)
    into v_old from public.subscriptions s where s.organization_id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  -- only an available plan can be chosen; a business already on another may keep it
  if p_plan_key is distinct from (v_old ->> 'plan_key') then
    select p.availability into v_availability from public.plans p where p.key = p_plan_key;
    if v_availability = 'hidden' then
      raise exception 'this plan is no longer offered' using errcode = 'P0001', hint = 'plan:hidden';
    elsif v_availability is distinct from 'available' then
      raise exception 'this plan is not available yet' using errcode = 'P0001', hint = 'plan:not_available';
    end if;
  end if;
  update public.subscriptions
     set plan_key = p_plan_key, seats = p_seats, trial_ends_at = p_trial_ends_at, updated_at = now()
   where organization_id = p_org;
  -- BIL-08: assigned by hand; the trial-end rule leaves this trial end alone
  perform app.mark_platform_assignment(p_org, 'subscription');
  perform app.log_platform('subscription.update', p_org, jsonb_build_object(
    'old', v_old, 'new', jsonb_build_object('plan_key', p_plan_key, 'seats', p_seats, 'trial_ends_at', p_trial_ends_at),
    'reason', left(p_reason, 500)));
end;
$$;

-- platform_set_org_status: the body of platform (0013), plus the assignment marker
create or replace function public.platform_set_org_status(p_org uuid, p_status public.org_status, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.org_status;
begin
  perform app.require_platform(array[]::text[]);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select o.status into v_old from public.organizations o where o.id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  update public.organizations set status = p_status where id = p_org;
  -- BIL-08: assigned by hand; the trial-end rule leaves this trial end alone
  perform app.mark_platform_assignment(p_org, 'status');
  perform app.log_platform('organization.status', p_org,
    jsonb_build_object('old', v_old, 'new', p_status, 'reason', left(p_reason, 500)));
end;
$$;

-- the beginning of a local calendar day in a time zone
create or replace function app.trial_end_day_start(p_tz text, p_day date) returns timestamptz
language sql immutable
set search_path = ''
as $$ select (p_day::timestamp) at time zone coalesce(p_tz, 'Asia/Jerusalem') $$;
revoke all on function app.trial_end_day_start(text, date) from public, anon, authenticated;

-- businesses whose trial has ended and that nobody assigned by hand
create or replace function app.trial_end_candidates(p_now timestamptz) returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select o.id
    from public.organizations o
    join public.subscriptions s on s.organization_id = o.id
   where o.deleted_at is null
     and o.status = 'trial'
     and s.status = 'trialing'
     and s.trial_ends_at is not null
     and s.trial_ends_at <= p_now
     and not exists (select 1 from app.platform_assignments pa
                      where pa.organization_id = o.id and pa.assigned_at >= s.trial_ends_at)
     -- this trial end was already handled under the current switch-on
     and not exists (select 1 from app.trial_end_transitions tr, app.trial_end_settings st
                      where st.id and tr.organization_id = o.id
                        and tr.ended_reason in ('manual', 'closed')
                        and tr.grace_starts_at >= st.enabled_at
                        and tr.ended_at >= s.trial_ends_at);
$$;
revoke all on function app.trial_end_candidates(timestamptz) from public, anon, authenticated;

-- one 'system' notification to the active owners and admins of a business
create or replace function app.trial_end_notify(p_org uuid, p_title text, p_body text) returns void
language sql security definer
set search_path = ''
as $$
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', p_title, p_body
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
$$;
revoke all on function app.trial_end_notify(uuid, text, text) from public, anon, authenticated;

-- Applies the rule. p_now and p_org exist for the tests; the cron passes neither.
create or replace function app.run_trial_end(p_now timestamptz default now(), p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_enabled_at timestamptz;
  t record;
  v_tz text;
  v_assigned boolean;
  v_reason text;
  v_at timestamptz;
  v_day text;
  v_started integer := 0;
  v_notices integer := 0;
  v_read_only integer := 0;
  v_closed integer := 0;
  v_ended integer := 0;
begin
  select st.enabled, st.enabled_at into v_enabled, v_enabled_at
    from app.trial_end_settings st where st.id for share;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('enabled', false);
  end if;

  -- 1. a transition whose business left the rule (a plan or a status was given by hand,
  --    the trial was cleared or moved forward, the business was deleted)
  for t in
    select tr.id, tr.organization_id, tr.read_only_done_at, o.status as org_status, o.deleted_at,
           s.status as sub_status, s.trial_ends_at, pa.assigned_at, pa.kind
      from app.trial_end_transitions tr
      join public.organizations o on o.id = tr.organization_id
      left join public.subscriptions s on s.organization_id = tr.organization_id
      left join app.platform_assignments pa on pa.organization_id = tr.organization_id
     where tr.ended_at is null
       and (p_org is null or tr.organization_id = p_org)
     for update of tr
  loop
    -- the same test as app.trial_end_candidates(): a hand assignment at or after this trial end
    v_assigned := t.assigned_at is not null and (t.trial_ends_at is null or t.assigned_at >= t.trial_ends_at);
    if t.deleted_at is not null
       or v_assigned
       or t.org_status is distinct from (case when t.read_only_done_at is null then 'trial' else 'read_only' end)::public.org_status
       or t.sub_status is distinct from 'trialing'
       or t.trial_ends_at is null or t.trial_ends_at > p_now then
      -- the rule made it read-only, and then staff gave it a plan or a trial: it works again.
      -- A status staff chose by hand is kept.
      if t.read_only_done_at is not null and t.org_status = 'read_only' and t.deleted_at is null then
        v_reason := case
          when v_assigned and t.kind = 'subscription' then 'assigned'
          when t.sub_status = 'trialing' and t.trial_ends_at > p_now then 'trial_extended'
        end;
        if v_reason is not null then
          update public.organizations set status = 'trial' where id = t.organization_id and status = 'read_only';
          if found then
            perform app.log_platform('trial_end.restored', t.organization_id, jsonb_build_object('reason', v_reason));
          end if;
        end if;
      end if;
      update app.trial_end_transitions set ended_at = p_now, ended_reason = 'manual' where id = t.id;
      v_ended := v_ended + 1;
    end if;
  end loop;

  -- 2. new transitions: grace from the switch, or from the trial end when later;
  --    read-only from the start of the local day after day 14, closing a week after that
  with c as (
    select s.organization_id, g.g, o.timezone as tz
      from public.subscriptions s
      join public.organizations o on o.id = s.organization_id
      cross join lateral (select greatest(v_enabled_at, s.trial_ends_at) as g) g
     where s.organization_id in (select app.trial_end_candidates(p_now))
       and (p_org is null or s.organization_id = p_org)
       and not exists (select 1 from app.trial_end_transitions tr
                        where tr.organization_id = s.organization_id and tr.ended_at is null)
  ), d as (
    select c.organization_id, c.g, c.tz, (c.g at time zone coalesce(c.tz, 'Asia/Jerusalem'))::date + 15 as ro_day from c
  ), ins as (
    insert into app.trial_end_transitions (organization_id, grace_starts_at, read_only_at, closes_at)
    select d.organization_id, d.g, app.trial_end_day_start(d.tz, d.ro_day), app.trial_end_day_start(d.tz, d.ro_day + 7) from d
    on conflict (organization_id) where ended_at is null do nothing
    returning 1
  )
  select count(*) into v_started from ins;

  -- 3. each open transition moves on, at most one step per run
  for t in
    select tr.*, o.timezone
      from app.trial_end_transitions tr
      join public.organizations o on o.id = tr.organization_id
     where tr.ended_at is null
       and (p_org is null or tr.organization_id = p_org)
     order by tr.id
     for update of tr
  loop
    v_tz := coalesce(t.timezone, 'Asia/Jerusalem');
    if t.read_only_done_at is not null then
      if t.notice_close_1_at is not null and t.notice_close_1_at < t.closes_at and p_now >= t.closes_at then
        update public.organizations set status = 'suspended' where id = t.organization_id and status = 'read_only';
        if found then
          update app.trial_end_transitions
             set closed_done_at = p_now, ended_at = p_now, ended_reason = 'closed' where id = t.id;
          perform app.log_platform('trial_end.closed', t.organization_id, jsonb_build_object('read_only_at', t.read_only_done_at));
          v_closed := v_closed + 1;
        else
          update app.trial_end_transitions set ended_at = p_now, ended_reason = 'manual' where id = t.id;
          v_ended := v_ended + 1;
        end if;
      elsif t.notice_close_1_at is null and p_now >= t.closes_at - interval '1 day' then
        -- late (on the closing day itself or after): closing moves to the next local day
        v_at := t.closes_at;
        if p_now >= v_at then
          v_at := app.trial_end_day_start(v_tz, (p_now at time zone v_tz)::date + 1);
        end if;
        v_day := to_char(v_at at time zone v_tz, 'DD.MM.YYYY');
        perform app.trial_end_notify(t.organization_id, 'מחר, ' || v_day || ', הגישה לעסק נסגרת',
          'בעוד יום הגישה לעסק תיסגר עד לתשלום. אפשר להוריד את כל הנתונים בהגדרות.');
        update app.trial_end_transitions set notice_close_1_at = p_now, closes_at = v_at where id = t.id;
        v_notices := v_notices + 1;
      end if;
    elsif t.notice_1_at is not null and t.notice_1_at < t.read_only_at and p_now >= t.read_only_at then
      update public.organizations set status = 'read_only' where id = t.organization_id and status = 'trial';
      if found then
        -- closing: the start of the local day a week after the day it became read-only
        v_at := app.trial_end_day_start(v_tz, (p_now at time zone v_tz)::date + 7);
        update app.trial_end_transitions set read_only_done_at = p_now, closes_at = v_at where id = t.id;
        perform app.log_platform('trial_end.read_only', t.organization_id, jsonb_build_object('grace_started_at', t.grace_starts_at));
        perform app.trial_end_notify(t.organization_id, 'העסק עבר לקריאה בלבד',
          'אפשר לצפות בנתונים, אבל לא להוסיף או לשנות. ב-' || to_char(v_at at time zone v_tz, 'DD.MM.YYYY')
          || ' הגישה לעסק תיסגר עד לתשלום, אם לא תיבחר חבילה עד אז.');
        v_read_only := v_read_only + 1;
      else
        update app.trial_end_transitions set ended_at = p_now, ended_reason = 'manual' where id = t.id;
        v_ended := v_ended + 1;
      end if;
    elsif t.notice_1_at is null and p_now >= t.read_only_at - interval '1 day' then
      -- the most urgent reminder that is due; an earlier one that was missed is not sent late.
      -- Late (on the read-only day itself or after): read-only moves to the next local day.
      v_at := t.read_only_at;
      if p_now >= v_at then
        v_at := app.trial_end_day_start(v_tz, (p_now at time zone v_tz)::date + 1);
      end if;
      v_day := to_char(v_at at time zone v_tz, 'DD.MM.YYYY');
      perform app.trial_end_notify(t.organization_id, 'מחר העסק עובר לקריאה בלבד',
        'תקופת הניסיון הסתיימה. מחר, ' || v_day || ', העסק עובר לקריאה בלבד, אם לא תיבחר חבילה עד אז.');
      update app.trial_end_transitions
         set notice_1_at = p_now, read_only_at = v_at,
             notice_7_at = coalesce(notice_7_at, p_now), notice_start_at = coalesce(notice_start_at, p_now)
       where id = t.id;
      v_notices := v_notices + 1;
    else
      v_day := to_char(t.read_only_at at time zone v_tz, 'DD.MM.YYYY');
      if t.notice_7_at is null and p_now >= t.read_only_at - interval '7 days' then
        perform app.trial_end_notify(t.organization_id, 'עוד שבוע העסק עובר לקריאה בלבד',
          'תקופת הניסיון הסתיימה. ב-' || v_day || ' העסק עובר לקריאה בלבד. כדי להמשיך לעבוד כרגיל, צריך לבחור חבילה לפני כן.');
        update app.trial_end_transitions
           set notice_7_at = p_now, notice_start_at = coalesce(notice_start_at, p_now)
         where id = t.id;
        v_notices := v_notices + 1;
      elsif t.notice_start_at is null then
        perform app.trial_end_notify(t.organization_id, 'תקופת הניסיון הסתיימה',
          'העסק ממשיך לעבוד כרגיל. ב-' || v_day || ' הוא עובר לקריאה בלבד, אם לא תיבחר חבילה עד אז.');
        update app.trial_end_transitions set notice_start_at = p_now where id = t.id;
        v_notices := v_notices + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('enabled', true, 'started', v_started, 'notices', v_notices,
                            'read_only', v_read_only, 'closed', v_closed, 'ended', v_ended);
end;
$$;
revoke all on function app.run_trial_end(timestamptz, uuid) from public, anon, authenticated;

-- the switch and what it covers, for every platform role
create or replace function public.platform_trial_end_status() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.trial_end_settings;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  select * into v_row from app.trial_end_settings st where st.id;
  return jsonb_build_object(
    'enabled', coalesce(v_row.enabled, false),
    'enabled_at', v_row.enabled_at,
    'updated_at', v_row.updated_at,
    -- trials that have ended and are not in a transition: what the next run would start
    'waiting', (select count(*) from app.trial_end_candidates(now()) c(id)
                 where not exists (select 1 from app.trial_end_transitions tr where tr.organization_id = c.id and tr.ended_at is null)),
    'in_grace', (select count(*) from app.trial_end_transitions tr where tr.ended_at is null and tr.read_only_done_at is null),
    'read_only', (select count(*) from app.trial_end_transitions tr where tr.ended_at is null and tr.read_only_done_at is not null),
    'closed', (select count(*) from app.trial_end_transitions tr where tr.ended_reason = 'closed'
                 and exists (select 1 from public.organizations o where o.id = tr.organization_id and o.status = 'suspended')),
    -- trials that ended (or were cleared) and that staff assigned by hand: they stay out of the rule
    'assigned', (select count(*)
                   from public.subscriptions s
                   join public.organizations o on o.id = s.organization_id
                   join app.platform_assignments pa on pa.organization_id = s.organization_id
                  where o.deleted_at is null
                    and (s.trial_ends_at is null or (s.trial_ends_at <= now() and pa.assigned_at >= s.trial_ends_at)))
  );
end;
$$;
revoke all on function public.platform_trial_end_status() from public, anon;
grant execute on function public.platform_trial_end_status() to authenticated;

-- the platform owner turns the switch on or off
create or replace function public.platform_set_trial_end(p_enabled boolean) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old boolean;
  t record;
  v_restored integer := 0;
  v_ended integer := 0;
begin
  perform app.require_platform(array[]::text[]);
  if p_enabled is null then
    raise exception 'invalid value' using errcode = '22023';
  end if;
  insert into app.trial_end_settings (id) values (true) on conflict (id) do nothing;
  select st.enabled into v_old from app.trial_end_settings st where st.id for update;
  if v_old = p_enabled then
    return jsonb_build_object('enabled', p_enabled, 'changed', false);
  end if;

  if p_enabled then
    -- the businesses whose trial already ended get their grace from now; the daily job
    -- (crm-trial-end) starts them and sends the first notice on its next run
    update app.trial_end_settings
       set enabled = true, enabled_at = now(), updated_by = auth.uid(), updated_at = now() where id;
  else
    update app.trial_end_settings
       set enabled = false, updated_by = auth.uid(), updated_at = now() where id;
    -- off = the rule does not apply: open transitions end, and a business the rule made
    -- read-only works again. A business the rule already closed stays closed.
    for t in
      select tr.id, tr.organization_id, tr.read_only_done_at, o.status
        from app.trial_end_transitions tr
        join public.organizations o on o.id = tr.organization_id
       where tr.ended_at is null
       for update of tr
    loop
      if t.read_only_done_at is not null and t.status = 'read_only' then
        update public.organizations set status = 'trial' where id = t.organization_id and status = 'read_only';
        if found then
          perform app.log_platform('trial_end.restored', t.organization_id, jsonb_build_object('reason', 'switch_off'));
          v_restored := v_restored + 1;
        end if;
      end if;
      update app.trial_end_transitions set ended_at = now(), ended_reason = 'switch_off' where id = t.id;
      v_ended := v_ended + 1;
    end loop;
  end if;

  perform app.log_platform('trial_end.switch', null, jsonb_build_object(
    'old', v_old, 'new', p_enabled, 'restored', v_restored, 'ended', v_ended));
  return jsonb_build_object('enabled', p_enabled, 'changed', true, 'restored', v_restored);
end;
$$;
revoke all on function public.platform_set_trial_end(boolean) from public, anon;
grant execute on function public.platform_set_trial_end(boolean) to authenticated;

-- What a member of a business sees: nothing while the switch is off or the business
-- is not in a transition; else the phase and the local days things happen on.
create or replace function public.trial_end_notice(p_org uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'phase', case when tr.read_only_done_at is null then 'grace' else 'read_only' end,
           'read_only_on', to_char(tr.read_only_at at time zone coalesce(o.timezone, 'Asia/Jerusalem'), 'YYYY-MM-DD'),
           'closes_on', to_char(tr.closes_at at time zone coalesce(o.timezone, 'Asia/Jerusalem'), 'YYYY-MM-DD'))
    from app.trial_end_transitions tr
    join app.trial_end_settings st on st.id and st.enabled
    join public.organizations o on o.id = tr.organization_id
   where tr.organization_id = p_org
     and tr.ended_at is null
     and app.role_in(p_org) is not null;
$$;
revoke all on function public.trial_end_notice(uuid) from public, anon;
grant execute on function public.trial_end_notice(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-trial-end', '10 4 * * *', 'select app.run_trial_end();');
  end if;
end;
$$;
