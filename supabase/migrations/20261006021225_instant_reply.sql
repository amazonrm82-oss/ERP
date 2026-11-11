-- =============================================================================
-- SPD-04: an instant automatic reply the moment an inquiry arrives through a web form
-- =============================================================================
-- SPEC-ADDITIONS SPD-04: "we got it, we'll get back to you by 14:00", with a separate text outside working hours; email and
-- SMS in wave 3 (WhatsApp in wave 4); a service message, not marketing (CNS-07). Owner (80) א (3 November 2026): only to the
-- address the person typed in THIS form submission, once per submission, from a fixed template (business name, return time,
-- signature) with no links or offers; the blocklist and a privacy erasure still stop it (73 א). Owner (120) ג: it goes out
-- whatever the sending WINDOW (not whatever the per-minute rates: (136) ב exempts only verification_code). Plan key
-- `instant_reply` (DECISIONS). Owner 11 November 2026: (259) א a switch per web form with a business default (Settings >
-- Forms), a new form inherits it; (261) א the return time is CAP-10's response target counted in working time, and outside
-- working hours the wording is "ביום העבודה הבא עד {שעה}"; (280) ג at most one instant reply a day per address. Lead's choices
-- until the owner answers: (b) when the person typed both a phone and an email, SMS when the business has the `sms` key, else
-- email; the system's two templates are fixed (only switched on or off, review 3).
--
-- * public.forms.instant_reply (boolean, default false; insert/update column grants; owners/admins write forms through the
--   forms policies). Only a web form (kind 'form') replies. public.org_message_settings.instant_reply_default (boolean,
--   default false; select/insert/update column grants, owners/admins through the table's policies; export column list): a
--   new web form whose insert leaves the switch off takes the business default (BEFORE INSERT trigger forms_instant_reply_default).
-- * The message type `instant_reply` joins the closed lists: app.message_types() and app.service_message_types() (021177's
--   bodies plus the type), the message_templates_message_type_check constraint and app.message_type_fields (021196's body plus
--   its fields: first name, business name, business phone, time). A card or a rule never sends it
--   (app.record_email_service_types / app.record_sms_service_types are unchanged, and notice_kind templates are refused there).
-- * Review 2: the window exemption is its own predicate. app.message_window_exempt(type) = verification_code or instant_reply,
--   read only by the window checks: public.job_message_may_send (021204's body; ONLY the window line changes, so test 284's md5
--   changes and needs a fresh review) and app.message_move_waiting's 'hours' move (021175's body; only that line).
--   app.message_always_sends stays verification_code only, so an instant reply takes the per-minute rates like any message.
-- * Two DRAFT templates per channel (SMS and email), marked by the server-only notice_kind 'instant_reply_open' (in working
--   hours) and 'instant_reply_closed' (outside them), wording version 'instant-reply-draft-1', = DEFAULT_INSTANT_REPLY_TEMPLATES.
--   Seeded once per business and channel (app.instant_reply_template_seeds) when a form's switch is first on while the business holds the `instant_reply` key (trigger
--   forms_instant_reply_seed) and again before a reply is queued; a refused insert (the 50-template cap) leaves the channel unmarked, so a later try can add it,
--   with one warning. Review 3 (lead's interim choice for (80) א "a fixed template"): a person changes
--   nothing of them but is_active and cannot delete them (trigger message_templates_fixed_notice, invoker, `authenticated` at
--   depth 1 only; hint message_template:fixed_notice); server paths (the seed, a business's cascade) pass.
-- * When: public.intake_submit is NOT changed. An AFTER INSERT trigger on public.form_submissions (form_submissions_instant_reply,
--   not for spam) keeps the new submission's id in the transaction-local setting app.instant_reply_submission; then
--   app.emit_form_submitted (021000's body, which intake_submit calls right after that insert for a new or a repeat inquiry,
--   with the record it touched: a lead that is not converted, else the contact) calls app.instant_reply_queue inside its own
--   exception block, so an inquiry never fails because of the reply. Exactly once per submission: app.instant_replies (one
--   row per submission, schema app, RLS on, no grants; cascades with the submission) is written first, on conflict nothing;
--   every skip is recorded there as its outcome code, never an error.
-- * app.instant_reply_queue (definer, no grants): the setting names a submission of this business and form; the form is a web
--   form with the switch on; the business has `instant_reply` and can write; the record is live; the address is the one the
--   person typed in that submission (form_submissions.payload phone / email) AND equals the record's own primary phone
--   (phone_e164) or email, so the queue's send check (which reads the record) reads that same address; SMS only with the
--   `sms` key. The template: the active marked template of the channel and the hours' kind, sendable now
--   (app.message_template_sendable; a refusal is told once a day by app.message_send_refused and the next channel is tried).
--   Review 1 / owner (280) ג, under CAL-12's lock order (the business's day row, then the address bucket): at most 200 replies a
--   business day (app.instant_reply_days; app.instant_reply_day_cap(), a transaction may lower it; over it 'day_cap' and one
--   `system` notice to the owners and admins that day) and one per address a business day (app.instant_reply_buckets: the
--   address's HMAC with consent_hash_key, app.consent_address_hash, picks one of 65,536 buckets per business; only the bucket and
--   its day are kept; no key = 'no_key' and nothing is sent, fail closed; a taken address = 'address_cap', and no other
--   channel is tried for that person). Final review: an email is keyed by its folded form, app.instant_reply_email_key (lower case,
--   "+tag" dropped, gmail.com / googlemail.com dots dropped), only for the bucket; the record still matches the address as typed.
--   Accepted: two addresses that share a bucket share its one reply a day, so a collision fails toward not sending.
--   One OPS-04 message.send job: {channel, message_type instant_reply, template_id, lead_id | contact_id, form_submission_id,
--   event_at = the return time}.
--   THE FUTURE SENDER (its own "In use" line in hard rule 5): right before it sends it re-checks the business's
--   `instant_reply` key and the form's switch (forms.instant_reply, read through the submission's form_id), re-reads the
--   submission by form_submission_id and sends nothing unless the record's address still equals the typed one; it fills
--   {שעה} from event_at in the business's zone. If the job still waits (HEB-09's pause) when the return time passes, the queue
--   cancels it (event passed).
-- * app.job_payload_ok: 021224's body plus `form_submission_id` (only with message_type instant_reply). For the lead's merge with
--   COL-07 (021223): the lines this file adds are exactly (1) `'form_submission_id'` at the end of the allowed-key list, and
--   (2) the block commented "SPD-04 (owner (80) א)" placed right after the `signature_document_id` block.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The form's switch and the business default (owner (259) א)
-- ----------------------------------------------------------------------------
alter table public.forms add column if not exists instant_reply boolean not null default false;
comment on column public.forms.instant_reply is
  'SPD-04: an instant automatic reply to the address typed in each submission of this web form (owners/admins; default from org_message_settings.instant_reply_default).';
