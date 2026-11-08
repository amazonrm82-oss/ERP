-- =============================================================================
-- MSG-05 / MSG-06 answers (133)-(136): a system-wide rate, the cap holds until it is raised, cancelling waiting messages
-- =============================================================================
-- Owner's answers (DECISIONS.md "שעות שליחה ותקרות"):
-- (133) ג: the per-business-and-channel rate (60 / 30 / 20 a minute) stays, and a system-wide rate per channel across all
--   businesses holds too: 10x, 600 / 300 / 200 a minute (app.message_system_rate_per_minute), until a provider sets one. Over it
--   the job waits for the next minute, uncounted ('waiting:system_rate', reason 'system_rate'), like the business rate.
--   Design (no hot row): the system rate is split into app.message_system_rate_shards() = 10 rows per channel
--   (app.message_system_rate), each allowing a tenth of the limit a minute, so the sum never passes the limit.
--   app.message_take_system_rate first takes ANY shard with room that nobody holds (order by random(), FOR UPDATE SKIP LOCKED:
--   concurrent checks spread over the shards and never queue behind each other), and only when every shard with room is held
--   waits for one (lowest shard first, FOR UPDATE: the row is re-checked after the wait, a full one is passed over). It locks
--   one shard at a time, always after the business's own rate row, and nothing locked after it waits on another business, so no
--   cycle forms. Accepted: a minute can end with room left on some shards while others were full (the limit is never passed;
--   at most a tenth of the limit per shard is "stuck"); the business rate is still checked first.
-- (134) ב: notices to the owners and admins (as built in 021173).
-- (135) ב: a marketing message over the month's cap waits until the cap is RAISED, also across a new month: the first wait puts
--   a hold on the business and channel (app.message_cap_holds: the cap in force then); while the hold is on, every marketing
--   message of that channel waits, whatever the month's count; it is lifted only when the cap in force (the lower of the
--   business's cap and the plan's email quota) is above the held one, or no cap is left. The owners and admins see the waiting
--   count per channel and may cancel them: public.message_cancel_waiting(org, channel) (definer, owners/admins) ends them as
--   refused 'refused:cap_cancelled' and counts them in app.job_cancel_counts, the queue's own cancellation path (flushed to
--   app.platform_log as 'jobs.cancelled'), with one audit entry 'messages_cancelled' (channel and count). The notice texts
--   no longer promise the next month.
-- (136) ב: a verification code never waits for a rate (neither the business's nor the system's) and does not use one; it is
--   still counted in the usage.
-- * public.job_message_may_send (pinned by test 284) and public.message_usage (adds `held`) are redefined.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The system-wide rate, in shards
-- ----------------------------------------------------------------------------
create or replace function app.message_system_rate_per_minute(p_channel text) returns integer
language sql immutable
set search_path = ''
as $$ select case p_channel when 'email' then 600 when 'sms' then 300 when 'whatsapp' then 200 else 200 end $$;
revoke all on function app.message_system_rate_per_minute(text) from public, anon, authenticated;

create or replace function app.message_system_rate_shards() returns integer
language sql immutable
set search_path = ''
as $$ select 10 $$;
revoke all on function app.message_system_rate_shards() from public, anon, authenticated;

create table if not exists app.message_system_rate (
  channel       text not null,
  shard         integer not null,
  minute_start  timestamptz not null default '-infinity',
  sent          integer not null default 0 check (sent >= 0),
  primary key (channel, shard),
  constraint message_system_rate_channel check (channel in ('email', 'sms', 'whatsapp')),
  constraint message_system_rate_shard check (shard >= 0 and shard < 100)
);
alter table app.message_system_rate enable row level security;
revoke all on app.message_system_rate from public, anon, authenticated, service_role;
insert into app.message_system_rate (channel, shard)
select c, s from unnest(array['email', 'sms', 'whatsapp']) c cross join generate_series(0, app.message_system_rate_shards() - 1) s
on conflict (channel, shard) do nothing;

