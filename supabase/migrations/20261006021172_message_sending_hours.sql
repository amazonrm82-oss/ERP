-- =============================================================================
-- MSG-06: the sending queue keeps allowed sending hours per business and a fixed rate per channel
-- =============================================================================
-- Owner's answers (4 November 2026, DECISIONS.md "שעות שליחה, קצב ותקרות להודעות"):
-- (119) א: the default window is 08:00-20:00 in the business's time zone, never on a rest day or holiday of the
--   business, and on a short working day until 15:00 (the SPD-05 / CAL-03 rules: app.org_rest_day,
--   app.short_work_day); the business changes it.
-- (120) ג: always sent, whatever the window: a verification code, the instant reply to a new lead (SPD-04, when it is
--   built it joins app.message_always_sends) and a meeting reminder whose meeting starts before the next window opens.
--   Collection, quote and every other service type wait for the window, like marketing.
-- (121) א: a fixed system rate, 60 / 30 / 20 a minute (email / SMS / WhatsApp), per business and channel
--   (app.message_rate_per_minute; lead's reading: per business, so one business never takes another's turn).
-- (124) א: every plan, no plan key.
-- * public.org_message_settings: one row per business (no row = the defaults): window_from, window_until (a time of
--   day, whole minutes, until after from; 24:00 = midnight) and skip_rest_days (true = no sending on the business's rest
--   days and holidays, and until 15:00 on a short day). Members read; owners/admins of a writable business write through
--   column grants; no delete; audited. MSG-05 adds the monthly caps to the same row.
-- * app.message_window_open_at(org, at) (definer, no grants): `at` itself when it is inside the window, else the next
--   opening (up to 31 days ahead; a business with no open day in 31 days is never held).
-- * public.job_message_may_send (pinned by test 284, needs a fresh review): after every existing check (closed business,
--   event passed, HEB-09 pause and its expiry, record, address, consent), a message outside the window WAITS like the
--   HEB-09 pause: back to 'queued' at the window's opening, the attempt not counted, last_error 'waiting:sending_hours',
--   answer {may_send: false, reason: 'sending_hours', retry: true}; the business's other due message jobs that would wait
--   too are moved with it in one update. Then the rate: one row per business and channel (app.message_send_rate) is
--   locked; at the minute's limit the job waits to the next minute (uncounted, 'waiting:rate', reason 'rate') with the
--   channel's other due jobs; else the minute's count goes up and the answer is yes. An event that passes while a
--   message waits cancels it on its next check (owner (52), unchanged). The batch moves never touch a job marked
--   'waiting:sending_paused', so HEB-09's expiry rule still sees it.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The settings row
-- ----------------------------------------------------------------------------
create table if not exists public.org_message_settings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  window_from      time not null default time '08:00',
  window_until     time not null default time '20:00',
  skip_rest_days   boolean not null default true,
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint org_message_settings_whole_minutes check (
    date_trunc('minute', window_from) = window_from and date_trunc('minute', window_until) = window_until),
  constraint org_message_settings_window_order check (window_until > window_from)
);

comment on table public.org_message_settings is
  'MSG-05/MSG-06: one row per business: allowed sending hours to customers and the monthly caps (no row = defaults)';

create or replace trigger org_message_settings_touch before insert or update on public.org_message_settings
  for each row execute function app.touch_row();
create or replace trigger org_message_settings_audit after insert or update or delete on public.org_message_settings
  for each row execute function app.audit_row();

alter table public.org_message_settings enable row level security;
revoke all on public.org_message_settings from anon, authenticated;
grant select on public.org_message_settings to authenticated;
grant insert (organization_id, window_from, window_until, skip_rest_days) on public.org_message_settings to authenticated;
grant update (window_from, window_until, skip_rest_days) on public.org_message_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_message_settings'
                   and policyname = 'org_message_settings_select') then
    create policy org_message_settings_select on public.org_message_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_message_settings'
                   and policyname = 'org_message_settings_insert') then
    create policy org_message_settings_insert on public.org_message_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_message_settings'
                   and policyname = 'org_message_settings_update') then
    create policy org_message_settings_update on public.org_message_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The rules
-- ----------------------------------------------------------------------------
-- (120) ג: the types that go out whatever the window (SPD-04's instant reply joins when it is built)
create or replace function app.message_always_sends(p_type text) returns boolean
language sql immutable
set search_path = ''
as $$ select coalesce(p_type = 'verification_code', false) $$;
revoke all on function app.message_always_sends(text) from public, anon, authenticated;

-- (121) א: messages a minute, per business and channel
create or replace function app.message_rate_per_minute(p_channel text) returns integer
language sql immutable
set search_path = ''
as $$ select case p_channel when 'email' then 60 when 'sms' then 30 when 'whatsapp' then 20 else 20 end $$;
revoke all on function app.message_rate_per_minute(text) from public, anon, authenticated;

-- `p_at` when it is inside the business's sending window, else the next time the window opens
create or replace function app.message_window_open_at(p_org uuid, p_at timestamptz) returns timestamptz
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_local timestamp;
  v_from time := time '08:00';
  v_until time := time '20:00';
  v_skip boolean := true;
  v_row record;
  v_day date;
  v_end time;
begin
  if p_org is null or p_at is null then
    return p_at;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  select s.window_from, s.window_until, s.skip_rest_days into v_row
    from public.org_message_settings s where s.organization_id = p_org;
  if found then
    v_from := v_row.window_from;
    v_until := v_row.window_until;
    v_skip := v_row.skip_rest_days;
  end if;
  v_local := p_at at time zone v_zone;
  for i in 0..31 loop
    v_day := v_local::date + i;
    if v_skip and app.org_rest_day(p_org, v_day) then
      continue;
    end if;
    v_end := v_until;
    if v_skip and app.short_work_day(p_org, v_day) then
      v_end := least(v_until, time '15:00');
    end if;
    if v_end <= v_from then
      continue;
    end if;
    if v_local < v_day + v_end then
      if v_local >= v_day + v_from then
        return p_at;
      end if;
      return (v_day + v_from) at time zone v_zone;
    end if;
  end loop;
  -- no open day in a month: never hold a message for good
  return p_at;
end;
$$;
revoke all on function app.message_window_open_at(uuid, timestamptz) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rate: one row per business and channel, the current minute and how many went out in it
-- ----------------------------------------------------------------------------
create table if not exists app.message_send_rate (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  channel          text not null,
  minute_start     timestamptz not null,
  sent             integer not null default 0 check (sent >= 0),
  primary key (organization_id, channel),
  constraint message_send_rate_channel check (channel in ('email', 'sms', 'whatsapp'))
);
alter table app.message_send_rate enable row level security;
revoke all on app.message_send_rate from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The send check: 021153's body, then the window and the rate
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
    update app.message_send_rate r
       set minute_start = v_minute, sent = case when r.minute_start = v_minute then r.sent + 1 else 1 end
     where r.organization_id = v_job.organization_id and r.channel = v_channel;

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

notify pgrst, 'reload schema';