grant insert (instant_reply), update (instant_reply) on public.forms to authenticated;

alter table public.org_message_settings add column if not exists instant_reply_default boolean not null default false;
comment on column public.org_message_settings.instant_reply_default is
  'SPD-04 (259) א: a new web form starts with the instant reply on when this is on.';
grant select (instant_reply_default), insert (instant_reply_default), update (instant_reply_default) on public.org_message_settings to authenticated;

-- a new web form whose insert leaves the switch off takes the business default (a widget, card or webhook form never)
create or replace function app.forms_instant_reply_default() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.kind = 'form' and not new.instant_reply then
    new.instant_reply := coalesce((select s.instant_reply_default from public.org_message_settings s
                                    where s.organization_id = new.organization_id), false);
  end if;
  return new;
end;
$$;
revoke all on function app.forms_instant_reply_default() from public, anon, authenticated, service_role;

create or replace trigger forms_instant_reply_default
  before insert on public.forms
  for each row execute function app.forms_instant_reply_default();

-- ----------------------------------------------------------------------------
-- The closed lists of message types (021177's bodies plus instant_reply)
-- ----------------------------------------------------------------------------
create or replace function app.message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'instant_reply', 'marketing']::text[] $$;
revoke all on function app.message_types() from public, anon, authenticated;

create or replace function app.service_message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'instant_reply']::text[] $$;
revoke all on function app.service_message_types() from public, anon, authenticated;

alter table public.message_templates
  drop constraint if exists message_templates_message_type_check,
  add constraint message_templates_message_type_check
    check (message_type in ('meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'instant_reply', 'marketing'));

-- the system's own marks (021218's list plus the two instant replies)
alter table public.message_templates
  drop constraint if exists message_templates_notice_kind_check,
  add constraint message_templates_notice_kind_check
    check (notice_kind is null or notice_kind in ('punch_card_low', 'punch_card_expiry',
                                                  'meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour',
                                                  'signature_reminder', 'instant_reply_open', 'instant_reply_closed'));

-- The merge fields a service type may hold (021196's body plus instant_reply). Mirrors SERVICE_TYPE_FIELDS.
create or replace function app.message_type_fields(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'meeting_reminder' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'תאריך', 'שעה', 'מיקום', 'קישור']::text[]
    when 'requested_document' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'מסמך', 'קישור להצעה', 'תוקף']::text[]
    when 'collection' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'מסמך', 'סכום', 'מועד תשלום']::text[]
    when 'verification_code' then array['שם העסק', 'קוד אימות']::text[]
    when 'punch_card_notice' then array['שם פרטי', 'שם העסק', 'טלפון העסק', 'שם הכרטיסייה', 'כניסות', 'תאריך']::text[]
    -- SPD-04 (owner (80) א, (261) א): the business's name and phone sign it; the return time
    when 'instant_reply' then array['שם פרטי', 'שם העסק', 'טלפון העסק', 'שעה']::text[]
  end