-- takes one place of the channel's system-wide rate in the minute p_minute; false = the minute is full
create or replace function app.message_take_system_rate(p_channel text, p_minute timestamptz) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_limit integer := app.message_system_rate_per_minute(p_channel) / app.message_system_rate_shards();
  v_shard integer;
begin
  -- a shard with room that nobody holds now
  select s.shard into v_shard
    from app.message_system_rate s
   where s.channel = p_channel and s.shard < app.message_system_rate_shards()
     and (s.minute_start < p_minute or s.sent < v_limit)
   order by random()
   limit 1
   for update skip locked;
  if not found then
    -- every shard with room is held right now: wait for one (re-checked after the wait)
    select s.shard into v_shard
      from app.message_system_rate s
     where s.channel = p_channel and s.shard < app.message_system_rate_shards()
       and (s.minute_start < p_minute or s.sent < v_limit)
     order by s.shard
     limit 1
     for update;
    if not found then
      return false;
    end if;
  end if;
  update app.message_system_rate s
     set minute_start = greatest(s.minute_start, p_minute),
         sent = case when s.minute_start < p_minute then 1 else s.sent + 1 end
   where s.channel = p_channel and s.shard = v_shard;
  return true;
end;
$$;
revoke all on function app.message_take_system_rate(text, timestamptz) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (135) ב: the hold of a full cap, per business and channel
-- ----------------------------------------------------------------------------
create table if not exists app.message_cap_holds (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  channel          text not null,
  held_cap         integer not null check (held_cap >= 0),
  held_at          timestamptz not null default now(),
  cleared_at       timestamptz,
  primary key (organization_id, channel),
  constraint message_cap_holds_channel check (channel in ('email', 'sms', 'whatsapp'))
);
alter table app.message_cap_holds enable row level security;
revoke all on app.message_cap_holds from public, anon, authenticated, service_role;

-- the notices without "or the next month" (answer (135) ב); otherwise 021173's
create or replace function app.message_cap_notify(p_org uuid, p_channel text, p_kind text, p_used integer, p_cap integer,
                                                  p_plan boolean, p_today date)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_today)::date;
  v_row app.message_cap_notices%rowtype;
  v_title text;
  v_body text;
  v_in text := app.message_channel_in(p_channel);
  v_count integer := 0;
begin
  insert into app.message_cap_notices (organization_id, channel, month) values (p_org, p_channel, v_month)
  on conflict (organization_id, channel, month) do nothing;
  select * into v_row from app.message_cap_notices n
   where n.organization_id = p_org and n.channel = p_channel and n.month = v_month for update;
  if p_kind = 'warn' then
    if v_row.warned_at is not null then
      return 0;
    end if;
    update app.message_cap_notices n set warned_at = now()
     where n.organization_id = p_org and n.channel = p_channel and n.month = v_month;
    v_title := 'הודעות שיווק: 80% מהתקרה החודשית';
    v_body := 'החודש יצאו ' || p_used || ' מתוך ' || p_cap || ' הודעות שיווק ' || v_in || '.';
  elsif p_kind = 'full' then
    if v_row.full_notice_on is not distinct from p_today then
      return 0;
    end if;
    update app.message_cap_notices n set full_notice_on = p_today
     where n.organization_id = p_org and n.channel = p_channel and n.month = v_month;
    if p_plan then
      v_title := 'הודעות שיווק מחכות: מכסת האימייל של החבילה מלאה';
      v_body := 'מכסת האימייל השיווקי של החבילה (' || p_cap || ' בחודש) מלאה. אימיילים שיווקיים נוספים מחכים עד שהחבילה תשודרג '
                || 'או שהתקרה תוגדל. בהגדרות "שעות ותקרות שליחה" אפשר גם לבטל אותם. הודעות שירות יוצאות כרגיל.';
    else
      v_title := 'הודעות שיווק מחכות: התקרה החודשית מלאה';
      v_body := 'התקרה החודשית של הודעות שיווק ' || v_in || ' (' || p_cap || ') מלאה. הודעות שיווק נוספות ' || v_in
                || ' מחכות עד שהתקרה תוגדל בהגדרות "שעות ותקרות שליחה", ושם אפשר גם לבטל אותן. הודעות שירות יוצאות כרגיל.';
    end if;
  elsif p_kind = 'day' then
    if v_row.day_notice_on is not distinct from p_today then
      return 0;
    end if;
    update app.message_cap_notices n set day_notice_on = p_today
     where n.organization_id = p_org and n.channel = p_channel and n.month = v_month;
    v_title := 'אימיילים שיווקיים מחכים למחר';
    v_body := 'היום יצאו ' || p_used || ' אימיילים שיווקיים, המכסה היומית של החבילה. הנוספים יוצאים מחר. הודעות שירות יוצאות כרגיל.';
  else
    return 0;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', v_title, v_body
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  raise warning 'message_cap_notify: % (business %)', sqlstate, p_org;
  return 0;
