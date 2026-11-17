-- =============================================================================
-- Owner (399) א, 17 November 2026 (RVW-105, ADM-03): customer messages wait during the 30-day deletion wait
-- =============================================================================
-- Since 021274 app.org_writable is false while a confirmed deletion waits its 30 days (app.org_deletion_pending), so
-- public.job_message_may_send refused every customer message of such a business for good ('business_closed') and a
-- cancelled deletion brought none of them back. Now:
-- * app.org_deletion_waiting(org) (definer, no grants): the deletion wait is the ONLY reason the business cannot write
--   (not deleted, status trial|active|past_due = app.org_writable's own condition, and a pending deletion).
-- * public.job_message_may_send: 021225's body; a business in the deletion wait is no longer 'business_closed'; after the
--   event_passed check (a meeting that passed is still refused) the job waits uncounted for 15 minutes
--   ('waiting:org_deletion'), like HEB-09's pause (attempt given back, nothing counted, no other job moved). Every other
--   reason for not writable (deleted, suspended, cancelled, read-only) is refused as before. Test 284's pin changes.
-- * Trigger org_deletions_release_jobs on app.org_deletions: when a deletion is cancelled, the business's message jobs
--   waiting for it are due at once (next_run_at = now()), so they go out (each judged again by the send check).
-- * When the 30 days end and the business is purged (app.org_deletion_purge), app.jobs cascades with the organization:
--   the waiting jobs go with it, nothing is sent.
-- * The composers (app.email_compose_core = 021299's body, app.sms_compose_core = 021283's body) answer 'paused' (the
--   worker tries the job again and the wrapper gives the count back) instead of 'not_writable' for a business in the
--   deletion wait (a deletion confirmed between the send check and the compose). Tests 352 and 367's pins change.
-- Safe to run twice (create or replace, the same grants). No drop, no delete.

create or replace function app.org_deletion_waiting(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org
       and o.deleted_at is null
       and o.status in ('trial', 'active', 'past_due')
  )
  and app.org_deletion_pending(p_org)
$$;
revoke all on function app.org_deletion_waiting(uuid) from public, anon, authenticated, service_role;

-- public.job_message_may_send: 021225's body; RVW-105 (owner (399) א): the deletion wait waits instead of refusing
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
  -- SMS (owner (210) ב, scope (א2)): the plan's flag and month quota over every SMS to a customer
  v_sms_cap integer;
  v_sms_used integer;
  v_sms_counted boolean := false;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.kind <> 'message.send' or v_job.status <> 'running'
     or p_lease is null or v_job.lease_id is distinct from p_lease or not (v_job.locked_until > now()) then
    return jsonb_build_object('may_send', false, 'reason', 'stale');
  end if;

  v_channel := v_job.payload ->> 'channel';
  v_type := v_job.payload ->> 'message_type';
  if v_job.payload ? 'sender_check_id' then
    -- SMS-01b (owner (211) א): a sender-number check's code goes to the business's own phone the check holds, while the
    -- check is open (not verified, not expired, not dead)
    select true, null, k.phone into v_found, v_email, v_phone
      from app.sms_sender_checks k
     where k.organization_id = v_job.organization_id and k.id = (v_job.payload ->> 'sender_check_id')::uuid
       and k.verified_at is null and k.attempts < app.sms_sender_max_attempts() and k.created_at > now() - interval '1 hour';
  elsif v_job.payload ? 'lead_id' then
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

  -- RVW-105, owner (399) א: during ADM-03's 30-day deletion wait (and only then: deleted, suspended, cancelled and read-only
  -- are refused as before) the business is not writable, yet the message waits like HEB-09's pause instead of being refused
  if not app.org_writable(v_job.organization_id) and not app.org_deletion_waiting(v_job.organization_id) then
    v_reason := 'business_closed';
  elsif v_event_at is not null and v_event_at < now() then
    v_reason := 'event_passed';
  elsif app.org_deletion_waiting(v_job.organization_id) then
    -- uncounted, checked again in 15 minutes (sooner when the deletion is cancelled: trigger org_deletions_release_jobs);
    -- if the business is purged at the end of the 30 days the job goes with it (app.jobs cascades with the business)
    update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                          next_run_at = now() + interval '15 minutes', last_error = 'waiting:org_deletion'
     where j.id = p_job;
    return jsonb_build_object('may_send', false, 'reason', 'org_deletion', 'retry', true);
  -- SMS-01b review (6): a sender check's code goes to the business's own phone, not a customer: HEB-09's pause does not hold it
  elsif not (v_job.payload ? 'sender_check_id') and app.customer_sending_paused(v_job.organization_id) then
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
      -- (review 5) in id order, through the one batch move
      perform app.message_move_waiting(v_job.organization_id, p_job, now() + interval '5 minutes', 'sending_paused', null, 'pause');
      return jsonb_build_object('may_send', false, 'reason', 'sending_paused', 'retry', true);
    end if;
  end if;

  -- (52) ג after the resume: the business's latest pause lasted more than 24 hours and this job waited through it
  -- (it was told to wait, or it was made before the resume and due by its end) = cancelled, even when no check
  -- happened during the pause (worker down, hourly wake). A job made during the pause for a time after the resume
  -- never waited and is sent (review M-1). Only the latest pause is known: a re-pause before an older long pause's
  -- backlog drained forgets it (review L-a, accepted)
  if v_reason is null and not (v_job.payload ? 'sender_check_id') then
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
    -- SPD-04 (120) ג: the window exemption is app.message_window_exempt (verification_code, instant_reply); the rates below
    -- keep app.message_always_sends (verification_code only, (136) ב)
    if not app.message_window_exempt(v_type) then
      v_open := app.message_window_open_at(v_job.organization_id, now());
      if v_open > now() and not (v_type = 'meeting_reminder' and v_event_at is not null and v_event_at < v_open) then
        update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                              next_run_at = v_open, last_error = 'waiting:sending_hours'
         where j.id = p_job;
        -- the business's other due message jobs that would wait too (app.message_move_waiting 'hours': never a pause-marked
        -- one or one still covered by the latest long pause, never one that always goes, a meeting reminder or a cap waiter)
        perform app.message_move_waiting(v_job.organization_id, p_job, v_open, 'sending_hours', null, 'hours');
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
                            next_run_at = v_wait, last_error = 'waiting:' || v_reason, cap_wait = v_reason
       where j.id = p_job;
      -- the channel's other due marketing messages wait with it (app.message_move_waiting 'cap': never a pause-marked one,
      -- one still covered by the latest long pause, a service type or one already counted)
      perform app.message_move_waiting(v_job.organization_id, p_job, v_wait, v_reason, v_channel, 'cap');
      return jsonb_build_object('may_send', false, 'reason', v_reason, 'retry', true);
    end if;
    -- SMS (owner (210) ב, scope (א2)): every SMS to a customer (the card's, automations', CAL-12's, PKG-03's; never a
    -- verification code) needs the plan's `sms` flag and fits its month quota (max_sms_per_month), counted when sent in
    -- app.sms_quota_months (business zone). Without the flag the job waits uncounted (an hour); over the quota it waits
    -- uncounted (15 minutes, as MSG-05's cap: cap_wait 'over_cap', so the owners' cancel takes it too) until the month turns or
    -- the quota is raised, with app.sms_quota_notify's notices (80% once a month, full once a calendar day). A job counted on
    -- an earlier attempt (usage_counted) keeps its place. Under the channel's rate row lock taken above, so two workers cannot
    -- pass the last place together.
    if v_channel = 'sms' and v_type is distinct from 'verification_code' and not v_job.usage_counted then
      if not coalesce(app.org_has_feature(v_job.organization_id, 'sms'), false) then
        update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                              next_run_at = now() + interval '1 hour', last_error = 'waiting:sms_off', cap_wait = 'sms_off'
         where j.id = p_job;
        return jsonb_build_object('may_send', false, 'reason', 'sms_off', 'retry', true);
      end if;
      v_sms_cap := app.sms_plan_quota(v_job.organization_id);
      if v_sms_cap is not null then
        select coalesce(max(m.used), 0) into v_sms_used
          from app.sms_quota_months m
         where m.organization_id = v_job.organization_id and m.month = date_trunc('month', v_today)::date;
        if v_sms_used >= v_sms_cap then
          perform app.sms_quota_notify(v_job.organization_id, 'full', v_sms_used, v_sms_cap, v_today);
          update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                                next_run_at = now() + interval '15 minutes', last_error = 'waiting:over_cap', cap_wait = 'over_cap'
           where j.id = p_job;
          return jsonb_build_object('may_send', false, 'reason', 'over_cap', 'retry', true);
        end if;
      end if;
      v_sms_counted := true;
    end if;
    -- (review 6) the cap no longer holds this job: it is not a cap waiter any more
    if v_job.cap_wait is not null then
      update app.jobs j set cap_wait = null where j.id = p_job;
    end if;
    -- (136) ב: a verification code never waits for a rate and uses none; every other message passes the business's rate,
    -- then (133) ג the system-wide rate of the channel
    if not app.message_always_sends(v_type) then
    if v_rate.minute_start = v_minute and v_rate.sent >= app.message_rate_per_minute(v_channel) then
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = v_minute + interval '1 minute', last_error = 'waiting:rate'
       where j.id = p_job;
      -- the channel's other due marketing messages (app.message_move_waiting 'rate': never a service type, a pause-marked
      -- one, one still covered by the latest long pause or a cap waiter)
      perform app.message_move_waiting(v_job.organization_id, p_job, v_minute + interval '1 minute', 'rate', v_channel, 'rate');
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
      -- SMS (owner (210) ב): the SMS is counted once in the month's quota counter; the 80% / full notices
      if v_sms_counted then
        insert into app.sms_quota_months as m (organization_id, month, used)
        values (v_job.organization_id, date_trunc('month', v_today)::date, 1)
        on conflict (organization_id, month) do update set used = m.used + 1
        returning m.used into v_sms_used;
        if v_sms_cap is not null and v_sms_cap > 0 then
          if v_sms_used >= v_sms_cap then
            perform app.sms_quota_notify(v_job.organization_id, 'full', v_sms_used, v_sms_cap, v_today);
          elsif v_sms_used::bigint * 5 >= v_sms_cap::bigint * 4 then
            perform app.sms_quota_notify(v_job.organization_id, 'warn', v_sms_used, v_sms_cap, v_today);
          end if;
        end if;
      end if;
      if v_marketing and v_cap is not null and v_cap > 0 then
        v_used_month := v_used_month + 1;
        if v_used_month >= v_cap then
          perform app.message_cap_notify(v_job.organization_id, v_channel, 'full', v_used_month, v_cap,
                                         v_cap_plan is not null and v_cap_plan = v_cap, v_today);
        elsif v_used_month::bigint * 5 >= v_cap::bigint * 4 then
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