$$;
revoke all on function app.message_type_fields(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Review 2: the window exemption (owner (120) ג) apart from the rate exemption ((136) ב, app.message_always_sends unchanged)
-- ----------------------------------------------------------------------------
create or replace function app.message_window_exempt(p_type text) returns boolean
language sql immutable
set search_path = ''
as $$ select coalesce(p_type in ('verification_code', 'instant_reply'), false) $$;
revoke all on function app.message_window_exempt(text) from public, anon, authenticated;

-- app.message_move_waiting: 021175's body; SPD-04: the 'hours' move leaves out a window-exempt type (was: one that always goes)
create or replace function app.message_move_waiting(p_org uuid, p_except uuid, p_wait timestamptz, p_mark text,
                                                    p_channel text, p_kind text)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_resumed timestamptz;
  v_count integer;
begin
  if p_kind <> 'pause' then
    select p.resumed_at into v_resumed
      from public.org_sending_pauses p
     where p.organization_id = p_org and not p.paused and p.paused_at is not null and p.resumed_at is not null
       and p.resumed_at - p.paused_at > interval '24 hours';
  end if;
  with picked as (
    select j.id
      from app.jobs j
     where j.organization_id = p_org and j.kind = 'message.send' and j.id <> p_except
       and j.status in ('queued', 'failed') and j.next_run_at <= now()
       and (p_kind = 'pause' or j.last_error is distinct from 'waiting:sending_paused')
       and (v_resumed is null or not (j.created_at <= v_resumed and j.next_run_at <= v_resumed))
       and case p_kind
             when 'pause' then true
             when 'hours' then not app.message_window_exempt(j.payload ->> 'message_type')
                               and (j.payload ->> 'message_type') is distinct from 'meeting_reminder'
                               and j.cap_wait is null
             when 'rate' then (j.payload ->> 'channel') = p_channel
                              and not coalesce((j.payload ->> 'message_type') = any (app.service_message_types()), false)
                              and j.cap_wait is null
             when 'cap' then (j.payload ->> 'channel') = p_channel
                             and not coalesce((j.payload ->> 'message_type') = any (app.service_message_types()), false)
                             and not j.usage_counted
             else false
           end
     order by j.id
       for update of j
  ), moved as (
    update app.jobs j
       set next_run_at = p_wait, last_error = 'waiting:' || p_mark,
           cap_wait = case when p_kind = 'cap' then p_mark else j.cap_wait end
      from picked x
     where j.id = x.id
    returning 1
  )
  select count(*)::integer into v_count from moved;
  return v_count;
end;
$$;
revoke all on function app.message_move_waiting(uuid, uuid, timestamptz, text, text, text) from public, anon, authenticated, service_role;

-- public.job_message_may_send: 021204's body; SPD-04: only the window line reads app.message_window_exempt
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

  if not app.org_writable(v_job.organization_id) then
    v_reason := 'business_closed';
  elsif v_event_at is not null and v_event_at < now() then
    v_reason := 'event_passed';
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


-- ----------------------------------------------------------------------------
-- Review 3: the system's instant reply templates are fixed (lead's interim choice for (80) א); a person only switches them
-- ----------------------------------------------------------------------------
create or replace function app.message_templates_fixed_notice() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.notice_kind in ('instant_reply_open', 'instant_reply_closed') then
      raise exception 'this template is fixed' using errcode = 'P0001', hint = 'message_template:fixed_notice';
    end if;
    return old;
  end if;
  if old.notice_kind in ('instant_reply_open', 'instant_reply_closed')
     and (new.name, new.channel, new.message_type, new.subject, new.body, new.locale, new.notice_kind)
         is distinct from (old.name, old.channel, old.message_type, old.subject, old.body, old.locale, old.notice_kind) then
    raise exception 'this template is fixed' using errcode = 'P0001', hint = 'message_template:fixed_notice';
  end if;
  return new;
end;
$$;
revoke all on function app.message_templates_fixed_notice() from public, anon, authenticated;
grant execute on function app.message_templates_fixed_notice() to authenticated;

create or replace trigger message_templates_fixed_notice
  before update or delete on public.message_templates
  for each row execute function app.message_templates_fixed_notice();

-- ----------------------------------------------------------------------------
-- Server-only bookkeeping (schema app: RLS on, no grants)
-- ----------------------------------------------------------------------------
-- one row per submission that a reply was judged for (the "once" marker), with what came of it; ids and codes only
create table if not exists app.instant_replies (
  submission_id   uuid primary key,
  organization_id uuid not null,
  form_id         uuid,
  outcome         text not null check (char_length(outcome) <= 60),
  job_id          uuid,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, submission_id) references public.form_submissions (organization_id, id) on delete cascade
);
create index if not exists instant_replies_org_submission_idx on app.instant_replies (organization_id, submission_id);
alter table app.instant_replies enable row level security;
revoke all on app.instant_replies from public, anon, authenticated, service_role;