end;
$$;
revoke all on function app.message_cap_notify(uuid, text, text, integer, integer, boolean, date) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (135) ב: owners and admins cancel the messages waiting for the cap (the queue's own cancellation path)
-- ----------------------------------------------------------------------------
create or replace function public.message_cancel_waiting(p_org uuid, p_channel text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_org is null or not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('email', 'sms', 'whatsapp') then
    raise exception 'unknown channel' using errcode = '22023', hint = 'message_cancel:channel';
  end if;
  -- a job a worker holds right now is left alone (its check is under way); skip locked, never waiting on the queue
  with taken as (
    select j.id from app.jobs j
     where j.organization_id = p_org and j.kind = 'message.send' and j.status in ('queued', 'failed')
       and j.last_error in ('waiting:over_cap', 'waiting:day_quota') and (j.payload ->> 'channel') = p_channel
     for update skip locked
  ), cancelled as (
    update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                          last_error = 'refused:cap_cancelled'
      from taken t
     where j.id = t.id
    returning 1
  )
  select count(*)::integer into v_count from cancelled;
  if v_count > 0 then
    insert into app.job_cancel_counts (organization_id, reason, pending)
    values (p_org, 'cap_cancelled', v_count)
    on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + excluded.pending;
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'messages_cancelled', 'org_message_settings', null,
            jsonb_build_object('channel', p_channel, 'count', v_count));
  end if;
  return v_count;
end;
$$;
revoke all on function public.message_cancel_waiting(uuid, text) from public, anon, authenticated;
grant execute on function public.message_cancel_waiting(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The send check: _message_usage_caps.sql's body, plus the hold, the system-wide rate and no rate for a verification code
-- ----------------------------------------------------------------------------
create or replace function public.job_message_may_send(p_job uuid, p_lease uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs%rowtype;
  v_channel text;
  v_type text;
  v_record uuid;
  v_found boolean := false;
  v_email text;
  v_phone text;
  v_address text;
  v_suppressed boolean;
  v_blocked boolean;
  v_reason text;
  v_event_at timestamptz;
  v_paused_at timestamptz;
  v_pause public.org_sending_pauses%rowtype;
  v_open timestamptz;
  v_minute timestamptz;
  v_rate app.message_send_rate%rowtype;
  v_zone text;
  v_today date;
  v_marketing boolean;
  v_used_month integer;
  v_used_day integer;
  v_cap integer;
  v_cap_business integer;
  v_cap_plan integer;
  v_cap_day integer;
  v_wait timestamptz;
  v_hold app.message_cap_holds%rowtype;
  v_held boolean := false;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.kind <> 'message.send' or v_job.status <> 'running'
     or p_lease is null or v_job.lease_id is distinct from p_lease or not (v_job.locked_until > now()) then
    return jsonb_build_object('may_send', false, 'reason', 'stale');
  end if;

  v_channel := v_job.payload ->> 'channel';
  v_type := v_job.payload ->> 'message_type';
  if v_job.payload ? 'lead_id' then
    v_record := (v_job.payload ->> 'lead_id')::uuid;
    select true, l.email, l.phone into v_found, v_email, v_phone
      from public.leads l
     where l.organization_id = v_job.organization_id and l.id = v_record and l.deleted_at is null;
  else
    v_record := (v_job.payload ->> 'contact_id')::uuid;
    select true, c.email, c.phone into v_found, v_email, v_phone
      from public.contacts c
     where c.organization_id = v_job.organization_id and c.id = v_record and c.deleted_at is null;
  end if;

  if v_job.payload ? 'event_at' then
    begin
      v_event_at := (v_job.payload ->> 'event_at')::timestamptz;
    exception when others then
      v_event_at := '-infinity';
    end;
  end if;

  if not app.org_writable(v_job.organization_id) then
    v_reason := 'business_closed';
  elsif v_event_at is not null and v_event_at < now() then
    v_reason := 'event_passed';
  elsif app.customer_sending_paused(v_job.organization_id) then
    select p.paused_at into v_paused_at from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if coalesce(v_paused_at, now()) < now() - interval '24 hours' then
      v_reason := 'pause_expired';
    else
      -- (52) ג: wait for the business to resume; not refused, the attempt not counted
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = now() + interval '5 minutes', last_error = 'waiting:sending_paused'
       where j.id = p_job;
      -- the business's other message jobs already due wait with it, in one update (no attempt is counted: they were
      -- not claimed), so a paused business does not churn the queue one job at a time. Only jobs already due: a job
      -- due later is marked when its own time comes, so one due after the resume never carries the mark (review)
      update app.jobs j set next_run_at = now() + interval '5 minutes', last_error = 'waiting:sending_paused'
       where j.organization_id = v_job.organization_id and j.kind = 'message.send' and j.id <> p_job
         and j.status in ('queued', 'failed') and j.next_run_at <= now();
      return jsonb_build_object('may_send', false, 'reason', 'sending_paused', 'retry', true);
    end if;
  end if;

  -- (52) ג after the resume: the business's latest pause lasted more than 24 hours and this job waited through it
  -- (it was told to wait, or it was made before the resume and due by its end) = cancelled, even when no check
  -- happened during the pause (worker down, hourly wake). A job made during the pause for a time after the resume
  -- never waited and is sent (review M-1). Only the latest pause is known: a re-pause before an older long pause's
  -- backlog drained forgets it (review L-a, accepted)
  if v_reason is null then
    select * into v_pause from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if found and not v_pause.paused and v_pause.paused_at is not null and v_pause.resumed_at is not null
       and v_pause.resumed_at - v_pause.paused_at > interval '24 hours'
       and (v_job.last_error = 'waiting:sending_paused'
            or (v_job.created_at <= v_pause.resumed_at and v_job.next_run_at <= v_pause.resumed_at)) then
      v_reason := 'pause_expired';
    end if;
  end if;

  if v_reason is not null then
    null;
  elsif not coalesce(v_found, false) then
    v_reason := 'record_gone';
  else
    v_address := nullif(btrim(case when v_channel = 'email' then v_email else v_phone end), '');
    if v_address is null then
      v_reason := 'no_address';
    else
      if v_type = any (app.service_message_types()) then
        -- CNS-07, owner (73) א: a service message goes after an ordinary opt-out from marketing, never to an address on
        -- the blocklist or blocked by a privacy erasure (the address, business-wide; cannot check = refused)
        v_blocked := app.consent_service_blocked(v_job.organization_id, v_channel, v_address);
        if v_blocked is null then
          v_reason := 'consent_unknown';
        elsif v_blocked then
          v_reason := 'consent_blocked';
        end if;
      else
        -- marketing (every type not in the service list, or none): no opt-out, and a recorded grant for the channel
        v_suppressed := app.consent_suppressed(v_job.organization_id, v_channel, v_address);
        if v_suppressed is null then
          v_reason := 'consent_unknown';
        elsif v_suppressed then
          v_reason := 'consent_suppressed';
        elsif app.consent_granted(v_job.organization_id, v_channel, v_address) is not true then
          v_reason := 'consent_missing';
        end if;
      end if;
    end if;
  end if;

  if v_reason is null then
    -- MSG-06 (119)-(120): outside the business's sending hours the message waits for the window, uncounted; a verification
    -- code always goes, and a meeting reminder goes when its meeting starts before the window opens
    if not app.message_always_sends(v_type) then
      v_open := app.message_window_open_at(v_job.organization_id, now());
      if v_open > now() and not (v_type = 'meeting_reminder' and v_event_at is not null and v_event_at < v_open) then
        update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                              next_run_at = v_open, last_error = 'waiting:sending_hours'
         where j.id = p_job;
        -- the business's other due message jobs that would wait too, in one update (never a pause-marked one, never one
        -- that always goes or a meeting reminder: those are judged one by one)
        update app.jobs j set next_run_at = v_open, last_error = 'waiting:sending_hours'
         where j.organization_id = v_job.organization_id and j.kind = 'message.send' and j.id <> p_job
           and j.status in ('queued', 'failed') and j.next_run_at <= now()
           and j.last_error is distinct from 'waiting:sending_paused'
           and not app.message_always_sends(j.payload ->> 'message_type')
           and (j.payload ->> 'message_type') is distinct from 'meeting_reminder';
        return jsonb_build_object('may_send', false, 'reason', 'sending_hours', 'retry', true);
      end if;
    end if;

    -- MSG-06 (121) א: at most app.message_rate_per_minute(channel) a minute per business and channel; the row is the
    -- business's lock for the channel, so two workers never pass the limit together
    v_minute := date_trunc('minute', now());
    insert into app.message_send_rate (organization_id, channel, minute_start, sent)
    values (v_job.organization_id, v_channel, v_minute, 0)
    on conflict (organization_id, channel) do nothing;
    select * into v_rate from app.message_send_rate r
     where r.organization_id = v_job.organization_id and r.channel = v_channel for update;

    -- MSG-05 (122) ג, (123) ב, (125) ב: a marketing message over the month's cap (the business's, or the plan's email quota)
    -- or over the plan's daily email quota waits, uncounted; a service message is never held by them. A job counted on an
    -- earlier attempt (the provider failed, it is tried again) already holds its place
    v_marketing := not coalesce(v_type = any (app.service_message_types()), false);
    select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_job.organization_id;
    v_zone := coalesce(v_zone, 'Asia/Jerusalem');
    v_today := (now() at time zone v_zone)::date;
    if v_marketing then
      v_cap_business := app.message_business_cap(v_job.organization_id, v_channel);
      v_cap_plan := app.message_plan_cap(v_job.organization_id, v_channel, 'month');
      v_cap_day := app.message_plan_cap(v_job.organization_id, v_channel, 'day');
      v_cap := least(v_cap_business, v_cap_plan);
      select coalesce(sum(u.marketing), 0)::integer,
             coalesce(sum(u.marketing) filter (where u.day = v_today), 0)::integer
        into v_used_month, v_used_day
        from app.message_usage_days u
       where u.organization_id = v_job.organization_id and u.channel = v_channel
         and u.day >= date_trunc('month', v_today)::date and u.day <= v_today;
    end if;
    -- (135) ב: a full month's cap holds the business's channel until the cap is raised, also across a new month; the hold
    -- keeps the cap it filled at and is lifted only by a higher cap (or none)
    if v_marketing and not v_job.usage_counted then
      select * into v_hold from app.message_cap_holds h
       where h.organization_id = v_job.organization_id and h.channel = v_channel;
      v_held := found and v_hold.cleared_at is null;
      if v_held and (v_cap is null or v_cap > v_hold.held_cap) then
        update app.message_cap_holds h set cleared_at = now()
         where h.organization_id = v_job.organization_id and h.channel = v_channel;
        v_held := false;
      end if;
      if not v_held and v_cap is not null and v_used_month >= v_cap then
        insert into app.message_cap_holds (organization_id, channel, held_cap, held_at, cleared_at)
        values (v_job.organization_id, v_channel, v_cap, now(), null)
        on conflict (organization_id, channel) do update
          set held_cap = excluded.held_cap, held_at = excluded.held_at, cleared_at = null;
        v_held := true;
      end if;
    end if;
    if v_marketing and not v_job.usage_counted and (v_held or (v_cap_day is not null and v_used_day >= v_cap_day)) then
      if v_held then
        -- the cap is full: checked again every 15 minutes, so a raised cap lets it go (a new month does not)
        v_wait := now() + interval '15 minutes';
        v_reason := 'over_cap';
        perform app.message_cap_notify(v_job.organization_id, v_channel, 'full', v_used_month, v_cap,
                                       v_cap_plan is not null and v_cap_plan = v_cap, v_today);
      else
        -- the plan's daily email quota: the next day in the business's zone
        v_wait := greatest((v_today + 1)::timestamp at time zone v_zone, now() + interval '1 minute');
        v_reason := 'day_quota';
        perform app.message_cap_notify(v_job.organization_id, v_channel, 'day', v_used_day, v_cap_day, true, v_today);
      end if;
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = v_wait, last_error = 'waiting:' || v_reason
       where j.id = p_job;
      -- the channel's other due marketing messages wait with it (never a pause-marked one or one already counted)
      update app.jobs j set next_run_at = v_wait, last_error = 'waiting:' || v_reason
       where j.organization_id = v_job.organization_id and j.kind = 'message.send' and j.id <> p_job
         and j.status in ('queued', 'failed') and j.next_run_at <= now()
         and j.last_error is distinct from 'waiting:sending_paused'
         and (j.payload ->> 'channel') = v_channel
         and not coalesce((j.payload ->> 'message_type') = any (app.service_message_types()), false)
         and not j.usage_counted;
      return jsonb_build_object('may_send', false, 'reason', v_reason, 'retry', true);
    end if;
    -- (136) ב: a verification code never waits for a rate and uses none; every other message passes the business's rate,
    -- then (133) ג the system-wide rate of the channel
    if not app.message_always_sends(v_type) then
    if v_rate.minute_start = v_minute and v_rate.sent >= app.message_rate_per_minute(v_channel) then
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = v_minute + interval '1 minute', last_error = 'waiting:rate'
       where j.id = p_job;
      update app.jobs j set next_run_at = v_minute + interval '1 minute', last_error = 'waiting:rate'
       where j.organization_id = v_job.organization_id and j.kind = 'message.send' and j.id <> p_job
         and j.status in ('queued', 'failed') and j.next_run_at <= now()
         and j.last_error is distinct from 'waiting:sending_paused'
         and (j.payload ->> 'channel') = v_channel;
      return jsonb_build_object('may_send', false, 'reason', 'rate', 'retry', true);
    end if;
    if not app.message_take_system_rate(v_channel, v_minute) then
      -- the whole system's minute is full for the channel: this job waits for the next minute, uncounted (other businesses'
      -- jobs are never moved from here)
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = v_minute + interval '1 minute', last_error = 'waiting:system_rate'
       where j.id = p_job;
      return jsonb_build_object('may_send', false, 'reason', 'system_rate', 'retry', true);
    end if;
    update app.message_send_rate r
       set minute_start = v_minute, sent = case when r.minute_start = v_minute then r.sent + 1 else 1 end
     where r.organization_id = v_job.organization_id and r.channel = v_channel;
    end if;

    -- MSG-05: the message is counted once, marketing or service, on the business's day; then the notices of the month's cap
    if not v_job.usage_counted then
      insert into app.message_usage_days (organization_id, channel, day, marketing, service)
      values (v_job.organization_id, v_channel, v_today, case when v_marketing then 1 else 0 end, case when v_marketing then 0 else 1 end)
      on conflict (organization_id, channel, day) do update
        set marketing = app.message_usage_days.marketing + excluded.marketing,
            service = app.message_usage_days.service + excluded.service;
      update app.jobs j set usage_counted = true where j.id = p_job;
      if v_marketing and v_cap is not null and v_cap > 0 then
        v_used_month := v_used_month + 1;
        if v_used_month >= v_cap then
          perform app.message_cap_notify(v_job.organization_id, v_channel, 'full', v_used_month, v_cap,
                                         v_cap_plan is not null and v_cap_plan = v_cap, v_today);
        elsif v_used_month * 5 >= v_cap * 4 then
          perform app.message_cap_notify(v_job.organization_id, v_channel, 'warn', v_used_month, v_cap, false, v_today);
        end if;
      end if;
    end if;

    -- MSG-03: this lease passed the check; finish_job records the message only for such an attempt
    update app.jobs j set send_checked_lease = p_lease where j.id = p_job;
    return jsonb_build_object('may_send', true);
  end if;
  update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                        last_error = 'refused:' || v_reason
   where j.id = p_job;
  insert into app.job_cancel_counts (organization_id, reason, pending)
  values (v_job.organization_id, v_reason, 1)
  on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + 1;
  return jsonb_build_object('may_send', false, 'reason', v_reason);
