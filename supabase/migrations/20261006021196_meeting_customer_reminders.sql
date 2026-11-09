-- =============================================================================
-- CAL-12: a confirmation and reminders of a meeting to the customer, 24 hours and an hour before, by SMS or email
-- =============================================================================
-- Built behind the provider layer (MSG-01: only the fake provider exists) on the OPS-04 queue, with no new service-key
-- use, no new public page or route and no change to the four pinned queue functions (claim_jobs, finish_job,
-- job_message_may_send, app.jobs_record_message; test 284).
-- Owner's answers (DECISIONS.md, 177-182, 9 November 2026), lead's choices where noted:
-- * (178) ב plan key `meeting_reminders`: on in the plans of lead_distribution (basic, pro, business), off in personal; a
--   plan that does not hold it is off (app.plan_key_defaults(), body of meta_leads_plan, plus the key). Switching any of
--   the three settings on without the key is refused for every writer (trigger org_message_settings_meeting_key, hint
--   feature:meeting_reminders); switching off always passes. The trigger, the queue and the job send nothing for a
--   business without the key at run time.
-- * (180) א public.org_message_settings takes three switches, all OFF for every business until it turns them on, written
--   by owners/admins of a writable business through column grants (the table's policies, audited as before):
--     meeting_confirm      a confirmation when a meeting with a customer is set, and a "moved" message when it moves
--     meeting_remind_day   a reminder 24 hours before
--     meeting_remind_hour  a reminder an hour before
-- * Which meetings: planned, not a blocked time (is_block), with a customer: the meeting's live contact, else its live
--   lead (a meeting without either, an internal one, never). The channel: the customer's preferred channel when it is SMS
--   or email, else SMS, else email (WhatsApp waits for wave 4), only with an address for it (phone_e164 for SMS, email for
--   email) and an ACTIVE template of the message's mark on that channel (PKG-03's rule, app.meeting_customer_template).
-- * The message: type meeting_reminder (a SERVICE type: the send check refuses it only on the blocklist or an erasure
--   block; HEB-09's pause holds it; MSG-06's window holds it unless the meeting starts before the window opens) queued
--   through app.enqueue_job with ids and codes only: channel, contact_id | lead_id, message_type, template_id, meeting_id
--   (new optional key of app.job_payload_ok, a uuid) and event_at: the meeting's start for a reminder, and
--   least(start, now() + 2 hours) for a confirmation or a "moved" message, so one held more than 2 hours (no provider
--   yet, a pause, the window) is cancelled by the send check instead of going out late. Before queueing,
--   app.message_template_sendable judges the template; a code queues nothing and tells the owners and admins once a
--   template and reason a day (app.message_send_refused). The queue reads the meeting again FOR KEY SHARE and queues only
--   while it is still planned, not a block, at the same start with the same customer, in a writable business with the key.
-- * (182) four DRAFT texts with a wording version (app.meeting_message_wording_version() = 'meeting-draft-1', kept on the
--   seeded templates in server-only message_templates.wording_version, cleared when a person changes the text), SMS and
--   email of each, marked by server-only notice_kind: meeting_confirm (a new meeting, or planned again after a cancel),
--   meeting_moved (its start moved), meeting_day, meeting_hour. Seeded when the business first switches a meeting message
--   on while it has no template of those marks (trigger org_message_settings_seed_meeting; insert only, each on its own: a
--   name in use or the 50-template cap skips that one); mirrored by DEFAULT_MEETING_CUSTOMER_TEMPLATES. The texts hold an
--   optional part "{, ב-{מיקום}}": shown with its prefix only when the meeting has a location (fillMessage, unit-tested).
--   app.seed_punch_card_message_templates (021178's body) is redefined to read only its own two marks.
-- * Merge fields {מיקום} (the meeting's location) and {קישור} (the customer's personal link) join the closed lists
--   (app.message_merge_fields(), at the end; meeting_reminder's allowed fields in app.message_type_fields), mirrored by
--   MESSAGE_MERGE_FIELDS / SERVICE_TYPE_FIELDS. {קישור} is the system's own link, never an external one.
-- * (177) ב one click through the CAL-10b personal page (/f/book/manage/<token>):
--   - Known limit (third review, low 5): booking_manage_public (md5-pinned by test 253) does not say whether the meeting
--     was confirmed, so the page offers "confirm" again after a confirmation; a second confirm writes nothing.
--   - public.booking_manage_confirm(token, ip_hash) (service_role only, called by the existing manage route): the link,
--     the meeting locked, the pages open, a writable business, the same sender limit as cancel and change (5 per sender
--     in 10 minutes, shared with bookings); a planned meeting that has not started is confirmed: confirmed_at on its link
--     (app.booking_manage_links.confirmed_at), one `system` timeline entry (kind booking_confirmed), a booking_requests
--     row 'confirmed'; a second confirm answers the same and writes nothing. Cancel and change keep their rules.
--   - public.meeting_reminder_link(job, lease) (service_role only) mints the link a meeting message carries: only for
--     the holder of the job's LIVE lease, a message.send job of this file (its row in app.meeting_customer_messages),
--     while the meeting is still planned, not a block, at the row's start, with the job's customer, in a writable
--     business with the key, and only when the job's template (subject or body) holds {קישור} (else 'no_link_field'). A NEW token replaces the meeting's earlier one and clears its confirmation (one link per
--     meeting, only its SHA-256 kept, as booking_manage_issue; insert ... on conflict (meeting_id), so two mints at once
--     leave one row); a meeting set by staff gets a row too, with page_id = the meeting's own id (the column
--     has no foreign key; it scopes the sender limits and there is no page, so the threshold is 24 hours and no change of
--     time is offered). Answers {token} or {refused: reason}. NO ROUTE CALLS IT YET: no sender exists; it gets its own
--     "In use" line in CLAUDE.md when the sender lands.
-- * (179) א caps: at most app.meeting_customer_day_cap() = 200 meeting messages a business day (the business's zone),
--   counted in app.meeting_customer_days when queued; over it nothing is queued (outcome 'cap') and the owners and
--   admins get ONE `system` notice that day (counts only). And at most ONE confirmation per address a business day (a
--   "moved" message is not a confirmation, owner (182); the customer's own change through the link makes a new meeting,
--   whose confirmation counts): the address's HMAC (app.consent_address_hash, the consent_hash_key pattern; no key = nothing sent,
--   outcome 'no_key') picks one of 65,536 buckets per business in app.meeting_confirm_buckets, which keeps only the bucket
--   number and its day and is overwritten the next day (no address, no hash; a rare collision refuses a second customer
--   that day, the safe side): outcome 'address_cap'.
-- * Strangers' numbers (lead's rule, second review): a meeting made WITHOUT a session (meetings.created_by is null: the
--   public booking page, the customer's change link, a server job) sends nothing automatic, neither its confirmation nor
--   its reminders, until its customer is known to the business (app.meeting_customer_trusted): the lead or contact was
--   made by a person (created_by), came from an import (import_job_id), or has a person-logged contact entry
--   (last_contacted_at, the stamp_last_contact rule). A lead or contact made by booking_submit, intake_submit, a widget or
--   a card form and never touched by staff gets nothing: outcome 'untrusted'; reminders are tried again while their window
--   lasts, so a call logged by staff lets the next one go. A meeting is person-made when a person created it
--   (created_by) or a person scheduled it: server-only meetings.person_scheduled_at (no client grant), stamped by the
--   invoker BEFORE trigger meetings_person_scheduled only when current_user = 'authenticated' inserts the meeting or changes
--   its start or status. A handover (transfer_records), a merge, a conversion or a title edit never stamps it. So a staff
--   move of a publicly booked meeting sends "moved" (181); a person-made meeting sends as usual. The customer's own
--   change through the link (booking_manage_change, not redefined here) cancels the old meeting and inserts the new one
--   in one transaction under its own setting app.booking_moving: the cancel notes a person-made old meeting in the
--   transaction-local setting app.meeting_carry_from, and the new meeting of the same customer inherits it
--   (app.meeting_customer_carried). This happens only for a booking-page meeting that a person scheduled or moved (a
--   link of a meeting set by staff offers no change of time), and the carried confirmation competes for the address's
--   one confirmation of the day like any other.
--   Messages of a meeting that is NOT person-made also count per address: at most app.meeting_anon_per_address() = 3 a
--   business day per address (the confirmation, day and hour reminders of one booking), on top of the business's 200, in
--   the same buckets (third review: anyone can book with a known customer's phone).
-- * Lock order, the same on every path (the trigger and the job): the business's day row (app.meeting_customer_days),
--   then the address bucket. The job holds a business's day row until its run commits, so a confirmation that staff
--   cause in that business meanwhile waits for the run (seconds; a run is capped at 2,000 rows).
--   Accepted (fifth review): one transaction that queues a confirmation (taking the day row) and then cancels or marks
--   'replaced' another meeting's message row that the job holds can meet the job in 40P01; both trigger blocks catch every
--   error, so the worst case is a warning and one message not queued, never a failed meeting write. No staff path does
--   both in one transaction today (series inserts never cancel; merge never queues).
-- * Once per meeting, kind and start: app.meeting_customer_messages (schema app, RLS on, no grants, cascades with the
--   meeting) keeps the job id and the outcome. Confirmations and "moved" messages are queued by the AFTER trigger
--   meetings_zzz_customer_messages in the writer's transaction (on insert or planned again: confirm; a new start: moved),
--   only for a meeting outside a series or the first of its series (series_index 1), while it starts more than 15 minutes
--   ahead (lead's decision: later meetings of a series send no confirmation or "moved" message; their reminders carry the
--   time). (181) א a staff move sends "moved". The reminders are queued by pg_cron 'crm-meeting-customer-reminders' (every
--   5 minutes, app.send_meeting_customer_reminders): the day reminder from 24 to 23 hours before the start, the hour
--   reminder from 60 to 15 minutes before (a late one is skipped), not when a confirmation or "moved" message of that
--   start was queued in the last 6 hours (day) or 30 minutes (hour). Businesses take turns (app.meeting_customer_turns),
--   200 a business and 2,000 a run (a transaction may lower both), each row in its own exception block; a row that failed
--   is tried again after the fresh ones and skipped after 3 failures; 'no_template', 'template:<code>' and 'cap' are tried
--   again while the reminder's window lasts. Writable businesses with the key only.
-- * Re-planning: when a meeting's start, status or customer changes, its messages still waiting in the queue (queued or
--   failed, never one a worker holds) are cancelled ('refused:meeting_changed', counted in app.job_cancel_counts as every
--   cancellation) and their rows marked 'replaced', so the job queues the reminder again for the new start or customer
--   while the meeting qualifies; a meeting that leaves 'planned' marks every row of it replaced, so planning it again sends
--   again; a new start marks the rows of every other start replaced too, so moving back to an earlier start sends again;
--   a new start, and a meeting that leaves 'planned', clear the link's confirmation (app.booking_manage_links.confirmed_at); a deleted meeting cancels its
--   waiting messages first (BEFORE DELETE). The queue reads the meeting FOR KEY SHARE only for the moment it queues (no
--   row lock is held over the job's run): what guards a message against a meeting that changes after it was queued is
--   the cancel above, the sender's own re-check (below) and meeting_reminder_link's refusal 'meeting_changed'. A confirmation is never re-sent for a
--   changed customer alone (a merge or a conversion must not confirm twice).
-- * THE FUTURE SENDER of a meeting_reminder that carries meeting_id MUST re-read the meeting by meeting_id, scoped to the
--   job's business, and send nothing unless it is still planned, not a block, at the start its row in
--   app.meeting_customer_messages was queued for, and its customer (contact, else lead) is the payload's record; it fills
--   {תאריך} / {שעה} from that start in the business's zone, {מיקום} from the meeting's location and {קישור} from
--   public.meeting_reminder_link with its own lease (a refusal = send nothing), and it mints that link ONLY when the
--   template holds {קישור} (a mint replaces the customer's earlier link).
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The plan key: off for every plan until the owner assigns it
-- ----------------------------------------------------------------------------
-- (178) ב: the plans of lead_distribution hold it (the delta pattern of meta_leads_plan; no subscription or override is
-- touched)
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": {}, "features": { "meeting_reminders": false } },
  "basic": { "limits": {}, "features": { "meeting_reminders": true } },
  "pro": { "limits": {}, "features": { "meeting_reminders": true } },
  "business": { "limits": {}, "features": { "meeting_reminders": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- the value of a wave 2 key that a plan does not hold: the most restrictive (meta_leads_plan's body plus meeting_reminders)
create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": false,
    "price_lists": false,
    "discounts": false,
    "quotes": false,
    "orders": false,
    "documents": false,
    "payments": false,
    "balances": false,
    "collection": false,
    "money_waiting": false,
    "consents": false,
    "segments": false,
    "goals": false,
    "granular_permissions": false,
    "booking_page": false,
    "business_card": false,
    "qr_codes": false,
    "site_widget": false,
    "retention": false,
    "remove_built_with": false,
    "payment_links": false,
    "instant_reply": false,
    "auto_reassign": false,
    "dashboards": false,
    "goals_per_rep": false,
    "booking_team_pages": false,
    "lead_distribution": false,
    "campaign_costs": false,
    "punch_cards": false,
    "meta_leads": false,
    "meeting_reminders": false
  },
  "limits": {
    "max_products": 0,
    "max_price_lists": 0,
    "max_quote_templates": 0,
    "max_booking_pages": 0,
    "max_booking_pages_per_user": 0,
    "max_segments": 0,
    "max_qr_codes": 0,
    "max_pdf_per_month": 0,
    "max_customer_emails_per_month": 0,
    "max_customer_emails_per_day": 0,
    "max_custom_reports": 0,
    "max_custom_objects": 0,
    "max_teams": 0,
    "max_whatsapp_numbers": 0,
    "view_seats_per_paid_seat": 0,
    "max_site_widgets": 0,
    "max_business_cards_per_user": 0,
    "max_booking_team_pages": 0,
    "ai_credits_per_month": 0,
    "ai_credits_per_user_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- Any other plan (the hidden free plan, a plan added in the admin panel) gets the key off; a plan's own value is kept.
update public.plans p
   set features = jsonb_build_object('meeting_reminders', false) || coalesce(p.features, '{}'::jsonb)
 where not (coalesce(p.features, '{}'::jsonb) ? 'meeting_reminders');

-- ----------------------------------------------------------------------------
-- The business's switches
-- ----------------------------------------------------------------------------
alter table public.org_message_settings add column if not exists meeting_confirm boolean not null default false;
alter table public.org_message_settings add column if not exists meeting_remind_day boolean not null default false;
alter table public.org_message_settings add column if not exists meeting_remind_hour boolean not null default false;
grant insert (meeting_confirm, meeting_remind_day, meeting_remind_hour) on public.org_message_settings to authenticated;
grant update (meeting_confirm, meeting_remind_day, meeting_remind_hour) on public.org_message_settings to authenticated;

-- ----------------------------------------------------------------------------
-- The closed lists: {מיקום} and {קישור}
-- ----------------------------------------------------------------------------
create or replace function app.message_merge_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'תאריך', 'שעה', 'מסמך', 'סכום', 'מועד תשלום', 'קישור להצעה',
               'טלפון העסק', 'כתובת העסק', 'תוקף', 'תוכן העדכון', 'קישור הסרה', 'קוד אימות', 'שם הכרטיסייה', 'כניסות',
               'מיקום', 'קישור']::text[]
$$;
revoke all on function app.message_merge_fields() from public, anon, authenticated;
-- the table's check trigger runs as the writer (a person)
grant execute on function app.message_merge_fields() to authenticated;

-- The merge fields a service type may hold; null for a type that is not a service type. Mirrors SERVICE_TYPE_FIELDS.
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
  end
$$;
revoke all on function app.message_type_fields(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The queue payload: an optional meeting_id (background_jobs' rule plus the key)
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
                               'meeting_id'))
           from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
      and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
      and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
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

-- ----------------------------------------------------------------------------
-- The templates the meeting messages are sent from
-- ----------------------------------------------------------------------------
alter table public.message_templates
  drop constraint if exists message_templates_notice_kind_check,
  add constraint message_templates_notice_kind_check
    check (notice_kind is null or notice_kind in ('punch_card_low', 'punch_card_expiry',
                                                  'meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour'));

-- (182) the version of the default wording a template was seeded with; server only (no client grant), cleared when a
-- person changes its subject or body (the text is then the business's own)
alter table public.message_templates add column if not exists wording_version text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'message_templates_wording_version_shape' and conrelid = 'public.message_templates'::regclass) then
    alter table public.message_templates add constraint message_templates_wording_version_shape
      check (wording_version is null or wording_version ~ '^[a-z0-9-]{1,40}$');
  end if;
end;
$$;

create or replace function app.meeting_message_wording_version() returns text
language sql immutable
set search_path = ''
as $$ select 'meeting-draft-1'::text $$;
revoke all on function app.meeting_message_wording_version() from public, anon, authenticated, service_role;

create or replace function app.message_templates_wording_version() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subject is distinct from old.subject or new.body is distinct from old.body then
    new.wording_version := null;
  end if;
  return new;
end;
$$;
revoke all on function app.message_templates_wording_version() from public, anon, authenticated, service_role;
create or replace trigger message_templates_wording_version before update of subject, body on public.message_templates
  for each row execute function app.message_templates_wording_version();

-- (182) DRAFT wording until the lawyer edits it (version app.meeting_message_wording_version()). Each is added while
-- the business has no template of its mark on its channel and no template of its name; each insert on its own, so the
-- 50-template cap skips only that one.
create or replace function app.seed_meeting_customer_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select d.* from (values
      (1, 'פגישה: אישור (SMS)', 'sms', 'meeting_reminder', null::text,
          'שלום {שם פרטי}, נקבעה לך פגישה עם {שם העסק} ב-{תאריך} בשעה {שעה}{, ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}', 'meeting_confirm'),
      (2, 'פגישה: אישור (אימייל)', 'email', 'meeting_reminder', 'נקבעה לך פגישה עם {שם העסק}',
          'שלום {שם פרטי}, נקבעה לך פגישה עם {שם העסק} ב-{תאריך} בשעה {שעה}{, ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}', 'meeting_confirm'),
      (3, 'פגישה: תזכורת יום לפני (SMS)', 'sms', 'meeting_reminder', null::text,
          'תזכורת: מחר, {תאריך} בשעה {שעה}, פגישה עם {שם העסק}{ ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}', 'meeting_day'),
      (4, 'פגישה: תזכורת יום לפני (אימייל)', 'email', 'meeting_reminder', 'תזכורת: פגישה מחר עם {שם העסק}',
          'תזכורת: מחר, {תאריך} בשעה {שעה}, פגישה עם {שם העסק}{ ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}', 'meeting_day'),
      (5, 'פגישה: תזכורת שעה לפני (SMS)', 'sms', 'meeting_reminder', null::text,
          'הפגישה שלך עם {שם העסק} מתחילה בשעה {שעה}{, ב-{מיקום}}. {שם העסק}, {טלפון העסק}', 'meeting_hour'),
      (6, 'פגישה: תזכורת שעה לפני (אימייל)', 'email', 'meeting_reminder', 'הפגישה שלך עם {שם העסק} מתחילה בשעה {שעה}',
          'הפגישה שלך עם {שם העסק} מתחילה בשעה {שעה}{, ב-{מיקום}}. {שם העסק}, {טלפון העסק}', 'meeting_hour'),
      (7, 'פגישה: מועד חדש (SMS)', 'sms', 'meeting_reminder', null::text,
          'הפגישה שלך עם {שם העסק} עברה ל-{תאריך} בשעה {שעה}{, ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}', 'meeting_moved'),
      (8, 'פגישה: מועד חדש (אימייל)', 'email', 'meeting_reminder', 'הפגישה שלך עם {שם העסק} עברה למועד חדש',
          'הפגישה שלך עם {שם העסק} עברה ל-{תאריך} בשעה {שעה}{, ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}', 'meeting_moved')
    ) as d(n, name, channel, message_type, subject, body, notice_kind)
     where not exists (select 1 from public.message_templates t
                        where t.organization_id = p_org and t.notice_kind = d.notice_kind and t.channel = d.channel)
       and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(d.name))
     order by d.n
  loop
    begin
      insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind, wording_version)
      values (p_org, v_row.name, v_row.channel, v_row.message_type, v_row.subject, v_row.body, v_row.notice_kind,
              app.meeting_message_wording_version());
    exception when others then
      raise warning 'meeting message template % not seeded for business % (SQLSTATE %)', v_row.n, p_org, sqlstate;
    end;
  end loop;
end;
$$;
revoke all on function app.seed_meeting_customer_templates(uuid) from public, anon, authenticated, service_role;

-- Seeded when the business first switches a meeting message on (and has no template of either mark), so a business that
-- never uses them gets nothing in its list; a deleted one is not brought back while another of the marks is there.
create or replace function app.org_message_settings_seed_meeting() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard first (the table's policies already let the write through)
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return null;
  end if;
  if (new.meeting_confirm or new.meeting_remind_day or new.meeting_remind_hour)
     and not exists (select 1 from public.message_templates t
                      where t.organization_id = new.organization_id
                        and t.notice_kind in ('meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour')) then
    begin
      perform app.seed_meeting_customer_templates(new.organization_id);
    exception when others then
      raise warning 'meeting message templates were not seeded for business % (SQLSTATE %)', new.organization_id, sqlstate;
    end;
  end if;
  return null;
end;
$$;
revoke all on function app.org_message_settings_seed_meeting() from public, anon, authenticated, service_role;

create or replace trigger org_message_settings_seed_meeting
  after insert or update of meeting_confirm, meeting_remind_day, meeting_remind_hour on public.org_message_settings
  for each row execute function app.org_message_settings_seed_meeting();

-- PKG-03's seed (021178's body) reads only its own two marks: a business's meeting templates are neither "a marked
-- template" for it nor a row of app.punch_card_template_seeds (whose check holds the two punch card marks only)
create or replace function app.seed_punch_card_message_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_none boolean;
  v_row record;
  v_failed text[] := '{}'::text[];
begin
  if not coalesce(app.org_has_feature(p_org, 'punch_cards'), false) then
    return;
  end if;
  -- what the business holds counts as seeded (021177's backfill, or a template it kept)
  insert into app.punch_card_template_seeds (organization_id, notice_kind)
  select distinct p_org, t.notice_kind from public.message_templates t
   where t.organization_id = p_org and t.notice_kind in ('punch_card_low', 'punch_card_expiry')
  on conflict do nothing;
  v_none := not exists (select 1 from public.message_templates t
                         where t.organization_id = p_org and t.notice_kind in ('punch_card_low', 'punch_card_expiry'));
  for v_row in
    select d.name, d.channel, d.message_type, d.body, d.notice_kind
      from (values
        (1, 'כרטיסייה: נשארו מעט כניסות', 'sms', 'punch_card_notice',
            'שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} {כניסות}. לפרטים: {טלפון העסק}. {שם העסק}', 'punch_card_low'),
        (2, 'כרטיסייה: התוקף מתקרב', 'sms', 'punch_card_notice',
            'שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} התוקף עד {תאריך}. לפרטים: {טלפון העסק}. {שם העסק}', 'punch_card_expiry')
      ) as d(n, name, channel, message_type, body, notice_kind)
     where (v_none or not exists (select 1 from app.punch_card_template_seeds s
                                   where s.organization_id = p_org and s.notice_kind = d.notice_kind))
       -- a business that already has a template of this name keeps it (names are unique ignoring case)
       and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(d.name))
     order by d.n
  loop
    begin
      insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind)
      values (p_org, v_row.name, v_row.channel, v_row.message_type, null, v_row.body, v_row.notice_kind);
      insert into app.punch_card_template_seeds (organization_id, notice_kind)
      values (p_org, v_row.notice_kind)
      on conflict (organization_id, notice_kind) do update set seeded_at = excluded.seeded_at;
    exception when others then
      -- the 50-template cap, most likely: tried again on a later day
      v_failed := v_failed || (v_row.notice_kind || ' ' || sqlstate);
    end;
  end loop;
  if cardinality(v_failed) > 0 then
    -- one line per business and try (re-review finding 4)
    raise warning 'punch card templates not seeded for business %: %', p_org, array_to_string(v_failed, ', ');
  end if;
end;
$$;
revoke all on function app.seed_punch_card_message_templates(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The key gates the switches
-- ----------------------------------------------------------------------------
-- Switching a meeting message ON needs the plan key, for every writer; switching off, and every other column, always
-- passes. Outsiders are left to the table's policies (RLS refuses them; nothing is told).
create or replace function app.org_message_settings_meeting_key() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_on boolean;
begin
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_on := new.meeting_confirm or new.meeting_remind_day or new.meeting_remind_hour;
  else
    v_on := (new.meeting_confirm and not old.meeting_confirm)
            or (new.meeting_remind_day and not old.meeting_remind_day)
            or (new.meeting_remind_hour and not old.meeting_remind_hour);
  end if;
  if v_on and not coalesce(app.org_has_feature(new.organization_id, 'meeting_reminders'), false) then
    raise exception 'meeting messages to customers are not in the plan' using errcode = 'P0001', hint = 'feature:meeting_reminders';
  end if;
  return new;
end;
$$;
revoke all on function app.org_message_settings_meeting_key() from public, anon, authenticated, service_role;

create or replace trigger org_message_settings_meeting_key
  before insert or update of meeting_confirm, meeting_remind_day, meeting_remind_hour on public.org_message_settings
  for each row execute function app.org_message_settings_meeting_key();

-- ----------------------------------------------------------------------------
-- Once per meeting, kind and start; the daily cap
-- ----------------------------------------------------------------------------
create table if not exists app.meeting_customer_messages (
  organization_id  uuid not null,
  meeting_id       uuid not null,
  kind             text not null,
  starts_at        timestamptz not null,
  -- queued = a job was made (job_id); no_template = no channel with an address and an active template; template:<code> =
  -- the template could not be sent (the owners were told); cap = the business's daily cap was reached; address_cap = the
  -- address had its one confirmation today; no_key = the address could not be keyed (no consent_hash_key); untrusted =
  -- a meeting made without a session for a customer the business never touched; failed = the
  -- attempt raised (tried again, at most 3 times); replaced = its waiting job was cancelled because the meeting changed
  -- (the job may queue it again)
  outcome          text not null,
  job_id           uuid,
  failures         integer not null default 0,
  last_attempt_at  timestamptz,
  created_at       timestamptz not null default now(),
  primary key (meeting_id, kind, starts_at),
  foreign key (organization_id, meeting_id) references public.meetings (organization_id, id) on delete cascade,
  constraint meeting_customer_messages_kind check (kind in ('confirm', 'moved', 'day', 'hour')),
  constraint meeting_customer_messages_outcome
    check (outcome ~ '^(queued|no_template|failed|replaced|cap|address_cap|no_key|untrusted|template:[a-z_]{1,40})$')
);
create index if not exists meeting_customer_messages_meeting_idx on app.meeting_customer_messages (organization_id, meeting_id);
alter table app.meeting_customer_messages enable row level security;
revoke all on app.meeting_customer_messages from public, anon, authenticated, service_role;

create table if not exists app.meeting_customer_turns (
  organization_id  uuid primary key references public.organizations (id) on delete cascade,
  served_at        timestamptz not null default now()
);
alter table app.meeting_customer_turns enable row level security;
revoke all on app.meeting_customer_turns from public, anon, authenticated, service_role;

-- how many meeting messages a business queued on a business day, and whether its owners were told the cap was reached
create table if not exists app.meeting_customer_days (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  day              date not null,
  queued           integer not null default 0,
  notified         boolean not null default false,
  primary key (organization_id, day)
);
alter table app.meeting_customer_days enable row level security;
revoke all on app.meeting_customer_days from public, anon, authenticated, service_role;

-- (179) one confirmation per address a business day: a bucket of the address's HMAC and its day;
-- overwritten the next day (no address, no hash kept)
create table if not exists app.meeting_confirm_buckets (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  bucket           integer not null check (bucket between 0 and 65535),
  day              date not null,
  -- that day's confirmations (at most 1) and messages of meetings that are not person-made (at most 3)
  confirms         integer not null default 0 check (confirms between 0 and 1),
  anon_sent        integer not null default 0 check (anon_sent between 0 and 3),
  primary key (organization_id, bucket)
);

create or replace function app.meeting_anon_per_address() returns integer language sql immutable set search_path = '' as $$ select 3 $$;
revoke all on function app.meeting_anon_per_address() from public, anon, authenticated, service_role;

-- (third review, low 2) a new meeting the customer's own change made inherits a person-made old meeting
create table if not exists app.meeting_customer_carried (
  organization_id  uuid not null,
  meeting_id       uuid not null primary key,
  from_meeting_id  uuid not null,
  created_at       timestamptz not null default now(),
  foreign key (organization_id, meeting_id) references public.meetings (organization_id, id) on delete cascade
);
create index if not exists meeting_customer_carried_meeting_idx on app.meeting_customer_carried (organization_id, meeting_id);
alter table app.meeting_customer_carried enable row level security;
revoke all on app.meeting_customer_carried from public, anon, authenticated, service_role;
alter table app.meeting_confirm_buckets enable row level security;
revoke all on app.meeting_confirm_buckets from public, anon, authenticated, service_role;

-- the scan of the reminder job: planned meetings with a customer, by start
create index if not exists meetings_customer_due_idx on public.meetings (starts_at)
  where status = 'planned' and not is_block and (contact_id is not null or lead_id is not null);

create or replace function app.meeting_customer_per_org() returns integer language sql stable set search_path = '' as $$
  select least(200, greatest(1, coalesce(nullif(current_setting('app.meeting_customer_per_org', true), '')::integer, 200)))
$$;
create or replace function app.meeting_customer_limit() returns integer language sql stable set search_path = '' as $$
  select least(2000, greatest(1, coalesce(nullif(current_setting('app.meeting_customer_limit', true), '')::integer, 2000)))
$$;
-- 200 a business day; a transaction may lower it (tests do)
create or replace function app.meeting_customer_day_cap() returns integer language sql stable set search_path = '' as $$
  select least(200, greatest(1, coalesce(nullif(current_setting('app.meeting_customer_day_cap', true), '')::integer, 200)))
$$;
revoke all on function app.meeting_customer_per_org() from public, anon, authenticated, service_role;
revoke all on function app.meeting_customer_limit() from public, anon, authenticated, service_role;
revoke all on function app.meeting_customer_day_cap() from public, anon, authenticated, service_role;

-- The business's day row, locked (the first lock of every path; see the header).
create or replace function app.meeting_customer_lock_day(p_org uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_day date;
begin
  select (now() at time zone app.intake_zone(o.timezone))::date into v_day from public.organizations o where o.id = p_org;
  if v_day is null then
    return;
  end if;
  insert into app.meeting_customer_days (organization_id, day, queued) values (p_org, v_day, 0)
  on conflict (organization_id, day) do nothing;
  perform 1 from app.meeting_customer_days d where d.organization_id = p_org and d.day = v_day for update;
end;
$$;
revoke all on function app.meeting_customer_lock_day(uuid) from public, anon, authenticated, service_role;

-- Takes one of today's places (the business's zone). Over the cap: false, and the owners and admins are told once that day.
create or replace function app.meeting_customer_take_day(p_org uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_day date;
  v_taken boolean;
  v_cap integer := app.meeting_customer_day_cap();
begin
  select (now() at time zone app.intake_zone(o.timezone))::date into v_day from public.organizations o where o.id = p_org;
  if v_day is null then
    return false;
  end if;
  insert into app.meeting_customer_days as d (organization_id, day, queued)
  values (p_org, v_day, 1)
  on conflict (organization_id, day) do update set queued = d.queued + 1 where d.queued < v_cap
  returning true into v_taken;
  if coalesce(v_taken, false) then
    return true;
  end if;
  update app.meeting_customer_days d set notified = true
   where d.organization_id = p_org and d.day = v_day and not d.notified;
  if found then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    select m.organization_id, m.user_id, 'system', 'הודעות פגישה ללקוחות נעצרו להיום',
           format('היום יצאו %s הודעות על פגישות ללקוחות, המכסה היומית. הודעות נוספות לא יישלחו היום.', v_cap),
           'org_message_settings', null
      from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
  end if;
  return false;
end;
$$;
revoke all on function app.meeting_customer_take_day(uuid) from public, anon, authenticated, service_role;

-- Takes one of an address's places today: a confirmation takes the day's one confirmation; a message of a meeting that is
-- not person-made (p_anon) also takes one of the day's 3. Answers 'ok', 'address_cap' (nothing taken) or 'no_key' (the
-- address cannot be keyed: no consent_hash_key, fail closed).
create or replace function app.meeting_customer_take_address(p_org uuid, p_channel text, p_contact uuid, p_lead uuid,
                                                             p_confirm boolean, p_anon boolean)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_value text;
  v_hash text;
  v_bucket integer;
  v_day date;
  v_row app.meeting_confirm_buckets;
begin
  if p_contact is not null then
    select case when p_channel = 'email' then lower(btrim(c.email)) else c.phone_e164 end into v_value
      from public.contacts c where c.organization_id = p_org and c.id = p_contact;
  else
    select case when p_channel = 'email' then lower(btrim(l.email)) else l.phone_e164 end into v_value
      from public.leads l where l.organization_id = p_org and l.id = p_lead;
  end if;
  v_hash := app.consent_address_hash(p_org, app.consent_address_kind(p_channel), v_value);
  if v_hash is null then
    return 'no_key';
  end if;
  v_bucket := ('x' || left(md5(v_hash), 4))::bit(16)::integer;
  select (now() at time zone app.intake_zone(o.timezone))::date into v_day from public.organizations o where o.id = p_org;
  -- the bucket of today, a new day starting from nothing
  insert into app.meeting_confirm_buckets as b (organization_id, bucket, day)
  values (p_org, v_bucket, v_day)
  on conflict (organization_id, bucket) do update set day = excluded.day, confirms = 0, anon_sent = 0 where b.day < excluded.day;
  select * into v_row from app.meeting_confirm_buckets b where b.organization_id = p_org and b.bucket = v_bucket for update;
  if (p_confirm and v_row.confirms >= 1) or (p_anon and v_row.anon_sent >= app.meeting_anon_per_address()) then
    return 'address_cap';
  end if;
  update app.meeting_confirm_buckets b
     set confirms = b.confirms + case when p_confirm then 1 else 0 end,
         anon_sent = b.anon_sent + case when p_anon then 1 else 0 end
   where b.organization_id = p_org and b.bucket = v_bucket;
  return 'ok';
end;
$$;
revoke all on function app.meeting_customer_take_address(uuid, text, uuid, uuid, boolean, boolean) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The customer, the channel and the template
-- ----------------------------------------------------------------------------
-- The meeting's live contact, else its live lead; its preferred channel when SMS or email, then SMS, then email; only with
-- an address (phone_e164 for SMS, email for email) and an active meeting_reminder template of the mark on that channel
-- (the oldest when there are several). No row = nothing to send.
create or replace function app.meeting_customer_template(p_org uuid, p_contact uuid, p_lead uuid, p_notice text)
returns table (template_id uuid, channel text, contact_id uuid, lead_id uuid)
language sql stable security definer
set search_path = ''
as $$
  with customer as (
    select c.id as contact_id, null::uuid as lead_id, c.preferred_channel, c.phone_e164, c.email
      from public.contacts c
     where p_contact is not null and c.organization_id = p_org and c.id = p_contact and c.deleted_at is null
    union all
    select null::uuid, l.id, l.preferred_channel, l.phone_e164, l.email
      from public.leads l
     where p_lead is not null and l.organization_id = p_org and l.id = p_lead and l.deleted_at is null
       and not exists (select 1 from public.contacts c
                        where p_contact is not null and c.organization_id = p_org and c.id = p_contact and c.deleted_at is null)
  )
  select t.id, t.channel, cu.contact_id, cu.lead_id
    from customer cu
    cross join lateral (
      select ch, ord from (values (cu.preferred_channel, 0), ('sms', 1), ('email', 2)) v(ch, ord)
       where ch in ('sms', 'email')
    ) o
    join public.message_templates t
      on t.organization_id = p_org and t.channel = o.ch and t.is_active
     and t.message_type = 'meeting_reminder' and t.notice_kind = p_notice
   where nullif(btrim(case when o.ch = 'email' then cu.email else cu.phone_e164 end), '') is not null
   order by o.ord, t.created_at, t.id
   limit 1
$$;
revoke all on function app.meeting_customer_template(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- Is the meeting's customer (its live contact, else its live lead) known to the business: made by a person, imported, or
-- with a person-logged contact entry? (see the header: a stranger's number gets nothing automatic)
create or replace function app.meeting_customer_trusted(p_org uuid, p_contact uuid, p_lead uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select c.created_by is not null or c.import_job_id is not null or c.last_contacted_at is not null
       from public.contacts c
      where p_contact is not null and c.organization_id = p_org and c.id = p_contact and c.deleted_at is null),
    (select l.created_by is not null or l.import_job_id is not null or l.last_contacted_at is not null
       from public.leads l
      where p_lead is not null and l.organization_id = p_org and l.id = p_lead and l.deleted_at is null),
    false)
$$;
revoke all on function app.meeting_customer_trusted(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Queues one message of a meeting (kind confirm | moved | day | hour) for its current start, once. The meeting is read again FOR
-- KEY SHARE and must still be planned, not a block, at this start with this customer, in a writable business with the
-- key; then the row is taken (one that failed, was replaced, had no template, a template code or the cap is taken
-- again); answers the outcome, or null when nothing was done.
create or replace function app.meeting_customer_queue(p_org uuid, p_meeting uuid, p_kind text, p_starts_at timestamptz,
                                                      p_contact uuid, p_lead uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_still boolean;
  v_made_by boolean;
  v_person boolean;
  v_taken boolean;
  v_template uuid;
  v_channel text;
  v_contact uuid;
  v_lead uuid;
  v_problem text;
  v_outcome text;
  v_job uuid;
  v_event timestamptz;
  v_address text;
begin
  select true, (m.created_by is not null or m.person_scheduled_at is not null) into v_still, v_made_by
    from public.meetings m
   where m.organization_id = p_org and m.id = p_meeting
     and m.status = 'planned' and not m.is_block and m.starts_at = p_starts_at
     and m.contact_id is not distinct from p_contact and m.lead_id is not distinct from p_lead
   for key share;
  if not coalesce(v_still, false) or not app.org_writable(p_org)
     or not coalesce(app.org_has_feature(p_org, 'meeting_reminders'), false) then
    return null;
  end if;
  -- person-made: created or updated by a person, or carried from such a meeting by the customer's own change
  v_person := coalesce(v_made_by, false)
              or exists (select 1 from app.meeting_customer_carried c where c.organization_id = p_org and c.meeting_id = p_meeting);
  insert into app.meeting_customer_messages as r (organization_id, meeting_id, kind, starts_at, outcome, last_attempt_at)
  values (p_org, p_meeting, p_kind, p_starts_at, 'failed', now())
  on conflict (meeting_id, kind, starts_at) do update set last_attempt_at = excluded.last_attempt_at
    where (r.outcome in ('failed', 'replaced', 'no_template', 'cap', 'untrusted') or r.outcome like 'template:%') and r.failures < 3
  returning true into v_taken;
  if not coalesce(v_taken, false) then
    return null;
  end if;
  select mt.template_id, mt.channel, mt.contact_id, mt.lead_id into v_template, v_channel, v_contact, v_lead
    from app.meeting_customer_template(p_org, p_contact, p_lead, 'meeting_' || p_kind) mt;
  if not v_person and not app.meeting_customer_trusted(p_org, p_contact, p_lead) then
    -- a meeting made without a session, for a customer the business never touched
    v_outcome := 'untrusted';
  elsif v_template is null then
    v_outcome := 'no_template';
  else
    v_problem := app.message_template_sendable(p_org, v_template);
    if v_problem is not null then
      -- the template cannot be sent as it is: the owners and admins are told (once a template and reason a day)
      perform app.message_send_refused(p_org, v_template, v_problem);
      v_outcome := 'template:' || left(regexp_replace(v_problem, '[^a-z_]', '_', 'g'), 40);
    else
      -- the business's day row first, then the address bucket (one lock order on every path)
      perform app.meeting_customer_lock_day(p_org);
      -- (179) one confirmation per address a day, before the business's daily count is taken (a "moved" message is not
      -- a confirmation: owner (182))
      if p_kind = 'confirm' or not v_person then
        v_address := app.meeting_customer_take_address(p_org, v_channel, v_contact, v_lead, p_kind = 'confirm', not v_person);
      end if;
      if v_address is not null and v_address <> 'ok' then
        v_outcome := v_address;
      elsif not app.meeting_customer_take_day(p_org) then
        v_outcome := 'cap';
      end if;
    end if;
    if v_outcome is null then
      -- a reminder ends with the meeting; a confirmation not sent within 2 hours is cancelled by the send check
      v_event := case when p_kind in ('confirm', 'moved') then least(p_starts_at, now() + interval '2 hours') else p_starts_at end;
      -- see the header: the future sender re-reads the meeting by meeting_id and sends only while it still matches
      v_job := app.enqueue_job(
        p_org, 'message.send',
        jsonb_build_object('channel', v_channel, 'message_type', 'meeting_reminder', 'template_id', v_template,
                           'meeting_id', p_meeting,
                           'event_at', to_char(v_event at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        || case when v_contact is not null then jsonb_build_object('contact_id', v_contact)
                else jsonb_build_object('lead_id', v_lead) end);
      v_outcome := 'queued';
    end if;
  end if;
  update app.meeting_customer_messages r set outcome = v_outcome, job_id = v_job
   where r.meeting_id = p_meeting and r.kind = p_kind and r.starts_at = p_starts_at;
  return v_outcome;
end;
$$;
revoke all on function app.meeting_customer_queue(uuid, uuid, text, timestamptz, uuid, uuid) from public, anon, authenticated, service_role;

-- Cancels a meeting's messages still waiting in the queue (queued or failed; a job a worker holds is left alone) and marks
-- their rows 'replaced'; counted in app.job_cancel_counts as 'meeting_changed'. p_all: every row of the meeting is marked
-- replaced too (the meeting left 'planned'), so planning it again sends again. Answers how many jobs were cancelled.
create or replace function app.meeting_customer_cancel(p_org uuid, p_meeting uuid, p_all boolean default false) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with taken as (
    select j.id from app.jobs j
      join app.meeting_customer_messages r on r.job_id = j.id
     where r.meeting_id = p_meeting and r.organization_id = p_org and r.outcome = 'queued'
       and j.organization_id = p_org and j.kind = 'message.send' and j.status in ('queued', 'failed')
     order by j.id
     for update of j skip locked
  ), cancelled as (
    update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                          last_error = 'refused:meeting_changed'
      from taken t
     where j.id = t.id
    returning j.id
  ), marked as (
    update app.meeting_customer_messages r set outcome = 'replaced', failures = 0
      from cancelled c
     where r.job_id = c.id and r.meeting_id = p_meeting
    returning 1
  )
  select count(*)::integer into v_count from marked;
  if v_count > 0 then
    insert into app.job_cancel_counts (organization_id, reason, pending)
    values (p_org, 'meeting_changed', v_count)
    on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + excluded.pending;
  end if;
  if p_all then
    update app.meeting_customer_messages r set outcome = 'replaced', failures = 0
     where r.organization_id = p_org and r.meeting_id = p_meeting and r.outcome <> 'replaced';
  end if;
  return v_count;
end;
$$;
revoke all on function app.meeting_customer_cancel(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A person scheduled the meeting (fourth review): server only, stamped for a signed-in person's insert or move
-- ----------------------------------------------------------------------------
alter table public.meetings add column if not exists person_scheduled_at timestamptz;
-- no client grant: a client neither writes nor clears it; the select grant is table-wide

create or replace function app.meetings_person_scheduled() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and (tg_op = 'INSERT' or new.starts_at is distinct from old.starts_at or new.status is distinct from old.status) then
    new.person_scheduled_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.meetings_person_scheduled() from public, anon, authenticated, service_role;

create or replace trigger meetings_person_scheduled before insert or update of starts_at, status on public.meetings
  for each row execute function app.meetings_person_scheduled();

-- ----------------------------------------------------------------------------
-- The meeting's triggers: the confirmation, and re-planning on change
-- ----------------------------------------------------------------------------
create or replace function app.meetings_customer_messages() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_moved boolean := true;
  v_replanned boolean := false;
  v_customer_changed boolean := false;
begin
  -- outsider guard first (RLS already let the write through; nothing is told to anyone else)
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return null;
  end if;
  -- (third review, low 2) the customer's own change: the new meeting of the same customer, inserted under
  -- app.booking_moving, inherits the person-made old one the cancel just noted
  if tg_op = 'INSERT' and coalesce(current_setting('app.booking_moving', true), '') = 'on'
     and coalesce(current_setting('app.meeting_carry_from', true), '') <> '' then
    begin
      insert into app.meeting_customer_carried (organization_id, meeting_id, from_meeting_id)
      select new.organization_id, new.id, o.id
        from public.meetings o
       where o.organization_id = new.organization_id
         and o.id = (current_setting('app.meeting_carry_from', true))::uuid
         and o.contact_id is not distinct from new.contact_id and o.lead_id is not distinct from new.lead_id
      on conflict (meeting_id) do nothing;
    exception when others then
      raise warning 'meeting customer messages: meeting % inherited nothing (SQLSTATE %)', new.id, sqlstate;
    end;
  end if;
  if tg_op = 'UPDATE' then
    v_moved := new.starts_at is distinct from old.starts_at;
    v_replanned := old.status is distinct from 'planned' and new.status = 'planned';
    v_customer_changed := new.contact_id is distinct from old.contact_id or new.lead_id is distinct from old.lead_id;
    if v_moved or v_customer_changed or new.status is distinct from old.status then
      begin
        perform app.meeting_customer_cancel(new.organization_id, new.id,
                                            old.status = 'planned' and new.status is distinct from 'planned');
        if v_moved then
          -- the rows of every other start may be queued again (moving back sends again)
          update app.meeting_customer_messages r set outcome = 'replaced', failures = 0
           where r.organization_id = new.organization_id and r.meeting_id = new.id
             and r.starts_at <> new.starts_at and r.outcome <> 'replaced';
        end if;
        if v_moved or (old.status = 'planned' and new.status is distinct from 'planned') then
          -- the customer confirms anew
          update app.booking_manage_links l set confirmed_at = null
           where l.organization_id = new.organization_id and l.meeting_id = new.id and l.confirmed_at is not null;
        end if;
        if old.status = 'planned' and new.status is distinct from 'planned' and auth.uid() is null
           and (new.created_by is not null or new.person_scheduled_at is not null
                or exists (select 1 from app.meeting_customer_carried c
                            where c.organization_id = new.organization_id and c.meeting_id = new.id)) then
          -- a server cancel of a person-made meeting (the customer's change cancels first, then books): noted for this
          -- transaction only
          perform set_config('app.meeting_carry_from', new.id::text, true);
        end if;
      exception when others then
        raise warning 'meeting customer messages: the waiting messages of meeting % were not cancelled (SQLSTATE %)', new.id, sqlstate;
      end;
    end if;
  end if;
  -- a new meeting or planned again: a confirmation; a new start: a "moved" message (owner (182)); outside a series or its
  -- first meeting only; never for a changed customer alone
  if (v_moved or v_replanned) and new.status = 'planned' and not new.is_block
     and (new.contact_id is not null or new.lead_id is not null)
     and new.starts_at > now() + interval '15 minutes'
     and (new.series_id is null or new.series_index = 1) then
    begin
      -- (a meeting made without a session is judged by the queue: app.meeting_customer_trusted)
      if exists (select 1 from public.org_message_settings s
                  where s.organization_id = new.organization_id and s.meeting_confirm) then
        perform app.meeting_customer_queue(new.organization_id, new.id,
                                           case when tg_op = 'UPDATE' and v_moved then 'moved' else 'confirm' end,
                                           new.starts_at, new.contact_id, new.lead_id);
      end if;
    exception when others then
      -- never fails the meeting's write; one line, the meeting id and SQLSTATE only
      raise warning 'meeting customer messages: the confirmation of meeting % was not queued (SQLSTATE %)', new.id, sqlstate;
    end;
  end if;
  return null;
end;
$$;
revoke all on function app.meetings_customer_messages() from public, anon, authenticated, service_role;

-- named to run after the other AFTER triggers of meetings (meetings_zz_order_draft included)
create or replace trigger meetings_zzz_customer_messages after insert or update of starts_at, status, contact_id, lead_id
  on public.meetings
  for each row execute function app.meetings_customer_messages();

create or replace function app.meetings_customer_messages_gone() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- the business itself is going (its jobs go with it)
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  begin
    perform app.meeting_customer_cancel(old.organization_id, old.id);
  exception when others then
    raise warning 'meeting customer messages: the waiting messages of meeting % were not cancelled (SQLSTATE %)', old.id, sqlstate;
  end;
  return old;
end;
$$;
revoke all on function app.meetings_customer_messages_gone() from public, anon, authenticated, service_role;

create or replace trigger meetings_customer_messages_gone before delete on public.meetings
  for each row execute function app.meetings_customer_messages_gone();

-- ----------------------------------------------------------------------------
-- The reminders: pg_cron every 5 minutes
-- ----------------------------------------------------------------------------
create or replace function app.send_meeting_customer_reminders(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_outcome text;
  v_done integer := 0;
  v_state text;
  v_served uuid[] := '{}'::uuid[];
begin
  for v_row in
    with due as (
      select m.organization_id, m.id as meeting_id, m.starts_at, k.kind, m.contact_id, m.lead_id,
             r.last_attempt_at, coalesce(r.failures, 0) as failures
        from public.meetings m
        join public.org_message_settings s on s.organization_id = m.organization_id
        cross join lateral (values ('day', interval '24 hours', interval '23 hours', interval '6 hours'),
                                   ('hour', interval '60 minutes', interval '15 minutes', interval '30 minutes'))
                   k(kind, from_before, until_before, after_confirm)
        left join app.meeting_customer_messages r on r.meeting_id = m.id and r.kind = k.kind and r.starts_at = m.starts_at
       where m.status = 'planned' and not m.is_block and (m.contact_id is not null or m.lead_id is not null)
         and m.starts_at > now() and m.starts_at <= now() + interval '24 hours'
         and m.starts_at - k.from_before <= now() and m.starts_at - k.until_before > now()
         and ((k.kind = 'day' and s.meeting_remind_day) or (k.kind = 'hour' and s.meeting_remind_hour))
         and (p_orgs is null or m.organization_id = any (p_orgs))
         -- fresh, or tried again while the window lasts (a raised attempt at most 3 times)
         and (r.meeting_id is null
              or ((r.outcome in ('failed', 'replaced', 'no_template', 'cap', 'untrusted') or r.outcome like 'template:%') and r.failures < 3))
         -- a confirmation of this start queued a moment ago says the same
         and not exists (select 1 from app.meeting_customer_messages c
                          where c.meeting_id = m.id and c.kind in ('confirm', 'moved') and c.starts_at = m.starts_at
                            and c.outcome = 'queued' and c.created_at > now() - k.after_confirm)
         and app.org_writable(m.organization_id)
         and coalesce(app.org_has_feature(m.organization_id, 'meeting_reminders'), false)
    ), ranked as (
      select d.*, tn.served_at,
             -- fresh rows first, then the ones tried before (fewest failures first), so failing rows never starve the rest
             row_number() over (partition by d.organization_id
                                order by d.last_attempt_at nulls first, d.failures, d.starts_at, d.meeting_id, d.kind) as n
        from due d
        left join app.meeting_customer_turns tn on tn.organization_id = d.organization_id
    )
    select * from ranked
     where n <= app.meeting_customer_per_org()
     -- businesses take turns: every business's first row, then every business's second, ...; the one served longest ago first
     order by n, served_at nulls first, organization_id
     limit app.meeting_customer_limit()
  loop
    if not (v_row.organization_id = any (v_served)) then
      v_served := v_served || v_row.organization_id;
    end if;
    begin
      v_outcome := app.meeting_customer_queue(v_row.organization_id, v_row.meeting_id, v_row.kind, v_row.starts_at,
                                              v_row.contact_id, v_row.lead_id);
      if v_outcome = 'queued' then
        v_done := v_done + 1;
      end if;
    exception when others then
      v_state := sqlstate;
      -- counted, tried again on a later run after the fresh ones; one line, the meeting id and SQLSTATE only
      begin
        insert into app.meeting_customer_messages as r (organization_id, meeting_id, kind, starts_at, outcome, failures, last_attempt_at)
        values (v_row.organization_id, v_row.meeting_id, v_row.kind, v_row.starts_at, 'failed', 1, now())
        on conflict (meeting_id, kind, starts_at)
          do update set outcome = 'failed', failures = r.failures + 1, last_attempt_at = excluded.last_attempt_at;
      exception when others then
        null;
      end;
      raise warning 'crm-meeting-customer-reminders: meeting % (%) failed (SQLSTATE %)', v_row.meeting_id, v_row.kind, v_state;
    end;
  end loop;

  insert into app.meeting_customer_turns (organization_id, served_at)
  select o, clock_timestamp() from unnest(v_served) o
  on conflict (organization_id) do update set served_at = excluded.served_at;
  return v_done;
end;
$$;
revoke all on function app.send_meeting_customer_reminders(uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (177) ב the customer's one click: "confirm" on the CAL-10b personal page
-- ----------------------------------------------------------------------------
alter table app.booking_manage_links add column if not exists confirmed_at timestamptz;
alter table app.booking_requests
  drop constraint if exists booking_requests_outcome_check,
  add constraint booking_requests_outcome_check
    check (outcome in ('booked', 'spam', 'refused', 'invalid', 'cancelled', 'changed', 'confirmed'));

-- The customer confirms the meeting: allowed until it starts (no threshold: confirming changes nothing for the business's
-- calendar); the sender limit of cancel and change (5 per sender in 10 minutes, shared with bookings). Once: a second
-- confirm answers the same and writes nothing.
create or replace function public.booking_manage_confirm(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.booking_manage_links;
  v_sender text;
  v_meeting public.meetings;
  v_zone text;
begin
  v_link := app.booking_manage_link(p_token);
  v_sender := app.booking_sender(v_link.page_id, p_ip_hash);
  select * into v_meeting from public.meetings m
   where m.organization_id = v_link.organization_id and m.id = v_link.meeting_id
   for update;
  if v_meeting.id is null or not app.org_public_pages_open(v_meeting.organization_id) then
    raise exception 'booking link not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_meeting.organization_id) then
    raise exception 'booking is not available' using errcode = 'P0001', hint = 'booking:unavailable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('booking_submit:' || v_link.page_id::text, 0));
  if v_sender is not null and (
    select count(*) from app.booking_requests r
     where r.page_id = v_link.page_id and r.ip_hash = v_sender and r.created_at > now() - interval '10 minutes'
  ) >= 5 then
    raise exception 'too many attempts' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if v_link.confirmed_at is not null and v_meeting.status = 'planned' then
    return jsonb_build_object('status', 'confirmed');
  end if;
  if v_meeting.status <> 'planned' or v_meeting.starts_at <= now() then
    raise exception 'the meeting cannot be confirmed' using errcode = 'P0001', hint = 'booking:confirm_closed';
  end if;
  update app.booking_manage_links l set confirmed_at = now() where l.token_hash = v_link.token_hash;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_meeting.organization_id;
  if v_meeting.lead_id is not null or v_meeting.contact_id is not null then
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (v_meeting.organization_id, 'system',
            'הלקוח אישר בקישור האישי את הפגישה של ' || to_char(v_meeting.starts_at at time zone v_zone, 'DD.MM.YYYY HH24:MI') || '.',
            v_meeting.lead_id, v_meeting.contact_id,
            jsonb_build_object('kind', 'booking_confirmed', 'meeting_id', v_meeting.id));
  end if;
  insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
  values (v_link.page_id, v_link.organization_id, v_sender, 'confirmed');
  return jsonb_build_object('status', 'confirmed');
end;
$$;
revoke all on function public.booking_manage_confirm(text, text) from public, anon, authenticated;
grant execute on function public.booking_manage_confirm(text, text) to service_role;

-- The link a meeting message carries: minted for the holder of the job's live lease, while the message still describes
-- the meeting; a new token replaces the meeting's earlier one. Answers {token} or {refused: reason}; changes nothing on
-- a refusal. NO ROUTE CALLS IT YET (no sender exists): its "In use" line comes with the sender.
create or replace function public.meeting_reminder_link(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_row app.meeting_customer_messages;
  v_meeting public.meetings;
  v_contact uuid;
  v_lead uuid;
  v_token text;
  v_hash text;
begin
  select * into v_job from app.jobs j where j.id = p_job for share;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  select * into v_row from app.meeting_customer_messages r
   where r.job_id = v_job.id and r.organization_id = v_job.organization_id;
  if v_row.meeting_id is null or (v_job.payload ->> 'meeting_id') is distinct from v_row.meeting_id::text then
    return jsonb_build_object('refused', 'not_a_meeting_message');
  end if;
  select * into v_meeting from public.meetings m
   where m.organization_id = v_row.organization_id and m.id = v_row.meeting_id
   for key share;
  select mt.contact_id, mt.lead_id into v_contact, v_lead
    from (select c.id as contact_id, null::uuid as lead_id from public.contacts c
           where c.organization_id = v_meeting.organization_id and c.id = v_meeting.contact_id and c.deleted_at is null
          union all
          select null, l.id from public.leads l
           where l.organization_id = v_meeting.organization_id and l.id = v_meeting.lead_id and l.deleted_at is null
             and not exists (select 1 from public.contacts c
                              where c.organization_id = v_meeting.organization_id and c.id = v_meeting.contact_id
                                and c.deleted_at is null)) mt;
  -- a row the meeting's change marked replaced is a message that no longer describes it
  if v_row.outcome <> 'queued' or v_meeting.id is null or v_meeting.status <> 'planned' or v_meeting.is_block
     or v_meeting.starts_at <> v_row.starts_at
     or v_meeting.starts_at <= now()
     or (v_job.payload ->> 'contact_id') is distinct from v_contact::text
     or (v_job.payload ->> 'lead_id') is distinct from v_lead::text then
    return jsonb_build_object('refused', 'meeting_changed');
  end if;
  if not app.org_writable(v_meeting.organization_id) or not app.org_public_pages_open(v_meeting.organization_id)
     or not coalesce(app.org_has_feature(v_meeting.organization_id, 'meeting_reminders'), false) then
    return jsonb_build_object('refused', 'business');
  end if;
  -- only a message whose template carries the link (a mint replaces the customer's earlier link)
  if not exists (select 1 from public.message_templates t
                  where t.organization_id = v_meeting.organization_id and t.id::text = (v_job.payload ->> 'template_id')
                    and (strpos(coalesce(t.subject, ''), '{קישור}') > 0 or strpos(t.body, '{קישור}') > 0)) then
    return jsonb_build_object('refused', 'no_link_field');
  end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_hash := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');
  -- one row per meeting; a meeting set by staff has no page: its own id scopes the link's limits (see the header). A new
  -- token clears the earlier confirmation.
  insert into app.booking_manage_links as l (token_hash, organization_id, meeting_id, page_id)
  values (v_hash, v_meeting.organization_id, v_meeting.id, v_meeting.id)
  on conflict (meeting_id) do update set token_hash = excluded.token_hash, created_at = now(), confirmed_at = null;
  return jsonb_build_object('token', v_token);
end;
$$;
revoke all on function public.meeting_reminder_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.meeting_reminder_link(uuid, uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-meeting-customer-reminders', '*/5 * * * *', 'select app.send_meeting_customer_reminders();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