create table if not exists app.instant_reply_template_seeds (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel         text not null check (channel in ('sms', 'email')),
  seeded_at       timestamptz not null default now(),
  primary key (organization_id, channel)
);
alter table app.instant_reply_template_seeds enable row level security;
revoke all on app.instant_reply_template_seeds from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Review 1 / owner (280) ג: 200 replies a business day, one per address a business day (CAL-12's shape and lock order)
-- ----------------------------------------------------------------------------
create table if not exists app.instant_reply_days (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  day              date not null,
  queued           integer not null default 0,
  notified         boolean not null default false,
  primary key (organization_id, day)
);
alter table app.instant_reply_days enable row level security;
revoke all on app.instant_reply_days from public, anon, authenticated, service_role;

-- a bucket of the address's HMAC and its day; overwritten the next day (no address, no hash kept)
create table if not exists app.instant_reply_buckets (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  bucket           integer not null check (bucket between 0 and 65535),
  day              date not null,
  primary key (organization_id, bucket)
);
alter table app.instant_reply_buckets enable row level security;
revoke all on app.instant_reply_buckets from public, anon, authenticated, service_role;

-- 200 a business day; a transaction may lower it (tests do)
create or replace function app.instant_reply_day_cap() returns integer language sql stable set search_path = '' as $$
  select least(200, greatest(1, coalesce(nullif(current_setting('app.instant_reply_day_cap', true), '')::integer, 200)))
$$;
revoke all on function app.instant_reply_day_cap() from public, anon, authenticated, service_role;

-- Final review: the email address as the bucket key ONLY (the record is still matched on the address as typed): lower-case,
-- a "+tag" dropped from the local part, and for gmail.com / googlemail.com (one provider: googlemail becomes gmail) the dots of
-- the local part dropped. Not an address shape = the lower-cased text as it is.
create or replace function app.instant_reply_email_key(p_email text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_at integer := strpos(v_email, '@');
  v_local text;
  v_domain text;
begin
  if v_at < 2 or v_at = char_length(v_email) then
    return nullif(v_email, '');
  end if;
  v_local := left(v_email, v_at - 1);
  v_domain := substr(v_email, v_at + 1);
  if strpos(v_local, '+') > 1 then
    v_local := left(v_local, strpos(v_local, '+') - 1);
  end if;
  if v_domain = 'googlemail.com' then
    v_domain := 'gmail.com';
  end if;
  if v_domain = 'gmail.com' then
    v_local := replace(v_local, '.', '');
  end if;
  return v_local || '@' || v_domain;
end;
$$;
revoke all on function app.instant_reply_email_key(text) from public, anon, authenticated, service_role;

-- Takes one of today's places for the business and one for the address, in that order (the day row locked first, then the
-- bucket). Answers 'ok', 'day_cap' (the business's 200 are used; its owners and admins are told once that day), 'no_key' (the
-- address cannot be keyed: no consent_hash_key, fail closed) or 'address_cap' (the address had its reply today). Nothing is
-- taken unless 'ok'.
create or replace function app.instant_reply_take(p_org uuid, p_channel text, p_address text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_day date;
  v_row app.instant_reply_days;
  v_cap integer := app.instant_reply_day_cap();
  v_hash text;
  v_bucket integer;
  v_taken boolean;
begin
  select (now() at time zone app.intake_zone(o.timezone))::date into v_day from public.organizations o where o.id = p_org;
  if v_day is null then
    return 'no_key';
  end if;
  insert into app.instant_reply_days (organization_id, day, queued) values (p_org, v_day, 0)
  on conflict (organization_id, day) do nothing;
  select * into v_row from app.instant_reply_days d where d.organization_id = p_org and d.day = v_day for update;
  if v_row.queued >= v_cap then
    if not v_row.notified then
      update app.instant_reply_days d set notified = true where d.organization_id = p_org and d.day = v_day;
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      select m.organization_id, m.user_id, 'system', 'מענה מיידי ללקוחות נעצר להיום',
             format('היום יצאו %s הודעות מענה מיידי, המכסה היומית. פניות נוספות היום ייכנסו כרגיל, בלי מענה מיידי.', v_cap),
             'org_message_settings', null
        from public.memberships m
       where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
    end if;
    return 'day_cap';
  end if;
  -- final review: an email is keyed by its folded form (app.instant_reply_email_key), so +tags and gmail dots are one address
  v_hash := app.consent_address_hash(p_org, app.consent_address_kind(p_channel),
                                     case when p_channel = 'email' then app.instant_reply_email_key(p_address) else p_address end);
  if v_hash is null then
    return 'no_key';
  end if;
  -- accepted (final review): two addresses that share a bucket share its one reply a day; a collision fails toward not sending
  v_bucket := ('x' || left(md5(v_hash), 4))::bit(16)::integer;
  -- the bucket is free when it is new or last used on an earlier day
  insert into app.instant_reply_buckets as b (organization_id, bucket, day)
  values (p_org, v_bucket, v_day)
  on conflict (organization_id, bucket) do update set day = excluded.day where b.day < excluded.day
  returning true into v_taken;
  if not coalesce(v_taken, false) then
    return 'address_cap';
  end if;
  update app.instant_reply_days d set queued = d.queued + 1 where d.organization_id = p_org and d.day = v_day;
  return 'ok';
end;
$$;
revoke all on function app.instant_reply_take(uuid, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The DRAFT templates (= DEFAULT_INSTANT_REPLY_TEMPLATES): each added while the business has no template of its mark on
-- its channel and no template of its name, once per business and channel; a refused insert leaves the channel unmarked (a later try)
-- ----------------------------------------------------------------------------
create or replace function app.seed_instant_reply_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_channel text;
  v_failed boolean;
begin
  foreach v_channel in array array['sms', 'email'] loop
    continue when exists (select 1 from app.instant_reply_template_seeds s where s.organization_id = p_org and s.channel = v_channel);
    v_failed := false;
    for v_row in
      select d.* from (values
        (1, 'מענה מיידי: בשעות הפעילות (SMS)', 'sms', null::text, 'instant_reply_open',
            'שלום {שם פרטי}, קיבלנו את הפנייה שלך ל-{שם העסק}. נחזור אליך עד השעה {שעה}. {שם העסק}, {טלפון העסק}'),
        (2, 'מענה מיידי: מחוץ לשעות הפעילות (SMS)', 'sms', null::text, 'instant_reply_closed',
            'שלום {שם פרטי}, קיבלנו את הפנייה שלך ל-{שם העסק}. נחזור אליך ביום העבודה הבא עד {שעה}. {שם העסק}, {טלפון העסק}'),
        (3, 'מענה מיידי: בשעות הפעילות (אימייל)', 'email', 'קיבלנו את הפנייה שלך ל-{שם העסק}', 'instant_reply_open',
            'שלום {שם פרטי}, קיבלנו את הפנייה שלך ל-{שם העסק}. נחזור אליך עד השעה {שעה}. {שם העסק}, {טלפון העסק}'),
        (4, 'מענה מיידי: מחוץ לשעות הפעילות (אימייל)', 'email', 'קיבלנו את הפנייה שלך ל-{שם העסק}', 'instant_reply_closed',
            'שלום {שם פרטי}, קיבלנו את הפנייה שלך ל-{שם העסק}. נחזור אליך ביום העבודה הבא עד {שעה}. {שם העסק}, {טלפון העסק}')
      ) as d(n, name, channel, subject, kind, body)
       where d.channel = v_channel
       order by d.n
    loop
      begin
        if not exists (select 1 from public.message_templates t
                        where t.organization_id = p_org and t.notice_kind = v_row.kind and t.channel = v_row.channel)
           and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(v_row.name)) then
          insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind, wording_version)
          values (p_org, v_row.name, v_row.channel, 'instant_reply', v_row.subject, v_row.body, v_row.kind, 'instant-reply-draft-1');
        end if;
      exception when others then
        raise warning 'instant reply template % not seeded for business % (SQLSTATE %)', v_row.n, p_org, sqlstate;
        v_failed := true;
      end;
    end loop;
    -- final review: a refused insert (the 50-template cap) leaves the channel unmarked, so a later try can add it
    if not v_failed then
      insert into app.instant_reply_template_seeds (organization_id, channel) values (p_org, v_channel)
      on conflict (organization_id, channel) do nothing;
    end if;
  end loop;
end;
$$;
revoke all on function app.seed_instant_reply_templates(uuid) from public, anon, authenticated, service_role;

-- a web form's switch turned on (a person's insert or update, or the business default): the business gets its templates
create or replace function app.forms_instant_reply_seed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- final review: only while the business holds the instant_reply plan key
  if new.instant_reply and new.kind = 'form' and (tg_op = 'INSERT' or not old.instant_reply)
     and coalesce(app.org_has_feature(new.organization_id, 'instant_reply'), false) then
    perform app.seed_instant_reply_templates(new.organization_id);
  end if;
  return new;