end;
$$;
revoke all on function public.job_message_may_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.job_message_may_send(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- The screen: this month's usage per channel (owners and admins; counts only)
-- ----------------------------------------------------------------------------
create or replace function public.message_usage(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_today date;
  v_month date;
  v_channels jsonb;
begin
  if p_org is null or not app.is_admin(p_org) then
    return jsonb_build_object('allowed', false);
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_today := (now() at time zone v_zone)::date;
  v_month := date_trunc('month', v_today)::date;
  select jsonb_agg(jsonb_build_object(
           'channel', c.channel,
           'marketing', coalesce(u.marketing, 0),
           'service', coalesce(u.service, 0),
           'marketing_today', coalesce(u.marketing_today, 0),
           'business_cap', app.message_business_cap(p_org, c.channel),
           'plan_month_cap', app.message_plan_cap(p_org, c.channel, 'month'),
           'plan_day_cap', app.message_plan_cap(p_org, c.channel, 'day'),
           'waiting_cap', coalesce(w.cap, 0),
           'waiting_hours', coalesce(w.hours, 0),
           'held', coalesce(h.held, false)) order by c.ord)
    into v_channels
    from (values ('email', 1), ('sms', 2), ('whatsapp', 3)) c(channel, ord)
    left join lateral (
      select sum(d.marketing)::integer as marketing, sum(d.service)::integer as service,
             (sum(d.marketing) filter (where d.day = v_today))::integer as marketing_today
        from app.message_usage_days d
       where d.organization_id = p_org and d.channel = c.channel and d.day >= v_month and d.day <= v_today
    ) u on true
    left join lateral (
      select (count(*) filter (where j.last_error in ('waiting:over_cap', 'waiting:day_quota')))::integer as cap,
             (count(*) filter (where j.last_error = 'waiting:sending_hours'))::integer as hours
        from app.jobs j
       where j.organization_id = p_org and j.kind = 'message.send' and j.status in ('queued', 'failed')
         and (j.payload ->> 'channel') = c.channel
    ) w on true
    left join lateral (
      select h.cleared_at is null as held
        from app.message_cap_holds h
       where h.organization_id = p_org and h.channel = c.channel
    ) h on true;
  return jsonb_build_object('allowed', true, 'month', to_char(v_month, 'YYYY-MM'), 'channels', coalesce(v_channels, '[]'::jsonb));
end;
$$;
revoke all on function public.message_usage(uuid) from public, anon, authenticated;
grant execute on function public.message_usage(uuid) to authenticated;

notify pgrst, 'reload schema';