-- A cancelled deletion releases the business's message jobs that wait for it at once
create or replace function app.org_deletions_release_jobs() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update app.jobs j set next_run_at = now()
   where j.organization_id = new.organization_id and j.kind = 'message.send' and j.status = 'queued'
     and j.last_error = 'waiting:org_deletion' and j.next_run_at > now();
  return null;
end;
$$;
revoke all on function app.org_deletions_release_jobs() from public, anon, authenticated, service_role;

create or replace trigger org_deletions_release_jobs
  after update of cancelled_at on app.org_deletions
  for each row
  when (old.cancelled_at is null and new.cancelled_at is not null)
  execute function app.org_deletions_release_jobs();

-- app.email_compose_core: 021299's body; RVW-105: the deletion wait answers 'paused'
create or replace function app.email_compose_core(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_org public.organizations;
  v_settings public.org_document_settings;
  v_type text;
  v_zone text;
  v_site text;
  v_today date;
  v_lead uuid;
  v_contact uuid;
  v_deal uuid;
  v_email text;
  v_address text;
  v_first text;
  v_full text;
  v_gender text;
  v_owner uuid;
  v_rep uuid;
  v_sender uuid;
  v_sender_admin boolean := false;
  v_reply text;
  v_reply_owner uuid;
  v_template public.message_templates;
  v_problem text;
  v_values jsonb;
  v_subject text;
  v_body text;
  v_subject_out text;
  v_text text;
  v_links jsonb := '{}'::jsonb;
  v_link_token text;
  v_unsubscribe_url text;
  v_link_urls jsonb := '[]'::jsonb;
  v_answer jsonb;
  v_placeholder constant text := repeat('x', 64);
  v_meeting public.meetings;
  v_mrow app.meeting_customer_messages;
  v_doc public.signature_documents;
  v_doc_contact uuid;
  v_adoc public.accounting_documents;
  v_offset integer;
  v_card public.punch_cards;
  v_left integer;
  v_submission public.form_submissions;
  v_review app.review_requests;
  v_rsettings public.review_request_settings;
  v_deal_contact uuid;
  v_on boolean;
  v_sender_active boolean := false;
  v_file_owner uuid;
  v_file_team uuid;
  v_files uuid[] := '{}';
  v_library uuid[] := '{}';
  v_found integer;
  v_bytes bigint := 0;
  v_more bigint := 0;
  v_attachments jsonb := '[]'::jsonb;
  v_quote public.quotes;
  v_quote_system boolean := false;
begin
  -- FOR UPDATE: the composer writes the row (composed_lease, email_counted_on)
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now()
     or v_job.send_checked_lease is distinct from p_lease
     -- only a job the send check counted, and once per lease
     or not v_job.usage_counted or v_job.composed_lease is not distinct from p_lease then
    return jsonb_build_object('refused', 'stale');
  end if;
  if (v_job.payload ->> 'channel') is distinct from 'email' then
    update app.jobs j set composed_lease = p_lease where j.id = p_job;
    return jsonb_build_object('refused', 'not_email');
  end if;
  update app.jobs j
     set composed_lease = p_lease,
         email_counted_on = coalesce(j.email_counted_on,
                                     (select (now() at time zone app.intake_zone(o.timezone))::date
                                        from public.organizations o where o.id = j.organization_id))
   where j.id = p_job;
  v_type := coalesce(v_job.payload ->> 'message_type', 'marketing');
  select * into v_org from public.organizations o where o.id = v_job.organization_id and o.deleted_at is null;
  -- RVW-105, owner (399) א: a business in ADM-03's deletion wait is not writable, but its message waits ('paused', which the
  -- worker tries again and which gives the count back), as during HEB-09's pause
  if v_org.id is not null and coalesce(app.org_deletion_waiting(v_org.id), false) then
    return jsonb_build_object('refused', 'paused');
  end if;
  if v_org.id is null or not coalesce(app.org_writable(v_org.id), false) then
    return jsonb_build_object('refused', 'not_writable');
  end if;
  if coalesce(app.customer_sending_paused(v_org.id), true) then
    return jsonb_build_object('refused', 'paused');
  end if;
  v_zone := app.intake_zone(v_org.timezone);
  v_today := (now() at time zone v_zone)::date;
  v_site := case when p_site_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
                   or p_site_url ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?$'
                 then p_site_url end;
  -- a verification code is an SMS of a sender check only (SMS-01b); no email carries one
  if v_type = 'verification_code' or v_job.payload ? 'sender_check_id' then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  -- the record the message is for, live, with its CURRENT email
  v_lead := case when (v_job.payload ->> 'lead_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_job.payload ->> 'lead_id')::uuid end;
  v_contact := case when (v_job.payload ->> 'contact_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (v_job.payload ->> 'contact_id')::uuid end;
  if num_nonnulls(v_lead, v_contact) <> 1 then
    return jsonb_build_object('refused', 'no_customer');
  end if;
  if v_lead is not null then
    select l.email, split_part(btrim(coalesce(l.full_name, '')), ' ', 1), l.full_name, l.gender, l.owner_id
      into v_email, v_first, v_full, v_gender, v_owner
      from public.leads l where l.organization_id = v_org.id and l.id = v_lead and l.deleted_at is null for key share;
  else
    select c.email, coalesce(nullif(btrim(coalesce(c.first_name, '')), ''), split_part(btrim(coalesce(c.full_name, '')), ' ', 1)),
           c.full_name, c.gender, c.owner_id
      into v_email, v_first, v_full, v_gender, v_owner
      from public.contacts c where c.organization_id = v_org.id and c.id = v_contact and c.deleted_at is null for key share;
  end if;
  if not found then
    return jsonb_build_object('refused', 'record_gone');
  end if;
  -- the address job_message_may_send judged (the same column, trimmed)
  v_address := nullif(btrim(coalesce(v_email, '')), '');
  if v_address is null then
    return jsonb_build_object('refused', 'no_address');
  end if;
  if not app.email_address_ok(v_address) then
    return jsonb_build_object('refused', 'bad_address');
  end if;
  -- the consent rule of the message's type, judged again on the address returned (cannot check = refused)
  if v_type = any (app.service_message_types()) then
    v_on := app.consent_service_blocked(v_org.id, 'email', v_address);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_blocked');
    end if;
  else
    v_on := app.consent_suppressed(v_org.id, 'email', v_address);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_suppressed');
    elsif app.consent_granted(v_org.id, 'email', v_address) is not true then
      return jsonb_build_object('refused', 'consent_missing');
    end if;
  end if;
  -- EML-02: an email sent from a deal goes to the deal's contact: still the deal's contact, the deal still live
  if v_job.payload ? 'deal_id' then
    select dl.id, dl.contact_id into v_deal, v_deal_contact from public.deals dl
     where dl.organization_id = v_org.id and dl.id::text = (v_job.payload ->> 'deal_id') and dl.deleted_at is null;
    if v_deal is null or v_deal_contact is null or v_deal_contact is distinct from v_contact then
      return jsonb_build_object('refused', 'customer_changed');
    end if;
  end if;

  -- the template: still there, an email template of the job's type, sendable now
  select * into v_template from public.message_templates t
   where t.organization_id = v_org.id and t.id::text = (v_job.payload ->> 'template_id');
  if v_template.id is null then
    return jsonb_build_object('refused', 'not_found');
  end if;
  if v_template.channel <> 'email' or v_template.message_type <> v_type then
    return jsonb_build_object('refused', 'template_changed');
  end if;
  v_problem := app.message_template_sendable(v_org.id, v_template.id);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;
  -- EML-02 / AUT-08: a card's or a rule's email never goes from a template the system sends itself, and collection needs the
  -- plan keys of every collection feature
  if v_job.payload ?| array['reply_to_user_id', 'automation_id'] then
    if v_template.notice_kind is not null then
      return jsonb_build_object('refused', 'template_changed');
    end if;
    if v_type = 'collection' and not (coalesce(app.org_has_feature(v_org.id, 'collection'), false)
                                      and coalesce(app.org_has_feature(v_org.id, 'documents'), false)
                                      and coalesce(app.org_has_feature(v_org.id, 'payments'), false)) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
  end if;

  -- the person who sent it from the card: the reply-to address while an active member, and the rep's name
  v_sender := case when (v_job.payload ->> 'reply_to_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then (v_job.payload ->> 'reply_to_user_id')::uuid end;
  if v_sender is not null then
    select true, ms.role in ('owner', 'admin') into v_on, v_sender_admin
      from public.memberships ms
     where ms.organization_id = v_org.id and ms.user_id = v_sender and ms.status = 'active';
    if coalesce(v_on, false) then
      select nullif(btrim(coalesce(u.email, '')), '') into v_reply from auth.users u where u.id = v_sender;
      if not coalesce(app.email_address_ok(v_reply), false) then
        v_reply := null;
      end if;
    end if;
    v_sender_admin := coalesce(v_sender_admin, false);
    v_sender_active := coalesce(v_on, false);
  end if;
  -- owner (8) ב (13 November 2026): an automation's email answers to the record's owner (a deal's email: the deal's owner)
  -- while that person is an active member who is not a viewer, with a plain address, else no reply-to; a card send keeps
  -- the sender's address
  if v_sender is null and v_job.payload ? 'automation_id' then
    if v_deal is not null then
      select dl.owner_id into v_reply_owner from public.deals dl where dl.organization_id = v_org.id and dl.id = v_deal;
    else
      v_reply_owner := v_owner;
    end if;
    if v_reply_owner is not null and exists (select 1 from public.memberships ms
                                              where ms.organization_id = v_org.id and ms.user_id = v_reply_owner
                                                and ms.status = 'active' and ms.role <> 'viewer') then
      select nullif(btrim(coalesce(u.email, '')), '') into v_reply from auth.users u where u.id = v_reply_owner;
      if not coalesce(app.email_address_ok(v_reply), false) then
        v_reply := null;
      end if;
    end if;
  end if;
  -- EML-02 (15 November 2026): {שם הנציג} is the person who sent it from the card; for an automation's email (button runs
  -- too) the reply-to's person of (8) ב, the record's owner (a deal's email: the deal's owner), not a viewer (below)
  v_rep := case when v_sender is not null then v_sender
                when v_job.payload ? 'automation_id' then v_reply_owner
                else v_owner end;

  -- owner (195) א: the files, judged again on the send day
  select coalesce(array_agg(distinct (f #>> '{}')::uuid), '{}') into v_files
    from jsonb_array_elements(case when jsonb_typeof(v_job.payload -> 'file_ids') = 'array' then v_job.payload -> 'file_ids'
                                   else '[]'::jsonb end) f;
  select coalesce(array_agg(distinct (f #>> '{}')::uuid), '{}') into v_library
    from jsonb_array_elements(case when jsonb_typeof(v_job.payload -> 'library_file_ids') = 'array'
                                   then v_job.payload -> 'library_file_ids' else '[]'::jsonb end) f;
  if cardinality(v_files) + cardinality(v_library) > 0 and v_sender is null then
    -- files go only with a person's card send (an automation's email carries none, owner (198) ב)
    return jsonb_build_object('refused', 'attachment_changed');
  end if;
  if cardinality(v_files) + cardinality(v_library) > app.record_email_max_files() then
    return jsonb_build_object('refused', 'attachment_changed');
  end if;
  -- RVW-110: the files of a card send go only while the person who sent it is still an active member of the business; a
  -- person suspended or removed since never sends a file (a private note's file of theirs included)
  if cardinality(v_files) + cardinality(v_library) > 0 and not v_sender_active then
    return jsonb_build_object('refused', 'attachment_changed');
  end if;
  -- and only while that person still reads the record the files are on (the record's select rule for that person:
  -- app.user_can_read_record, or an HEB-08 deputy's reading), e.g. not after a team change took it out of their sight
  if cardinality(v_files) + cardinality(v_library) > 0 then
    if v_deal is not null then
      select dl.owner_id, dl.team_id into v_file_owner, v_file_team from public.deals dl
       where dl.organization_id = v_org.id and dl.id = v_deal;
    elsif v_lead is not null then
      select l.owner_id, l.team_id into v_file_owner, v_file_team from public.leads l
       where l.organization_id = v_org.id and l.id = v_lead;
    else
      select c.owner_id, c.team_id into v_file_owner, v_file_team from public.contacts c
       where c.organization_id = v_org.id and c.id = v_contact;
    end if;
    if not (coalesce(app.user_can_read_record(v_org.id, v_sender, v_file_owner, v_file_team), false)
            or coalesce(app.user_deputy_reads(v_org.id, v_sender,
                                              case when v_deal is not null then 'deal' when v_lead is not null then 'lead' else 'contact' end,
                                              coalesce(v_deal, v_lead, v_contact)), false)) then
      return jsonb_build_object('refused', 'attachment_changed');
    end if;
  end if;
  if cardinality(v_files) > 0 then
    select count(*), coalesce(sum(f.size_bytes), 0),
           coalesce(jsonb_agg(jsonb_build_object('bucket', 'record-files', 'path', f.storage_path, 'name', f.name,
                                                 'type', f.mime_type) order by f.created_at, f.id), '[]'::jsonb)
      into v_found, v_bytes, v_attachments
      from public.files f
     where f.organization_id = v_org.id and f.id = any (v_files)
       and f.unconfirmed_since is null
       and case when v_deal is not null then f.deal_id = v_deal
                when v_lead is not null then f.lead_id = v_lead
                else f.contact_id = v_contact end
       -- a file on a private note is its author's and the admins' (REC-07), judged for the person who sent it
       and (f.activity_id is null or exists (
             select 1 from public.activities a
              where a.organization_id = f.organization_id and a.id = f.activity_id
                and (not a.is_private or a.created_by = v_sender or v_sender_admin)));
    if v_found <> cardinality(v_files) then
      return jsonb_build_object('refused', 'attachment_changed');
    end if;
  end if;
  if cardinality(v_library) > 0 then
    -- (197) ב: the current file (newest confirmed) of an active file item valid today in the business's zone
    select count(*), coalesce(sum(f.size_bytes), 0),
           v_attachments || coalesce(jsonb_agg(jsonb_build_object('bucket', 'record-files', 'path', f.storage_path,
                                                                  'name', f.name, 'type', f.mime_type)
                                               order by f.created_at, f.id), '[]'::jsonb)
      into v_found, v_more, v_attachments
      from public.files f
      join public.library_items i on i.organization_id = f.organization_id and i.id = f.library_item_id
     where f.organization_id = v_org.id and f.id = any (v_library)
       and f.unconfirmed_since is null
       and i.kind = 'file' and i.is_active
       and (i.valid_from is null or i.valid_from <= v_today)
       and (i.valid_until is null or i.valid_until >= v_today)
       and not exists (
             select 1 from public.files n
              where n.organization_id = f.organization_id and n.library_item_id = f.library_item_id
                and n.unconfirmed_since is null and (n.created_at, n.id) > (f.created_at, f.id));
    if v_found <> cardinality(v_library) then
      return jsonb_build_object('refused', 'attachment_changed');
    end if;
    v_bytes := v_bytes + v_more;
  end if;
  if v_bytes > app.record_email_max_bytes() then
    return jsonb_build_object('refused', 'attachments_too_large');
  end if;

  select * into v_settings from public.org_document_settings s where s.organization_id = v_org.id;
  -- every field is "given": a field without a value refuses below, an optional part without one disappears
  select jsonb_object_agg(f, null) into v_values from unnest(app.message_merge_fields()) f;
  v_values := v_values || jsonb_build_object(
    'שם פרטי', nullif(v_first, ''),
    'שם מלא', nullif(btrim(coalesce(v_full, '')), ''),
    'שם העסק', v_org.name,
    'טלפון העסק', coalesce(nullif(btrim(coalesce(v_settings.phone, '')), ''), nullif(btrim(coalesce(v_org.phone, '')), '')),
    'כתובת העסק', nullif(concat_ws(', ', nullif(btrim(coalesce(v_settings.address_line, '')), ''),
                                        nullif(btrim(coalesce(v_settings.city, '')), '')), ''));

  -- ---- each type's own conditions (app.sms_compose_core's, on the email address) ----
  if v_type = 'meeting_reminder' then
    -- CAL-12
    select * into v_mrow from app.meeting_customer_messages r
     where r.job_id = v_job.id and r.organization_id = v_org.id;
    if v_mrow.meeting_id is null or (v_job.payload ->> 'meeting_id') is distinct from v_mrow.meeting_id::text then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    select * into v_meeting from public.meetings m
     where m.organization_id = v_org.id and m.id = v_mrow.meeting_id for key share;
    -- the meeting's customer as CAL-12 picks it: its live contact, else its live lead
    select mt.contact_id, mt.lead_id into v_doc_contact, v_deal_contact
      from (select c.id as contact_id, null::uuid as lead_id from public.contacts c
             where c.organization_id = v_org.id and c.id = v_meeting.contact_id and c.deleted_at is null
            union all
            select null, l.id from public.leads l
             where l.organization_id = v_org.id and l.id = v_meeting.lead_id and l.deleted_at is null
               and not exists (select 1 from public.contacts c where c.organization_id = v_org.id
                                  and c.id = v_meeting.contact_id and c.deleted_at is null)) mt;
    if v_mrow.outcome <> 'queued' or v_meeting.id is null or v_meeting.status <> 'planned' or v_meeting.is_block
       or v_meeting.starts_at <> v_mrow.starts_at or v_meeting.starts_at <= now()
       or v_doc_contact is distinct from v_contact or v_deal_contact is distinct from v_lead then
      return jsonb_build_object('refused', 'meeting_changed');
    end if;
    select case v_mrow.kind when 'day' then s.meeting_remind_day when 'hour' then s.meeting_remind_hour else s.meeting_confirm end
      into v_on from public.org_message_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'meeting_reminders'), false) or not coalesce(v_on, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    v_rep := coalesce(v_meeting.owner_id, v_rep);
    v_values := v_values || jsonb_build_object(
      'תאריך', app.sms_hebrew_date((v_meeting.starts_at at time zone v_zone)::date, true),
      'שעה', to_char(v_meeting.starts_at at time zone v_zone, 'HH24:MI'),
      'מיקום', nullif(btrim(coalesce(v_meeting.location, '')), ''));
    v_links := jsonb_build_object('קישור', '/f/book/manage/');
  elsif v_type = 'requested_document' and v_job.payload ? 'quote_id' then
    -- QUO-18: the quote, re-read in the job's business; the one rule decides (app.quote_message_refusal)
    select * into v_quote from public.quotes q
     where q.organization_id = v_org.id and q.id::text = (v_job.payload ->> 'quote_id') for key share;
    v_problem := app.quote_message_refusal(v_job, v_quote, v_contact, v_template);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    -- a message no person sent answers to the quote's owner while an active member who is not a viewer
    if v_sender is null then
      v_quote_system := true;
      v_rep := v_quote.owner_id;
      if v_quote.owner_id is not null and exists (select 1 from public.memberships ms
                                                   where ms.organization_id = v_org.id and ms.user_id = v_quote.owner_id
                                                     and ms.status = 'active' and ms.role <> 'viewer') then
        select nullif(btrim(coalesce(u.email, '')), '') into v_reply from auth.users u where u.id = v_quote.owner_id;
        if not coalesce(app.email_address_ok(v_reply), false) then
          v_reply := null;
        end if;
      end if;
    end if;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim('הצעת מחיר ' || coalesce(v_quote.number_display, '')),
      'תוקף', app.sms_hebrew_date(v_quote.valid_until, false));
    v_links := jsonb_build_object('קישור להצעה', '/f/quote/');
  elsif v_type = 'requested_document' and v_job.payload ? 'signature_document_id' then
    -- SGN-03
    select * into v_doc from public.signature_documents d
     where d.organization_id = v_org.id and d.id::text = (v_job.payload ->> 'signature_document_id') for key share;
    if v_doc.id is not null and v_doc.deal_id is not null and v_doc.lead_id is null and v_doc.contact_id is null then
      select dl.contact_id into v_doc_contact from public.deals dl
       where dl.organization_id = v_org.id and dl.id = v_doc.deal_id and dl.deleted_at is null;
    else
      v_doc_contact := v_doc.contact_id;
    end if;
    if v_doc.id is null or v_doc.status not in ('sent', 'viewed') or v_doc.expired_at is not null or v_doc.erased_at is not null
       or v_doc.text_erased_at is not null or v_doc.expires_at is null or v_doc.expires_at <= now()
       or (v_lead is not null and v_doc.lead_id is distinct from v_lead)
       or (v_contact is not null and v_doc_contact is distinct from v_contact)
       or not exists (select 1 from app.signature_customer_reminders r
                       where r.organization_id = v_org.id and r.document_id = v_doc.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'signatures'), false)
       or not coalesce(v_settings.signature_customer_reminder, true) then
      return jsonb_build_object('refused', 'reminder_off');
    end if;
    v_values := v_values || jsonb_build_object(
      'שם המסמך', nullif(btrim(coalesce(v_doc.title, '')), ''),
      'תאריך', app.sms_hebrew_date((v_doc.expires_at at time zone v_zone)::date, false));
    v_links := jsonb_build_object('קישור', '/f/sign/');
  elsif v_type = 'collection' and v_job.payload ? 'collection_document_id' then
    -- COL-07
    select r.offset_days into v_offset from app.collection_reminders_sent r
     where r.organization_id = v_org.id and r.customer_job_id = v_job.id
       and r.document_id::text = (v_job.payload ->> 'collection_document_id');
    if not found then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    v_problem := app.collection_customer_refusal(v_org.id, (v_job.payload ->> 'collection_document_id')::uuid, v_contact, v_offset);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    select * into v_adoc from public.accounting_documents d
     where d.organization_id = v_org.id and d.id = (v_job.payload ->> 'collection_document_id')::uuid;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim(app.document_type_label(v_adoc.doc_type) || coalesce(' ' || v_adoc.number, '')),
      'סכום', app.sms_amount_text(app.document_balance(v_org.id, v_adoc.id)),
      'מועד תשלום', app.sms_hebrew_date(v_adoc.due_date, false));
  elsif v_type = 'punch_card_notice' then
    -- PKG-03 / PKG-06
    select * into v_card from public.punch_cards c
     where c.organization_id = v_org.id and c.id::text = (v_job.payload ->> 'punch_card_id');
    if v_card.id is null or v_card.status <> 'active' or v_contact is null
       or (v_card.contact_id is distinct from v_contact and v_card.payer_contact_id is distinct from v_contact) then
      return jsonb_build_object('refused', 'card_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'punch_cards'), false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if not coalesce((select s.customer_messages from public.punch_card_alert_settings s where s.organization_id = v_org.id), false) then
      return jsonb_build_object('refused', 'messages_off');
    end if;
    select v_card.entries_total - count(*)::integer into v_left from public.punch_card_uses u
     where u.organization_id = v_org.id and u.card_id = v_card.id and u.returned_at is null;
    v_values := v_values || jsonb_build_object(
      'שם הכרטיסייה', v_card.name,
      'כניסות', app.punch_card_entries_text(v_left),
      'תאריך', app.sms_hebrew_date(v_card.expires_on, false));
  elsif v_type = 'instant_reply' then
    -- SPD-04: the record's email still the one typed in the submission
    select * into v_submission from public.form_submissions s
     where s.organization_id = v_org.id and s.id::text = (v_job.payload ->> 'form_submission_id') and s.status <> 'spam';
    if v_submission.id is null
       or not exists (select 1 from app.instant_replies r
                       where r.organization_id = v_org.id and r.submission_id = v_submission.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'instant_reply'), false)
       or not exists (select 1 from public.forms f
                       where f.organization_id = v_org.id and f.id = v_submission.form_id and f.kind = 'form' and f.instant_reply) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if nullif(lower(btrim(coalesce(v_submission.payload ->> 'email', ''))), '') is distinct from lower(v_address) then
      return jsonb_build_object('refused', 'address_changed');
    end if;
    if not (v_job.payload ? 'event_at') then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    v_values := v_values || jsonb_build_object('שעה', to_char((v_job.payload ->> 'event_at')::timestamptz at time zone v_zone, 'HH24:MI'));
  elsif v_type = 'review_request' then
    -- RET-02: the person and the request from the request's own row
    select * into v_review from app.review_requests r
     where r.organization_id = v_org.id and r.id::text = (v_job.payload ->> 'review_request_id');
    if v_review.id is null or v_review.job_id is distinct from v_job.id
       or v_review.lead_id is distinct from v_lead or v_review.contact_id is distinct from v_contact then
      return jsonb_build_object('refused', 'request_changed');
    end if;
    select * into v_rsettings from public.review_request_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'review_requests'), false) or not coalesce(v_rsettings.enabled, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if coalesce(app.qr_external_off(v_org.id), true) then
      return jsonb_build_object('refused', 'link_blocked');
    end if;
    if not coalesce(app.review_url_ok(v_rsettings.review_url), false) then
      return jsonb_build_object('refused', 'link_invalid');
    end if;
    v_values := v_values || jsonb_build_object('קישור לביקורת', v_rsettings.review_url);
  elsif v_type not in ('marketing', 'requested_document', 'collection') then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  v_values := v_values || jsonb_build_object('שם הנציג',
    coalesce((select nullif(btrim(coalesce(p.full_name, '')), '') from public.profiles p
                join public.memberships ms on ms.user_id = p.id and ms.organization_id = v_org.id and ms.status = 'active'
               -- EML-02 (15 November 2026): an automation's rep is an active member who is not a viewer; QUO-18: so is the
               -- quote's owner on a message no person sent
               where p.id = v_rep and (not (v_job.payload ? 'automation_id' or v_quote_system) or ms.role <> 'viewer')),
             -- QUO-18: a message no person sent, whose owner is not such a member, is signed with the business's name
             case when v_quote_system then v_org.name end));

  -- marketing types: the envelope and the unsubscribe link (CNS-07: no type = marketing)
  v_subject := coalesce(v_template.subject, '');
  v_body := v_template.body;
  if not (v_type = any (app.service_message_types())) then
    v_subject := app.email_marketing_subject(v_subject);
    v_body := app.email_marketing_body(v_body);
    v_links := v_links || jsonb_build_object('קישור הסרה', '/f/unsub/');
  end if;
  -- only the links the subject or the body holds
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_links
    from jsonb_each_text(v_links) as e(k, v) where strpos(v_body || v_subject, '{' || k || '}') > 0;
  if v_links <> '{}'::jsonb and v_site is null then
    return jsonb_build_object('refused', 'site_url');
  end if;

  -- judged with placeholders of the tokens' exact length before anything is minted
  v_text := app.sms_fill(v_body, v_values || (select coalesce(jsonb_object_agg(k, v_site || v || v_placeholder), '{}'::jsonb)
                                                 from jsonb_each_text(v_links) as e(k, v)), v_gender);
  v_subject_out := app.sms_fill(v_subject, v_values || (select coalesce(jsonb_object_agg(k, v_site || v || v_placeholder), '{}'::jsonb)
                                                          from jsonb_each_text(v_links) as e(k, v)), v_gender);
  if app.sms_unfilled_in(v_body, v_values || (select coalesce(jsonb_object_agg(k, 'x'), '{}'::jsonb)
                                                from jsonb_each_text(v_links) as e(k, v)), v_gender)
     or app.sms_unfilled_in(v_subject, v_values || (select coalesce(jsonb_object_agg(k, 'x'), '{}'::jsonb)
                                                      from jsonb_each_text(v_links) as e(k, v)), v_gender) then
    return jsonb_build_object('refused', 'unfilled_field');
  end if;
  v_problem := app.message_filled_problem('email', v_type, v_subject_out, v_text);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;
  if v_subject_out ~ '[[:cntrl:]]' or btrim(v_subject_out) = '' then
    return jsonb_build_object('refused', 'bad_subject');
  end if;
  if char_length(v_subject_out) > 255 then
    return jsonb_build_object('refused', 'subject_too_long');
  end if;

  -- the links, last
  if v_links ? 'קישור' then
    if v_type = 'meeting_reminder' then
      v_answer := public.meeting_reminder_link(v_job.id, p_lease);
      if v_answer ? 'refused' then
        return jsonb_build_object('refused', v_answer ->> 'refused');
      end if;
      v_link_token := v_answer ->> 'token';
    else
      v_link_token := app.signature_link_issue(v_doc);
    end if;
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור', v_site || (v_links ->> 'קישור') || v_link_token);
    v_link_urls := v_link_urls || to_jsonb(v_site || (v_links ->> 'קישור') || v_link_token);
  end if;
  if v_links ? 'קישור להצעה' then
    -- QUO-18: a new customer link for this message (since 021285 added beside the quote's earlier links)
    v_link_token := app.quote_message_link_issue(v_quote, v_sender, v_job.id);
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור להצעה', v_site || (v_links ->> 'קישור להצעה') || v_link_token);
    v_link_urls := v_link_urls || to_jsonb(v_site || (v_links ->> 'קישור להצעה') || v_link_token);
  end if;
  if v_links ? 'קישור הסרה' then
    v_answer := public.consent_preference_link_for_job(v_job.id, p_lease);
    if v_answer ? 'refused' then
      return jsonb_build_object('refused', v_answer ->> 'refused');
    end if;
    v_link_token := v_answer ->> 'token';
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור הסרה', v_site || (v_links ->> 'קישור הסרה') || v_link_token);
    -- RFC 8058: the one-click POST address for the List-Unsubscribe headers (the same token)
    v_unsubscribe_url := v_site || '/api/forms/unsub/' || v_link_token;
    v_link_urls := v_link_urls || to_jsonb(v_site || (v_links ->> 'קישור הסרה') || v_link_token);
  end if;
  -- RET-02: the stored review link, when the text holds it
  if v_type = 'review_request' and strpos(v_body || v_subject, '{קישור לביקורת}') > 0
     and v_rsettings.review_url like 'https://%' then
    v_link_urls := v_link_urls || to_jsonb(v_rsettings.review_url);
  end if;
  v_text := app.sms_fill(v_body, v_values, v_gender);
  v_subject_out := app.sms_fill(v_subject, v_values, v_gender);
  if app.sms_unfilled_in(v_body, v_values, v_gender) or app.sms_unfilled_in(v_subject, v_values, v_gender)
     or app.message_filled_problem('email', v_type, v_subject_out, v_text) is not null
     or v_subject_out ~ '[[:cntrl:]]' or char_length(v_subject_out) > 255 then
    return jsonb_build_object('refused', 'changed');
  end if;

  return jsonb_build_object('to', v_address, 'from_name', v_org.name, 'subject', v_subject_out, 'text', v_text,
                            'reply_to', v_reply, 'list_unsubscribe', v_unsubscribe_url,
                            'links', (select coalesce(jsonb_agg(distinct u), '[]'::jsonb)
                                        from jsonb_array_elements_text(v_link_urls) u
                                       -- delta review (2): only a plain https URL (no space, quote or angle bracket)
                                       where u ~ '^https://[^[:space:]<>"'']+$'),
                            'attachments', v_attachments);
end;
$$;
revoke all on function app.email_compose_core(uuid, uuid, text) from public, anon, authenticated, service_role;

-- app.sms_compose_core: 021283's body; RVW-105: the deletion wait answers 'paused'
create or replace function app.sms_compose_core(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_org public.organizations;
  v_settings public.org_document_settings;
  v_type text;
  v_zone text;
  v_site text;
  v_lead uuid;
  v_contact uuid;
  v_phone text;
  v_first text;
  v_full text;
  v_gender text;
  v_owner uuid;
  v_rep uuid;
  v_template public.message_templates;
  v_problem text;
  v_values jsonb;
  v_body text;
  v_text text;
  v_links jsonb := '{}'::jsonb;
  v_link_token text;
  v_answer jsonb;
  v_placeholder constant text := repeat('x', 64);
  v_meeting public.meetings;
  v_mrow app.meeting_customer_messages;
  v_doc public.signature_documents;
  v_doc_contact uuid;
  v_adoc public.accounting_documents;
  v_offset integer;
  v_card public.punch_cards;
  v_left integer;
  v_submission public.form_submissions;
  v_review app.review_requests;
  v_rsettings public.review_request_settings;
  v_deal_contact uuid;
  v_on boolean;
  v_raw_phone text;
  v_quote public.quotes;
  v_quote_system boolean := false;
begin
  -- final review (3): FOR UPDATE, since the composer writes the row (composed_lease, sms_counted_on)
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now()
     or v_job.send_checked_lease is distinct from p_lease
     -- delta review (4): only a job the send check counted, and once per lease
     or not v_job.usage_counted or v_job.composed_lease is not distinct from p_lease then
    return jsonb_build_object('refused', 'stale');
  end if;
  update app.jobs j
     set composed_lease = p_lease,
         sms_counted_on = coalesce(j.sms_counted_on,
                                   (select (now() at time zone app.intake_zone(o.timezone))::date
                                      from public.organizations o where o.id = j.organization_id))
   where j.id = p_job;
  if (v_job.payload ->> 'channel') is distinct from 'sms' then
    return jsonb_build_object('refused', 'not_sms');
  end if;
  v_type := coalesce(v_job.payload ->> 'message_type', 'marketing');
  select * into v_org from public.organizations o where o.id = v_job.organization_id and o.deleted_at is null;
  -- RVW-105, owner (399) א: a business in ADM-03's deletion wait is not writable, but its message waits ('paused', which the
  -- worker tries again and which gives the count back), as during HEB-09's pause
  if v_org.id is not null and coalesce(app.org_deletion_waiting(v_org.id), false) then
    return jsonb_build_object('refused', 'paused');
  end if;
  if v_org.id is null or not coalesce(app.org_writable(v_org.id), false) then
    return jsonb_build_object('refused', 'not_writable');
  end if;
  if coalesce(app.customer_sending_paused(v_org.id), true) then
    return jsonb_build_object('refused', 'paused');
  end if;
  v_zone := app.intake_zone(v_org.timezone);
  v_site := case when p_site_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
                   or p_site_url ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?$'
                 then p_site_url end;

  -- SMS-01b: the code that verifies the business's own sender number
  if v_job.payload ? 'sender_check_id' then
    if v_type <> 'verification_code' then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    v_answer := public.sms_sender_code_issue(v_job.id, p_lease);
    if v_answer ? 'refused' then
      return jsonb_build_object('refused', v_answer ->> 'refused');
    end if;
    v_phone := app.normalize_phone(v_answer ->> 'phone');
    if v_phone is null then
      return jsonb_build_object('refused', 'no_phone');
    end if;
    -- review (1): the number job_message_may_send judged (the check's phone), and the service rule on it again
    select k.phone into v_raw_phone from app.sms_sender_checks k
     where k.organization_id = v_org.id and k.id::text = (v_job.payload ->> 'sender_check_id');
    if app.normalize_phone(v_raw_phone) is distinct from v_phone then
      return jsonb_build_object('refused', 'address_changed');
    end if;
    v_on := app.consent_service_blocked(v_org.id, 'sms', v_phone);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_blocked');
    end if;
    -- the number is not verified yet: the platform's default sender
    return jsonb_build_object('to', v_phone, 'sender', null, 'text', app.sms_sender_code_text(v_answer ->> 'code'));
  end if;
  if v_type = 'verification_code' then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  -- the record the message is for, live, with its CURRENT phone
  v_lead := case when (v_job.payload ->> 'lead_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_job.payload ->> 'lead_id')::uuid end;
  v_contact := case when (v_job.payload ->> 'contact_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (v_job.payload ->> 'contact_id')::uuid end;
  if num_nonnulls(v_lead, v_contact) <> 1 then
    return jsonb_build_object('refused', 'no_customer');
  end if;
  if v_lead is not null then
    select l.phone_e164, l.phone, split_part(btrim(coalesce(l.full_name, '')), ' ', 1), l.full_name, l.gender, l.owner_id
      into v_phone, v_raw_phone, v_first, v_full, v_gender, v_owner
      from public.leads l where l.organization_id = v_org.id and l.id = v_lead and l.deleted_at is null for key share;
  else
    select c.phone_e164, coalesce(nullif(btrim(coalesce(c.first_name, '')), ''), split_part(btrim(coalesce(c.full_name, '')), ' ', 1)),
           c.full_name, c.gender, c.owner_id, c.phone
      into v_phone, v_first, v_full, v_gender, v_owner, v_raw_phone
      from public.contacts c where c.organization_id = v_org.id and c.id = v_contact and c.deleted_at is null for key share;
  end if;
  if not found then
    return jsonb_build_object('refused', 'record_gone');
  end if;
  if nullif(btrim(coalesce(v_phone, '')), '') is null then
    return jsonb_build_object('refused', 'no_phone');
  end if;
  -- review (1): the number returned is the one job_message_may_send judged (the record's typed phone, normalized), and the
  -- consent rule of the message's type is judged again here on it (cannot check = refused, as the send check)
  if app.normalize_phone(v_raw_phone) is distinct from v_phone then
    return jsonb_build_object('refused', 'address_changed');
  end if;
  if v_type = any (app.service_message_types()) then
    v_on := app.consent_service_blocked(v_org.id, 'sms', v_phone);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_blocked');
    end if;
  else
    v_on := app.consent_suppressed(v_org.id, 'sms', v_phone);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_suppressed');
    elsif app.consent_granted(v_org.id, 'sms', v_phone) is not true then
      return jsonb_build_object('refused', 'consent_missing');
    end if;
  end if;
  -- a message sent from a deal goes to the deal's contact: still the deal's contact, the deal still live
  if v_job.payload ? 'deal_id' then
    select dl.contact_id into v_deal_contact from public.deals dl
     where dl.organization_id = v_org.id and dl.id::text = (v_job.payload ->> 'deal_id') and dl.deleted_at is null;
    if v_deal_contact is null or v_deal_contact is distinct from v_contact then
      return jsonb_build_object('refused', 'customer_changed');
    end if;
  end if;

  -- the template: still there, an SMS template of the job's type, sendable now
  select * into v_template from public.message_templates t
   where t.organization_id = v_org.id and t.id::text = (v_job.payload ->> 'template_id');
  if v_template.id is null then
    return jsonb_build_object('refused', 'not_found');
  end if;
  if v_template.channel <> 'sms' or v_template.message_type <> v_type then
    return jsonb_build_object('refused', 'template_changed');
  end if;
  v_problem := app.message_template_sendable(v_org.id, v_template.id);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;

  select * into v_settings from public.org_document_settings s where s.organization_id = v_org.id;
  -- EML-02 (15 November 2026): {שם הנציג} is the person who sent it from the card; for an automation's SMS (button runs too)
  -- the record's owner, a deal's SMS the deal's owner (the email's rule, owner (8) ב), not a viewer (below)
  v_rep := case when (v_job.payload ->> 'sent_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (v_job.payload ->> 'sent_by_user_id')::uuid
                when v_job.payload ? 'automation_id' and v_job.payload ? 'deal_id'
                then (select dl.owner_id from public.deals dl
                       where dl.organization_id = v_org.id and dl.id::text = (v_job.payload ->> 'deal_id'))
                else v_owner end;
  -- every field is "given": a field without a value refuses below, an optional part without one disappears
  select jsonb_object_agg(f, null) into v_values from unnest(app.message_merge_fields()) f;
  v_values := v_values || jsonb_build_object(
    'שם פרטי', nullif(v_first, ''),
    'שם מלא', nullif(btrim(coalesce(v_full, '')), ''),
    'שם העסק', v_org.name,
    'טלפון העסק', coalesce(nullif(btrim(coalesce(v_settings.phone, '')), ''), nullif(btrim(coalesce(v_org.phone, '')), '')),
    'כתובת העסק', nullif(concat_ws(', ', nullif(btrim(coalesce(v_settings.address_line, '')), ''),
                                        nullif(btrim(coalesce(v_settings.city, '')), '')), ''));

  -- ---- each type's own conditions ----
  if v_type = 'meeting_reminder' then
    -- CAL-12
    select * into v_mrow from app.meeting_customer_messages r
     where r.job_id = v_job.id and r.organization_id = v_org.id;
    if v_mrow.meeting_id is null or (v_job.payload ->> 'meeting_id') is distinct from v_mrow.meeting_id::text then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    select * into v_meeting from public.meetings m
     where m.organization_id = v_org.id and m.id = v_mrow.meeting_id for key share;
    -- the meeting's customer as CAL-12 picks it: its live contact, else its live lead (meeting_reminder_link's rule)
    select mt.contact_id, mt.lead_id into v_doc_contact, v_deal_contact
      from (select c.id as contact_id, null::uuid as lead_id from public.contacts c
             where c.organization_id = v_org.id and c.id = v_meeting.contact_id and c.deleted_at is null
            union all
            select null, l.id from public.leads l
             where l.organization_id = v_org.id and l.id = v_meeting.lead_id and l.deleted_at is null
               and not exists (select 1 from public.contacts c where c.organization_id = v_org.id
                                  and c.id = v_meeting.contact_id and c.deleted_at is null)) mt;
    if v_mrow.outcome <> 'queued' or v_meeting.id is null or v_meeting.status <> 'planned' or v_meeting.is_block
       or v_meeting.starts_at <> v_mrow.starts_at or v_meeting.starts_at <= now()
       or v_doc_contact is distinct from v_contact or v_deal_contact is distinct from v_lead then
      return jsonb_build_object('refused', 'meeting_changed');
    end if;
    select case v_mrow.kind when 'day' then s.meeting_remind_day when 'hour' then s.meeting_remind_hour else s.meeting_confirm end
      into v_on from public.org_message_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'meeting_reminders'), false) or not coalesce(v_on, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    v_rep := coalesce(v_meeting.owner_id, v_rep);
    v_values := v_values || jsonb_build_object(
      'תאריך', app.sms_hebrew_date((v_meeting.starts_at at time zone v_zone)::date, true),
      'שעה', to_char(v_meeting.starts_at at time zone v_zone, 'HH24:MI'),
      'מיקום', nullif(btrim(coalesce(v_meeting.location, '')), ''));
    v_links := jsonb_build_object('קישור', '/f/book/manage/');
  elsif v_type = 'requested_document' and v_job.payload ? 'quote_id' then
    -- QUO-18: the quote, re-read in the job's business; the one rule decides (app.quote_message_refusal)
    select * into v_quote from public.quotes q
     where q.organization_id = v_org.id and q.id::text = (v_job.payload ->> 'quote_id') for key share;
    v_problem := app.quote_message_refusal(v_job, v_quote, v_contact, v_template);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    -- a message no person sent: {שם הנציג} is the quote's owner
    if not (v_job.payload ? 'sent_by_user_id') then
      v_quote_system := true;
      v_rep := v_quote.owner_id;
    end if;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim('הצעת מחיר ' || coalesce(v_quote.number_display, '')),
      'תוקף', app.sms_hebrew_date(v_quote.valid_until, false));
    v_links := jsonb_build_object('קישור להצעה', '/f/quote/');
  elsif v_type = 'requested_document' and v_job.payload ? 'signature_document_id' then
    -- SGN-03
    select * into v_doc from public.signature_documents d
     where d.organization_id = v_org.id and d.id::text = (v_job.payload ->> 'signature_document_id') for key share;
    if v_doc.id is not null and v_doc.deal_id is not null and v_doc.lead_id is null and v_doc.contact_id is null then
      select dl.contact_id into v_doc_contact from public.deals dl
       where dl.organization_id = v_org.id and dl.id = v_doc.deal_id and dl.deleted_at is null;
    else
      v_doc_contact := v_doc.contact_id;
    end if;
    if v_doc.id is null or v_doc.status not in ('sent', 'viewed') or v_doc.expired_at is not null or v_doc.erased_at is not null
       or v_doc.text_erased_at is not null or v_doc.expires_at is null or v_doc.expires_at <= now()
       or (v_lead is not null and v_doc.lead_id is distinct from v_lead)
       or (v_contact is not null and v_doc_contact is distinct from v_contact)
       or not exists (select 1 from app.signature_customer_reminders r
                       where r.organization_id = v_org.id and r.document_id = v_doc.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'signatures'), false)
       or not coalesce(v_settings.signature_customer_reminder, true) then
      return jsonb_build_object('refused', 'reminder_off');
    end if;
    v_values := v_values || jsonb_build_object(
      'שם המסמך', nullif(btrim(coalesce(v_doc.title, '')), ''),
      'תאריך', app.sms_hebrew_date((v_doc.expires_at at time zone v_zone)::date, false));
    v_links := jsonb_build_object('קישור', '/f/sign/');
  elsif v_type = 'collection' and v_job.payload ? 'collection_document_id' then
    -- COL-07
    select r.offset_days into v_offset from app.collection_reminders_sent r
     where r.organization_id = v_org.id and r.customer_job_id = v_job.id
       and r.document_id::text = (v_job.payload ->> 'collection_document_id');
    if not found then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    v_problem := app.collection_customer_refusal(v_org.id, (v_job.payload ->> 'collection_document_id')::uuid, v_contact, v_offset);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    select * into v_adoc from public.accounting_documents d
     where d.organization_id = v_org.id and d.id = (v_job.payload ->> 'collection_document_id')::uuid;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim(app.document_type_label(v_adoc.doc_type) || coalesce(' ' || v_adoc.number, '')),
      'סכום', app.sms_amount_text(app.document_balance(v_org.id, v_adoc.id)),
      'מועד תשלום', app.sms_hebrew_date(v_adoc.due_date, false));
  elsif v_type = 'punch_card_notice' then
    -- PKG-03 / PKG-06
    select * into v_card from public.punch_cards c
     where c.organization_id = v_org.id and c.id::text = (v_job.payload ->> 'punch_card_id');
    if v_card.id is null or v_card.status <> 'active' or v_contact is null
       or (v_card.contact_id is distinct from v_contact and v_card.payer_contact_id is distinct from v_contact) then
      return jsonb_build_object('refused', 'card_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'punch_cards'), false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    -- review (9): the business's switch for customer messages (PKG-03) still on
    if not coalesce((select s.customer_messages from public.punch_card_alert_settings s where s.organization_id = v_org.id), false) then
      return jsonb_build_object('refused', 'messages_off');
    end if;
    select v_card.entries_total - count(*)::integer into v_left from public.punch_card_uses u
     where u.organization_id = v_org.id and u.card_id = v_card.id and u.returned_at is null;
    v_values := v_values || jsonb_build_object(
      'שם הכרטיסייה', v_card.name,
      'כניסות', app.punch_card_entries_text(v_left),
      'תאריך', app.sms_hebrew_date(v_card.expires_on, false));
  elsif v_type = 'instant_reply' then
    -- SPD-04
    select * into v_submission from public.form_submissions s
     where s.organization_id = v_org.id and s.id::text = (v_job.payload ->> 'form_submission_id') and s.status <> 'spam';
    if v_submission.id is null
       or not exists (select 1 from app.instant_replies r
                       where r.organization_id = v_org.id and r.submission_id = v_submission.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'instant_reply'), false)
       or not exists (select 1 from public.forms f
                       where f.organization_id = v_org.id and f.id = v_submission.form_id and f.kind = 'form' and f.instant_reply) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if app.normalize_phone(nullif(btrim(coalesce(v_submission.payload ->> 'phone', '')), '')) is distinct from v_phone then
      return jsonb_build_object('refused', 'address_changed');
    end if;
    if not (v_job.payload ? 'event_at') then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    v_values := v_values || jsonb_build_object('שעה', to_char((v_job.payload ->> 'event_at')::timestamptz at time zone v_zone, 'HH24:MI'));
  elsif v_type = 'review_request' then
    -- RET-02: the person and the request from the request's own row
    select * into v_review from app.review_requests r
     where r.organization_id = v_org.id and r.id::text = (v_job.payload ->> 'review_request_id');
    if v_review.id is null or v_review.job_id is distinct from v_job.id
       or v_review.lead_id is distinct from v_lead or v_review.contact_id is distinct from v_contact then
      return jsonb_build_object('refused', 'request_changed');
    end if;
    select * into v_rsettings from public.review_request_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'review_requests'), false) or not coalesce(v_rsettings.enabled, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if coalesce(app.qr_external_off(v_org.id), true) then
      return jsonb_build_object('refused', 'link_blocked');
    end if;
    if not coalesce(app.review_url_ok(v_rsettings.review_url), false) then
      return jsonb_build_object('refused', 'link_invalid');
    end if;
    v_values := v_values || jsonb_build_object('קישור לביקורת', v_rsettings.review_url);
  elsif v_type not in ('marketing', 'requested_document', 'collection') then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  v_values := v_values || jsonb_build_object('שם הנציג',
    coalesce((select nullif(btrim(coalesce(p.full_name, '')), '') from public.profiles p
                join public.memberships ms on ms.user_id = p.id and ms.organization_id = v_org.id and ms.status = 'active'
               -- EML-02 (15 November 2026): an automation's rep is an active member who is not a viewer; QUO-18: so is the
               -- quote's owner on a message no person sent
               where p.id = v_rep and (not (v_job.payload ? 'automation_id' or v_quote_system) or ms.role <> 'viewer')),
             -- QUO-18: a message no person sent, whose owner is not such a member, is signed with the business's name
             case when v_quote_system then v_org.name end));

  -- marketing types: the envelope and the unsubscribe link (CNS-07: no type = marketing)
  v_body := v_template.body;
  if not (v_type = any (app.service_message_types())) then
    v_body := app.sms_marketing_envelope(v_body);
    v_links := v_links || jsonb_build_object('קישור הסרה', '/f/unsub/');
  end if;
  -- only the links the text holds
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_links
    from jsonb_each_text(v_links) as e(k, v) where strpos(v_body, '{' || k || '}') > 0;
  if v_links <> '{}'::jsonb and v_site is null then
    return jsonb_build_object('refused', 'site_url');
  end if;

  -- judged with placeholders of the tokens' exact length before anything is minted
  v_text := app.sms_fill(v_body, v_values || (select coalesce(jsonb_object_agg(k, v_site || v || v_placeholder), '{}'::jsonb)
                                                 from jsonb_each_text(v_links) as e(k, v)), v_gender);
  if app.sms_unfilled_in(v_body, v_values || (select coalesce(jsonb_object_agg(k, 'x'), '{}'::jsonb)
                                                from jsonb_each_text(v_links) as e(k, v)), v_gender) then
    return jsonb_build_object('refused', 'unfilled_field');
  end if;
  v_problem := app.message_filled_problem('sms', v_type, null, v_text);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;

  -- the links, last
  if v_links ? 'קישור' then
    if v_type = 'meeting_reminder' then
      v_answer := public.meeting_reminder_link(v_job.id, p_lease);
      if v_answer ? 'refused' then
        return jsonb_build_object('refused', v_answer ->> 'refused');
      end if;
      v_link_token := v_answer ->> 'token';
    else
      v_link_token := app.signature_link_issue(v_doc);
    end if;
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור', v_site || (v_links ->> 'קישור') || v_link_token);
  end if;
  if v_links ? 'קישור להצעה' then
    -- QUO-18: a new customer link for this message (since 021285 added beside the quote's earlier links)
    v_link_token := app.quote_message_link_issue(v_quote,
                      case when (v_job.payload ->> 'sent_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (v_job.payload ->> 'sent_by_user_id')::uuid end, v_job.id);
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור להצעה', v_site || (v_links ->> 'קישור להצעה') || v_link_token);
  end if;
  if v_links ? 'קישור הסרה' then
    v_answer := public.consent_preference_link_for_job(v_job.id, p_lease);
    if v_answer ? 'refused' then
      return jsonb_build_object('refused', v_answer ->> 'refused');
    end if;
    v_link_token := v_answer ->> 'token';
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור הסרה', v_site || (v_links ->> 'קישור הסרה') || v_link_token);
  end if;
  v_text := app.sms_fill(v_body, v_values, v_gender);
  if app.sms_unfilled_in(v_body, v_values, v_gender) or app.message_filled_problem('sms', v_type, null, v_text) is not null then
    return jsonb_build_object('refused', 'changed');
  end if;

  return jsonb_build_object('to', v_phone, 'sender', app.sms_effective_sender(v_org.id), 'text', v_text);
end;
$$;
revoke all on function app.sms_compose_core(uuid, uuid, text) from public, anon, authenticated, service_role;