end;
$$;
revoke all on function app.forms_instant_reply_seed() from public, anon, authenticated, service_role;

create or replace trigger forms_instant_reply_seed
  after insert or update of instant_reply on public.forms
  for each row execute function app.forms_instant_reply_seed();

-- ----------------------------------------------------------------------------
-- The submission that just arrived (a transaction-local setting; read and cleared by app.instant_reply_queue)
-- ----------------------------------------------------------------------------
create or replace function app.form_submissions_instant_reply() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if new.status <> 'spam' then
    perform set_config('app.instant_reply_submission', new.id::text, true);
  end if;
  return null;
end;
$$;
revoke all on function app.form_submissions_instant_reply() from public, anon, authenticated, service_role;

create or replace trigger form_submissions_instant_reply
  after insert on public.form_submissions
  for each row execute function app.form_submissions_instant_reply();

-- ----------------------------------------------------------------------------
-- The reply (see the header)
-- ----------------------------------------------------------------------------
create or replace function app.instant_reply_queue(p_org uuid, p_form uuid, p_lead uuid, p_contact uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_setting text := nullif(current_setting('app.instant_reply_submission', true), '');
  v_submission uuid;
  v_payload jsonb;
  v_typed_phone text;
  v_typed_email text;
  v_phone text;
  v_email text;
  v_deleted timestamptz;
  v_now timestamptz := now();
  v_kind text;
  v_deadline timestamptz;
  v_channels text[] := '{}';
  v_channel text;
  v_template uuid;
  v_problem text;
  v_outcome text;
  v_job uuid;
  v_inserted integer;
  v_take text;
begin
  perform set_config('app.instant_reply_submission', '', true);
  if v_setting is null or v_setting !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_submission := v_setting::uuid;
  select s.payload into v_payload from public.form_submissions s
   where s.organization_id = p_org and s.id = v_submission and s.form_id = p_form and s.status <> 'spam';
  if not found then
    return null;
  end if;
  -- a web form with the switch on
  if not exists (select 1 from public.forms f
                  where f.organization_id = p_org and f.id = p_form and f.kind = 'form' and f.instant_reply) then
    return null;
  end if;
  -- once per submission
  insert into app.instant_replies (submission_id, organization_id, form_id, outcome)
  values (v_submission, p_org, p_form, 'judging')
  on conflict (submission_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return null;
  end if;

  if not coalesce(app.org_has_feature(p_org, 'instant_reply'), false) then
    v_outcome := 'feature_off';
  elsif not coalesce(app.org_writable(p_org), false) then
    v_outcome := 'not_writable';
  elsif p_lead is null and p_contact is null then
    v_outcome := 'no_record';
  end if;

  if v_outcome is null then
    if p_lead is not null then
      select l.phone_e164, l.email, l.deleted_at into v_phone, v_email, v_deleted
        from public.leads l where l.organization_id = p_org and l.id = p_lead;
    else
      select c.phone_e164, c.email, c.deleted_at into v_phone, v_email, v_deleted
        from public.contacts c where c.organization_id = p_org and c.id = p_contact;
    end if;
    if not found or v_deleted is not null then
      v_outcome := 'no_record';
    end if;
  end if;

  if v_outcome is null then
    -- owner (80) א: only the address typed in this submission, and only while it is the record's own address
    v_typed_phone := app.normalize_phone(nullif(btrim(coalesce(v_payload ->> 'phone', '')), ''));
    v_typed_email := nullif(lower(btrim(coalesce(v_payload ->> 'email', ''))), '');
    if v_typed_email is not null and v_typed_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
      v_typed_email := null;
    end if;
    -- (b) SMS when the business has the sms key, else email
    if v_typed_phone is not null and v_phone is not null and v_typed_phone = v_phone
       and coalesce(app.org_has_feature(p_org, 'sms'), false) then
      v_channels := v_channels || 'sms'::text;
    end if;
    if v_typed_email is not null and v_email is not null and v_typed_email = lower(btrim(v_email)) then
      v_channels := v_channels || 'email'::text;
    end if;
    if cardinality(v_channels) = 0 then
      v_outcome := 'no_address';
    end if;
  end if;

  if v_outcome is null then
    -- (c) the return time: the business's response target counted in working time; the business is open now when no
    -- working time has to pass before now
    v_kind := case when app.response_deadline(p_org, v_now, 0) <= v_now then 'instant_reply_open' else 'instant_reply_closed' end;
    v_deadline := app.response_deadline(p_org, v_now, app.response_target_minutes(p_org));
    if v_deadline is null then
      v_outcome := 'no_deadline';
    end if;
  end if;

  if v_outcome is null then
    perform app.seed_instant_reply_templates(p_org);
    foreach v_channel in array v_channels loop
      select t.id into v_template from public.message_templates t
       where t.organization_id = p_org and t.channel = v_channel and t.is_active
         and t.message_type = 'instant_reply' and t.notice_kind = v_kind
       order by t.created_at, t.id
       limit 1;
      if v_template is null then
        v_outcome := coalesce(v_outcome, 'no_template');
        continue;
      end if;
      v_problem := app.message_template_sendable(p_org, v_template);
      if v_problem is not null then
        perform app.message_send_refused(p_org, v_template, v_problem);
        v_outcome := 'template:' || left(regexp_replace(v_problem, '[^a-z_]', '_', 'g'), 40);
        v_template := null;
        continue;
      end if;
      -- review 1 / owner (280) ג: 200 a business day, one per address a business day (no key = nothing); a taken address
      -- ends here, so the same person never gets the reply on another channel the same day
      v_take := app.instant_reply_take(p_org, v_channel, case when v_channel = 'email' then v_typed_email else v_typed_phone end);
      if v_take <> 'ok' then
        v_outcome := v_take;
        exit;
      end if;
      v_job := app.enqueue_job(p_org, 'message.send',
        jsonb_build_object('channel', v_channel, 'message_type', 'instant_reply', 'template_id', v_template,
                           'form_submission_id', v_submission,
                           'event_at', to_char(v_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        || case when p_lead is not null then jsonb_build_object('lead_id', p_lead) else jsonb_build_object('contact_id', p_contact) end,
        null);
      v_outcome := 'queued';
      exit;
    end loop;
  end if;

  update app.instant_replies r set outcome = v_outcome, job_id = v_job where r.submission_id = v_submission;
  return v_outcome;
end;
$$;
revoke all on function app.instant_reply_queue(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.emit_form_submitted: 021000's body plus the instant reply, in its own exception block (an inquiry never fails for it)
-- ----------------------------------------------------------------------------
create or replace function app.emit_form_submitted(p_org uuid, p_form uuid, p_submission text, p_lead uuid, p_contact uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead uuid := p_lead;
begin
  if v_lead is not null and exists (select 1 from public.leads l
                                     where l.organization_id = p_org and l.id = v_lead and l.converted_at is not null) then
    v_lead := null;
  end if;
  perform app.emit_commercial_event(p_org, 'form_submitted',
    jsonb_build_object('form_id', p_form, 'submission', p_submission),
    jsonb_build_object('lead', v_lead, 'contact', p_contact));
  -- SPD-04: the instant reply to the address typed in this submission (the lead, else the contact)
  begin
    perform app.instant_reply_queue(p_org, p_form, v_lead, case when v_lead is null then p_contact end);
  exception when others then
    raise warning 'instant reply for business % failed (SQLSTATE %)', p_org, sqlstate;
  end;
end;
$$;
revoke all on function app.emit_form_submitted(uuid, uuid, text, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The queue payload: 021224's body plus form_submission_id (SPD-04)
-- ----------------------------------------------------------------------------
create or replace function app.job_payload_ok(p_kind text, p_payload jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then false
    when p_kind = 'message.send' then
      coalesce(
        (select bool_and(k in ('channel', 'lead_id', 'contact_id', 'event_at', 'message_type', 'template_id', 'punch_card_id',
                               'meeting_id', 'deal_id', 'file_ids', 'library_file_ids',
                               'reply_to_user_id', 'sent_by_user_id', 'automation_id', 'pressed_by_user_id',
                               'sender_check_id', 'signature_document_id', 'form_submission_id'))
           from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      -- SMS-01b (owner (211) א): the code that verifies the business's sender number goes to the business's own phone, named by
      -- its check row (public.sms_sender_verify_start), never to a lead or a contact: sms, verification_code, nothing a record carries
      and (case when p_payload ? 'sender_check_id' then
             not (p_payload ? 'lead_id') and not (p_payload ? 'contact_id')
             and jsonb_typeof(p_payload -> 'sender_check_id') = 'string'
             and (p_payload ->> 'sender_check_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             and (p_payload ->> 'channel') = 'sms' and (p_payload ->> 'message_type') is not distinct from 'verification_code'
             and not (p_payload ?| array['template_id', 'punch_card_id', 'meeting_id', 'deal_id', 'event_at', 'sent_by_user_id',
                                         'automation_id', 'pressed_by_user_id', 'signature_document_id'])
           else
             -- review (7): on sms a verification code is only a sender check's
             ((p_payload ->> 'channel') <> 'sms' or (p_payload ->> 'message_type') is distinct from 'verification_code')
             and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
             and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
             and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
                 ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           end)
      -- CNS-07: the message's type, from the closed list (enqueue_job requires it; a job queued before 021147 has none and is
      -- judged as marketing)
      and (not (p_payload ? 'message_type')
           or (jsonb_typeof(p_payload -> 'message_type') = 'string'
               and (p_payload ->> 'message_type') = any (app.message_types())))
      -- MSG-02 (103): the template the message is made from, so a refusal names it
      and (not (p_payload ? 'template_id')
           or (jsonb_typeof(p_payload -> 'template_id') = 'string'
               and (p_payload ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      -- PKG-03: the punch card a punch_card_notice is about (the sender fills its name, entries and date)
      and (not (p_payload ? 'punch_card_id')
           or (jsonb_typeof(p_payload -> 'punch_card_id') = 'string'
               and (p_payload ->> 'punch_card_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      -- CAL-12: the meeting a meeting_reminder is about (the sender re-reads it and fills its date, time and location)
      and (not (p_payload ? 'meeting_id')
           or (jsonb_typeof(p_payload -> 'meeting_id') = 'string'
               and (p_payload ->> 'meeting_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      -- SGN-03 (owner (249) א): the document for signature a requested_document reminder is about (the sender re-reads it)
      and (not (p_payload ? 'signature_document_id')
           or (jsonb_typeof(p_payload -> 'signature_document_id') = 'string'
               and (p_payload ->> 'signature_document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'requested_document'))
      -- SPD-04 (owner (80) א): the form submission an instant reply answers (the sender re-reads the address typed there)
      and (not (p_payload ? 'form_submission_id')
           or (jsonb_typeof(p_payload -> 'form_submission_id') = 'string'
               and (p_payload ->> 'form_submission_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'instant_reply'
               and not (p_payload ?| array['deal_id', 'file_ids', 'library_file_ids', 'reply_to_user_id', 'sent_by_user_id',
                                           'automation_id', 'pressed_by_user_id', 'sender_check_id'])))
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
      -- EML-02: an email from a record's card: the deal it was sent from (with the deal's contact as the record), the record
      -- files attached and the person who sent it (the reply-to address), ids only and email only
      -- SMS-02: deal_id also on an SMS from a deal's card or a deal rule
      and (not (p_payload ? 'deal_id')
           or (jsonb_typeof(p_payload -> 'deal_id') = 'string'
               and (p_payload ->> 'deal_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and p_payload ? 'contact_id'))
      and (not (p_payload ? 'reply_to_user_id')
           or (jsonb_typeof(p_payload -> 'reply_to_user_id') = 'string'
               and (p_payload ->> 'reply_to_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'file_ids')
           or (jsonb_typeof(p_payload -> 'file_ids') = 'array'
               and jsonb_array_length(p_payload -> 'file_ids') between 1 and 5
               and coalesce((select bool_and(jsonb_typeof(f) = 'string'
                                             and (f #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                               from jsonb_array_elements(p_payload -> 'file_ids') f), false)
               and (select count(distinct f #>> '{}') from jsonb_array_elements(p_payload -> 'file_ids') f)
                   = jsonb_array_length(p_payload -> 'file_ids')))
      and (not (p_payload ? 'library_file_ids')
           or (jsonb_typeof(p_payload -> 'library_file_ids') = 'array'
               and jsonb_array_length(p_payload -> 'library_file_ids') between 1 and 5
               and coalesce((select bool_and(jsonb_typeof(f) = 'string'
                                             and (f #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                               from jsonb_array_elements(p_payload -> 'library_file_ids') f), false)
               and (select count(distinct f #>> '{}') from jsonb_array_elements(p_payload -> 'library_file_ids') f)
                   = jsonb_array_length(p_payload -> 'library_file_ids')))
      -- the two kinds together: at most 5 files on one email
      and (case when jsonb_typeof(p_payload -> 'file_ids') = 'array' then jsonb_array_length(p_payload -> 'file_ids') else 0 end
           + case when jsonb_typeof(p_payload -> 'library_file_ids') = 'array' then jsonb_array_length(p_payload -> 'library_file_ids') else 0 end) <= 5
      and ((not (p_payload ? 'file_ids') and not (p_payload ? 'library_file_ids') and not (p_payload ? 'reply_to_user_id'))
           or (p_payload ->> 'channel') = 'email')
      and (not (p_payload ? 'deal_id') or (p_payload ->> 'channel') in ('email', 'sms'))
      -- SMS-02: the person who sent an SMS from a card, or the rule that queued it; sms only, never both
      and (not (p_payload ? 'sent_by_user_id')
           or (jsonb_typeof(p_payload -> 'sent_by_user_id') = 'string'
               and (p_payload ->> 'sent_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'automation_id')
           or (jsonb_typeof(p_payload -> 'automation_id') = 'string'
               and (p_payload ->> 'automation_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and not ((p_payload ? 'sent_by_user_id') and (p_payload ? 'automation_id'))
      -- review (7): the person who pressed a button rule's SMS (counted in their hourly cap); only with automation_id
      and (not (p_payload ? 'pressed_by_user_id')
           or ((p_payload ? 'automation_id') and jsonb_typeof(p_payload -> 'pressed_by_user_id') = 'string'
               and (p_payload ->> 'pressed_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      -- AUT-08: sent_by_user_id stays sms only; automation_id (and so pressed_by_user_id) on sms and email
      and (not (p_payload ? 'sent_by_user_id') or (p_payload ->> 'channel') = 'sms')
      and (not (p_payload ? 'automation_id') or (p_payload ->> 'channel') in ('sms', 'email'))
      -- AUT-08: an automation's email has no reply-to person and no attachments
      and not ((p_payload ? 'automation_id') and (p_payload ?| array['reply_to_user_id', 'file_ids', 'library_file_ids']))
    -- IMP-04 (owner (155) א): the order and the person who made it, nothing else
    -- (never null: a missing key is false, not unknown, so the check constraint and enqueue_job refuse it)
    when p_kind in ('import.run', 'export.run') then
      coalesce(
        coalesce((select bool_and(k in ('request_id', 'user_id')) from jsonb_object_keys(p_payload) k), false)
        and jsonb_typeof(p_payload -> 'request_id') = 'string'
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and (p_payload ->> 'request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false)
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

