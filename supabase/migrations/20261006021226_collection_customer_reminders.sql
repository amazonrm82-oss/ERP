-- =============================================================================
-- COL-07: collection reminders to the customer, by SMS or email, from Hebrew templates, stopped when the debt is paid
-- =============================================================================
-- SPEC-ADDITIONS COL-07: "Collection reminders are sent automatically to the customer by email or SMS (WhatsApp from wave
-- 4), from Hebrew templates, and stop when the debt is paid." No new plan key: the job runs only where COL-04's does
-- (app.collection_reminder_orgs: writable, with collection, documents and payments); SMS also needs `sms`.
-- Owner's answers (11 November 2026, recorded in DECISIONS.md by the lead):
--   (255) א off for every business until an owner or admin turns it on: org_document_settings.collection_customer_reminder
--       (default false; owners/admins through column grants, the table's own policies; audited by its audit trigger);
--   (256) ג the business chooses the stages: org_document_settings.collection_customer_stages, a subset of COL-04's offsets
--       (-3, 0, +7, +14 days from the due date, moved to a working day by app.collection_reminder_at); default 0, +7 and
--       +14, not -3. A stage not chosen sends nothing (outcome 'stage_off');
--   (257) ד the channel: the contact's preferred channel (CON-10 contacts.preferred_channel) when it is SMS or email and its
--       address exists (SMS also needs the plan's `sms`), else SMS (with `sms` and phone_e164), else email; the first of
--       them with an active template;
--   (258) ב the rep's task (COL-04, HEB-09's paused line included) is made only when no message to the customer was queued
--       for that stage (switch off, stage not chosen, no customer, no address, no template, a refused template, a failure,
--       and since the second review also customer sending paused, no worker in the last day, every usable channel blocked),
--       and always at the last stage (+14). A stage that queues a message leaves an earlier open task as it is.
--
-- * app.send_collection_reminders: the exact body of 021135 with only the lines marked "COL-07": a call of
--   app.cancel_settled_collection_messages first (in its own block), and, for a stage with a balance, first
--   app.collection_customer_message (its own block inside; a failure is recorded as 'failed'), then 021135's task lines
--   inside the condition of (258). The outcome is kept on the stage's own row of app.collection_reminders_sent (new columns
--   customer_outcome, customer_job_id, customer_checked_at), so a stage queues at most one message per document, due date
--   and stage, and a stage recorded while the switch was off is never sent later (switching on does not send a backlog).
-- * The customer: the document's contact, else its deal's contact, live (not in the bin). A company's document (an opening
--   balance on a company, or a deal with no contact) has no person: outcome 'no_customer'. No address on the chosen channel's
--   fallback either: 'no_address'. No usable template: 'no_template'. A template the service rule refuses: 'template:<code>'
--   and one notice to the owners and admins (app.message_send_refused).
-- * The message: an OPS-04 `message.send` job (app.enqueue_job; ids and codes only): channel, contact_id, message_type
--   'collection' (a service type: the queue's send check applies the blocklist and erasure blocks, HEB-09's pause, MSG-06's
--   sending hours and rates, and on SMS the plan's `sms` key and SMS quota), template_id and the new optional key
--   collection_document_id (app.job_payload_ok, 021225's rule plus that key: collection only, with a contact, SMS or email).
--   The four md5-pinned queue functions (test 284) are unchanged.
-- * Templates: two DRAFT templates (SMS and email) of type collection, server-only mark notice_kind 'collection_reminder'
--   and wording version 'collection-draft-1', added to a business the first time the job reaches it with the switch on
--   (app.seed_collection_reminder_templates; once per business and channel in app.collection_template_seeds, so a deleted
--   one is not brought back; an insert the 50-template cap refuses is recorded as done, with one warning, and the stage
--   makes only the task). = DEFAULT_COLLECTION_CUSTOMER_TEMPLATES. Their fields are the collection type's own closed list
--   (app.message_type_fields: first and full name, rep, business name, phone and address, document, amount, due date), so
--   app.message_notice_fields stays as it is; no link. A template with a notice_kind is already refused on every person's
--   and rule's send path and hidden from their pickers (021218).
-- * Each message is valid until the next stage's day begins in the business zone (that stage's calendar day moved to a
--   working day, as app.collection_reminder_at), the last stage (+14) for 7 days from its own day: that moment is the job's
--   event_at, so a message held past it (SMS off or over the quota, a pause, closed hours) is cancelled by the queue's own
--   send check. A stage that queues also cancels the document's earlier messages still waiting (refused:superseded), so
--   stages never pile up and arrive together.
-- * Stop when the debt is paid: app.cancel_settled_collection_messages (first step of the job) judges every stage row still
--   marked 'queued' (a partial index holds only those), at most app.collection_reminder_limit() a run, the longest unchecked
--   first (customer_checked_at). A job the queue finished gives the row its final outcome (sent, dead, cancelled); a job
--   still waiting is judged by app.collection_customer_refusal and cancelled with its reason, counted in
--   app.job_cancel_counts: reminder_off (switch off or settings row gone), business_off (not writable, or the plan lost
--   collection, documents or payments), debt_settled (document gone, not active, a proforma billed by an active tax
--   invoice, held by a promise, or no balance by public.money_allocation_state), customer_changed (the payload's contact is
--   no longer the document's live contact or its deal's live contact). All cancelling goes through
--   app.collection_customer_cancel (waiting jobs only, skip locked; a claimed job is left to the worker).
-- * Switching off, or removing the settings row (review 2; not while the business itself is deleted), cancels the
--   business's customer messages still waiting: refused:reminder_off; switching on again does not queue them again.
-- * Third review 1: (a) SMS is chosen only while the plan's `sms` flag is on and its month quota has room
--   (app.collection_sms_room, the reading of public.job_message_may_send without changing it); otherwise email, and with no
--   email either the outcome is 'quota' (a phone the plan's SMS cannot reach now) and the task is made. (b) A message that
--   never went out (held past its event_at and cancelled by the sweep, refused by the queue's own send check, or dead) gets
--   the stage's rep task after all, once, through app.collection_stage_task (021135's task lines, moved there unchanged and
--   called by the job too) while the debt still is (app.collection_stage_task_backstop: the job's own conditions). No task
--   for superseded, debt_settled, reminder_off, stage_off, customer_changed or business_off.
--   Final review: never when a later stage of the same document and due date was already handled; a backstop that raises
--   puts the row back to 'queued' (tried again by the next sweep) and counts in customer_task_failures; after 3 the row
--   ends 'failed' with one warning line (document id and SQLSTATE), as the job skips a document after 3 failures.
-- * Accepted: 'no_provider' is judged per job kind (app.job_kind_seen 'message.send'), not per channel: claim_jobs is
--   md5-pinned and keeps no time per channel, so a worker that claims only email lets an SMS be queued (it then expires and
--   the backstop makes the task).
-- * Accepted: a manual run of app.send_collection_reminders beside the cron run can end in 40P01 on the same rows; each
--   document's inner block catches it (one warning line) and the row is tried again on a later run.
-- * Accepted: a stage whose customer message failed (outcome 'failed', one warning line with the document id and SQLSTATE)
--   is not tried again; the rep's task of that stage is made all the same and the next stage tries again. A failure here
--   is a fault in this code or the queue's payload rule, not a passing condition, so a retry would fail the same way.
-- * THE FUTURE SENDER of a `collection` message that carries collection_document_id MUST, right before it sends, ask
--   app.collection_customer_refusal(job's business, collection_document_id, payload contact_id, the stage's offset_days
--   from app.collection_reminders_sent by customer_job_id) and send nothing unless it
--   answers null (the switch on, the business writable with the three keys, the document still owed and not held, still the
--   payload contact's); it fills {סכום} from the document's balance at
--   send time (never the amount at queuing), {מסמך} from the type and number and {מועד תשלום} from the due date in the
--   business zone. It needs its own "In use" line in CLAUDE.md when it lands.
-- * What this file adds over the newest bodies it starts from (rebased onto 021223-021225):
--   - app.job_payload_ok: 021225's body (AUT-08's automation_id / email lines, SPD-04's form_submission_id block) with three
--     changes only: collection_document_id in the list of allowed keys, in the list a sender check may not carry, and its own
--     block (a uuid, message_type collection, with contact_id, channel email or sms).
--   - message_templates_notice_kind_check: 021225's list (signature_reminder, instant_reply_open, instant_reply_closed and the
--     earlier marks) plus 'collection_reminder', replaced in one `alter table ... drop constraint if exists ..., add
--     constraint ...` statement, so a database that holds 021225's constraint gets the new list.
--   - app.send_collection_reminders: 021135's body (021223-021225 do not redefine it) with the lines marked COL-07; its task
--     lines moved unchanged into app.collection_stage_task.
--   - Nothing else this file defines is redefined by 021223-021225; it calls app.message_template_sendable,
--     app.consent_service_blocked, app.customer_sending_paused, app.sms_plan_quota and app.enqueue_job as they stand.
-- Every statement is safe to run twice. No statement starts with drop, no row removal. The `alter table ... drop
-- constraint if exists` re-adds message_templates_notice_kind_check with one more value.

-- ----------------------------------------------------------------------------
-- The switch (lead's choice (a): off until an owner or admin turns it on)
-- ----------------------------------------------------------------------------
alter table public.org_document_settings add column if not exists collection_customer_reminder boolean not null default false;
grant select (collection_customer_reminder) on public.org_document_settings to authenticated;
grant insert (collection_customer_reminder) on public.org_document_settings to authenticated;
grant update (collection_customer_reminder) on public.org_document_settings to authenticated;

-- owner (256) ג: the stages that go to the customer, days from the due date (COL-04's offsets); default the due date, +7 and
-- +14, not the reminder 3 days before
alter table public.org_document_settings add column if not exists collection_customer_stages smallint[] not null default '{0,7,14}';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_document_settings_collection_customer_stages_check'
                    and conrelid = 'public.org_document_settings'::regclass) then
    alter table public.org_document_settings add constraint org_document_settings_collection_customer_stages_check
      check (collection_customer_stages <@ array[-3, 0, 7, 14]::smallint[] and array_position(collection_customer_stages, null) is null);
  end if;
end;
$$;
grant select (collection_customer_stages) on public.org_document_settings to authenticated;
grant insert (collection_customer_stages) on public.org_document_settings to authenticated;
grant update (collection_customer_stages) on public.org_document_settings to authenticated;

-- ----------------------------------------------------------------------------
-- The templates' mark
-- ----------------------------------------------------------------------------
alter table public.message_templates
  drop constraint if exists message_templates_notice_kind_check,
  add constraint message_templates_notice_kind_check
    check (notice_kind is null or notice_kind in ('punch_card_low', 'punch_card_expiry',
                                                  'meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour',
                                                  'signature_reminder', 'instant_reply_open', 'instant_reply_closed',
                                                  'collection_reminder'));

-- ----------------------------------------------------------------------------
-- Server-only bookkeeping (schema app: RLS on, no grants)
-- ----------------------------------------------------------------------------
-- the stage's customer message, on the stage's own row (one per document, due date and stage)
alter table app.collection_reminders_sent add column if not exists customer_outcome text;
alter table app.collection_reminders_sent add column if not exists customer_job_id uuid;
-- when the sweep last judged the row's waiting message (the longest unchecked first)
alter table app.collection_reminders_sent add column if not exists customer_checked_at timestamptz;
-- final review 2: failed tries of the backstop task (after 3 the row ends 'failed', as the job skips a document after 3)
alter table app.collection_reminders_sent add column if not exists customer_task_failures integer not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'collection_reminders_sent_customer_task_failures_check'
                    and conrelid = 'app.collection_reminders_sent'::regclass) then
    alter table app.collection_reminders_sent add constraint collection_reminders_sent_customer_task_failures_check
      check (customer_task_failures >= 0);
  end if;
end;
$$;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'collection_reminders_sent_customer_outcome_check'
                    and conrelid = 'app.collection_reminders_sent'::regclass) then
    alter table app.collection_reminders_sent add constraint collection_reminders_sent_customer_outcome_check
      check (customer_outcome is null
             or customer_outcome in ('queued', 'failed', 'no_customer', 'no_address', 'no_template',
                                     'sent', 'dead', 'cancelled', 'superseded', 'stage_off', 'paused', 'no_provider',
                                     'blocked', 'quota')
             or customer_outcome ~ '^template:[a-z_]{1,40}$');
  end if;
end;
$$;
create index if not exists collection_reminders_sent_customer_job_idx on app.collection_reminders_sent (customer_job_id)
  where customer_job_id is not null;
create index if not exists collection_reminders_sent_customer_queued_idx on app.collection_reminders_sent (organization_id)
  where customer_outcome = 'queued';

-- the reminder templates added to a business, once per channel (a deleted one is not brought back)
create table if not exists app.collection_template_seeds (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel         text not null check (channel in ('sms', 'email')),
  seeded_at       timestamptz not null default now(),
  primary key (organization_id, channel)
);
alter table app.collection_template_seeds enable row level security;
revoke all on app.collection_template_seeds from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The queue payload: an optional collection_document_id (021225's rule plus the key)
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
                               'sender_check_id', 'signature_document_id', 'form_submission_id',
                               'collection_document_id'))
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
                                         'automation_id', 'pressed_by_user_id', 'signature_document_id',
                                         'collection_document_id'])
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
      -- COL-07: the debt document a collection reminder to the customer is about (the sender re-reads it); collection only,
      -- on a contact, by SMS or email
      and (not (p_payload ? 'collection_document_id')
           or (jsonb_typeof(p_payload -> 'collection_document_id') = 'string'
               and (p_payload ->> 'collection_document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'collection'
               and p_payload ? 'contact_id'
               and (p_payload ->> 'channel') in ('email', 'sms')))
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

-- ----------------------------------------------------------------------------
-- The templates (DRAFT wording until the lawyer edits it; = DEFAULT_COLLECTION_CUSTOMER_TEMPLATES)
-- ----------------------------------------------------------------------------
-- Each is added while the business has no template of its mark on its channel and no template of its name, once per
-- business and channel, each on its own: an insert the 50-template cap (or anything else) refuses is recorded as done all
-- the same, with one warning, so it is never tried again on every run; the business adds the template by hand if it wants it.
create or replace function app.seed_collection_reminder_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select d.* from (values
      (1, 'גבייה: תזכורת ללקוח (SMS)', 'sms', null::text,
          'שלום {שם פרטי}, תזכורת מ-{שם העסק}: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה. לפרטים: {טלפון העסק}'),
      (2, 'גבייה: תזכורת ללקוח (אימייל)', 'email', 'תזכורת לתשלום מ-{שם העסק}',
          'שלום {שם פרטי}, תזכורת מ-{שם העסק}: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה. לפרטים: {טלפון העסק}')
    ) as d(n, name, channel, subject, body)
     where not exists (select 1 from app.collection_template_seeds s where s.organization_id = p_org and s.channel = d.channel)
     order by d.n
  loop
    begin
      if not exists (select 1 from public.message_templates t
                      where t.organization_id = p_org and t.notice_kind = 'collection_reminder' and t.channel = v_row.channel)
         and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(v_row.name)) then
        insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind, wording_version)
        values (p_org, v_row.name, v_row.channel, 'collection', v_row.subject, v_row.body, 'collection_reminder',
                'collection-draft-1');
      end if;
      insert into app.collection_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    exception when others then
      raise warning 'collection reminder template % not seeded for business % (SQLSTATE %)', v_row.n, p_org, sqlstate;
      insert into app.collection_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    end;
  end loop;
end;
$$;
revoke all on function app.seed_collection_reminder_templates(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Cancelling one waiting customer message (review: the one place that does it)
-- ----------------------------------------------------------------------------
-- The job, only while still waiting (queued or failed; a claimed job is left to the worker), skip locked: refused:<reason>,
-- counted in app.job_cancel_counts, and its stage row gets its final outcome. Answers whether it cancelled.
create or replace function app.collection_customer_cancel(p_org uuid, p_job uuid, p_reason text, p_outcome text default 'cancelled')
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select j.id into v_id from app.jobs j
   where j.id = p_job and j.organization_id = p_org and j.kind = 'message.send' and j.status in ('queued', 'failed')
   for update skip locked;
  if v_id is null then
    return false;
  end if;
  update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                        last_error = 'refused:' || p_reason
   where j.id = v_id;
  insert into app.job_cancel_counts (organization_id, reason, pending)
  values (p_org, p_reason, 1)
  on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + 1;
  update app.collection_reminders_sent r set customer_outcome = p_outcome, customer_checked_at = now()
   where r.customer_job_id = v_id and r.organization_id = p_org;
  return true;
end;
$$;
revoke all on function app.collection_customer_cancel(uuid, uuid, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Whether a waiting customer message may still go (the sweep's rule; the future sender asks it too)
-- ----------------------------------------------------------------------------
-- null = it may; else the reason: reminder_off (the switch is off or its row is gone), business_off (not writable, or the
-- plan lost collection, documents or payments), debt_settled (the document is gone, not active, a proforma billed by an
-- active tax invoice, held by a promise, or has no balance), customer_changed (the payload's contact is no longer the
-- document's customer: its own contact, else its deal's contact, live); stage_off (second review 5: the stage p_offset is no
-- longer among the business's chosen stages; p_offset null = not judged).
create or replace function app.collection_customer_refusal(p_org uuid, p_document uuid, p_contact uuid, p_offset integer)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.accounting_documents;
  v_current uuid;
  v_balance bigint;
  v_on boolean;
  v_stages smallint[];
begin
  select s.collection_customer_reminder, s.collection_customer_stages into v_on, v_stages
    from public.org_document_settings s where s.organization_id = p_org;
  if not coalesce(v_on, false) then
    return 'reminder_off';
  end if;
  if p_offset is not null and not (p_offset = any (coalesce(v_stages, '{}'::smallint[]))) then
    return 'stage_off';
  end if;
  if not exists (select 1 from app.collection_reminder_orgs(array[p_org]) o) then
    return 'business_off';
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = p_org and d.id = p_document;
  if not found or v_doc.status <> 'active'
     or (v_doc.doc_type = 'proforma'
         and exists (select 1 from public.accounting_documents i
                      where i.organization_id = p_org and i.proforma_id = v_doc.id and i.status = 'active'))
     or app.collection_held_until(p_org, v_doc.id) is not null then
    return 'debt_settled';
  end if;
  select coalesce((x ->> 'balance')::bigint, 0) into v_balance
    from jsonb_array_elements(public.money_allocation_state(p_org, array[v_doc.id], '{}'::uuid[]) -> 'documents') x
   where (x ->> 'id')::uuid = v_doc.id;
  if coalesce(v_balance, 0) <= 0 then
    return 'debt_settled';
  end if;
  if v_doc.contact_id is not null then
    select c.id into v_current from public.contacts c
     where c.organization_id = p_org and c.id = v_doc.contact_id and c.deleted_at is null;
  elsif v_doc.deal_id is not null then
    select c.id into v_current
      from public.deals dl
      join public.contacts c on c.organization_id = dl.organization_id and c.id = dl.contact_id and c.deleted_at is null
     where dl.organization_id = p_org and dl.id = v_doc.deal_id and dl.deleted_at is null;
  end if;
  if v_current is null or v_current is distinct from p_contact then
    return 'customer_changed';
  end if;
  return null;
end;
$$;
revoke all on function app.collection_customer_refusal(uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Second review 1: is a message expected to go out at all? A worker asked for message jobs in the last day (the queue keeps
-- the time per kind in app.job_kind_seen; claim_jobs, md5-pinned, keeps no time per channel, so this is per kind)
-- ----------------------------------------------------------------------------
create or replace function app.collection_message_worker_seen() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.job_kind_seen s
                  where s.kind = 'message.send' and s.last_claimed_at > now() - interval '1 day')
$$;
revoke all on function app.collection_message_worker_seen() from public, anon, authenticated, service_role;

-- Third review 1 (a): may an SMS go this month at all? The plan's `sms` flag and its month quota (max_sms_per_month through
-- app.sms_plan_quota; null = no limit) against app.sms_quota_months for the business's month: the reading
-- public.job_message_may_send makes (021204; md5-pinned by test 284 and not changed here). A message queued now that the queue
-- would hold over the quota would end unsent, so such an SMS is not chosen.
create or replace function app.collection_sms_room(p_org uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_cap integer;
  v_used integer;
  v_today date;
begin
  if not coalesce(app.org_has_feature(p_org, 'sms'), false) then
    return false;
  end if;
  v_cap := app.sms_plan_quota(p_org);
  if v_cap is null then
    return true;
  end if;
  select (now() at time zone app.intake_zone(o.timezone))::date into v_today from public.organizations o where o.id = p_org;
  select coalesce(max(m.used), 0) into v_used
    from app.sms_quota_months m
   where m.organization_id = p_org and m.month = date_trunc('month', v_today)::date;
  return coalesce(v_used, 0) < v_cap;
end;
$$;
revoke all on function app.collection_sms_room(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- One stage's message to the customer (lead's choices (b) and (c))
-- ----------------------------------------------------------------------------
-- No row = the switch is off (nothing recorded on the stage). Otherwise one row: the outcome and the queued job.
-- Review 1: the message is valid until the next stage's day begins in the business zone (that stage's calendar day moved to
-- a working day, app.add_business_days(.., 0), as app.collection_reminder_at), the last stage for 7 days from its own day;
-- that moment is the job's event_at, so a message held past it (sms_off, over_cap, a pause) is cancelled by the queue's own
-- send check. And a stage that queues cancels the document's earlier messages still waiting (refused:superseded).
-- Second review 1: under (258) "queued" means "expected to go out", so nothing is queued (and the rep's task is made) while
-- the business's customer sending is paused (HEB-09, outcome 'paused'), while no worker asked for message jobs in the last
-- day ('no_provider'), or when every channel with an address and an active template is service-blocked for that address
-- (app.consent_service_blocked; cannot check = blocked, fail closed; outcome 'blocked'). A blocked channel falls through to
-- the next, as a channel without a template does (lead's choice, open question 284).
create or replace function app.collection_customer_message(p_org uuid, p_document uuid, p_deal uuid, p_contact uuid,
                                                           p_due date, p_offset integer, p_reminder_day date, p_zone text)
returns table (o_outcome text, o_job uuid)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_on boolean;
  v_contact uuid;
  v_phone text;
  v_email text;
  v_sms boolean;
  v_template uuid;
  v_channel text;
  v_problem text;
  v_stages smallint[];
  v_preferred text;
  v_try text;
  v_blocked boolean := false;
  v_next integer;
  v_until date;
  v_event timestamptz;
  v_old record;
begin
  select s.collection_customer_reminder, s.collection_customer_stages into v_on, v_stages
    from public.org_document_settings s where s.organization_id = p_org;
  if not coalesce(v_on, false) then
    return;
  end if;
  -- owner (256) ג: only the stages the business chose
  if not (p_offset = any (coalesce(v_stages, '{}'::smallint[]))) then
    o_outcome := 'stage_off';
    return next;
    return;
  end if;
  begin
    -- the person the debt is owed by: the document's contact, else its deal's contact; live only
    if p_contact is not null then
      select c.id, nullif(btrim(c.phone_e164), ''), nullif(btrim(c.email), ''), c.preferred_channel
        into v_contact, v_phone, v_email, v_preferred
        from public.contacts c
       where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null;
    elsif p_deal is not null then
      select c.id, nullif(btrim(c.phone_e164), ''), nullif(btrim(c.email), ''), c.preferred_channel
        into v_contact, v_phone, v_email, v_preferred
        from public.deals dl
        join public.contacts c on c.organization_id = dl.organization_id and c.id = dl.contact_id and c.deleted_at is null
       where dl.organization_id = p_org and dl.id = p_deal and dl.deleted_at is null;
    end if;
    if v_contact is null then
      o_outcome := 'no_customer';
      return next;
      return;
    end if;
    -- third review 1 (a): SMS only while the plan's flag is on and the month's quota has room
    v_sms := app.collection_sms_room(p_org);
    if not ((v_sms and v_phone is not null) or v_email is not null) then
      -- a phone the plan's SMS (off or used up this month) cannot reach: 'quota'; no usable address at all: 'no_address'
      o_outcome := case when v_phone is not null and coalesce(app.org_has_feature(p_org, 'sms'), false) then 'quota'
                        else 'no_address' end;
      return next;
      return;
    end if;
    -- second review 1
    if app.customer_sending_paused(p_org) then
      o_outcome := 'paused';
      return next;
      return;
    end if;
    if not app.collection_message_worker_seen() then
      o_outcome := 'no_provider';
      return next;
      return;
    end if;

    perform app.seed_collection_reminder_templates(p_org);
    -- owner (257) ד: the contact's preferred channel (CON-10) when it is SMS or email and its address exists (SMS also needs
    -- the plan's `sms`), else SMS (with `sms` and a phone), else email; the first of them with an active template
    foreach v_try in array array[case when v_preferred in ('sms', 'email') then v_preferred end, 'sms', 'email'] loop
      continue when v_try is null or v_template is not null;
      continue when v_try = 'sms' and not (v_sms and v_phone is not null);
      continue when v_try = 'email' and v_email is null;
      continue when not exists (select 1 from public.message_templates t
                                 where t.organization_id = p_org and t.channel = v_try and t.is_active
                                   and t.message_type = 'collection' and t.notice_kind = 'collection_reminder');
      -- second review 1: a service-blocked address (or one that cannot be checked) is not sent to on this channel
      if coalesce(app.consent_service_blocked(p_org, v_try, case when v_try = 'email' then v_email else v_phone end), true) then
        v_blocked := true;
        continue;
      end if;
      select t.id, t.channel into v_template, v_channel
        from public.message_templates t
       where t.organization_id = p_org and t.channel = v_try and t.is_active
         and t.message_type = 'collection' and t.notice_kind = 'collection_reminder'
       order by t.created_at, t.id
       limit 1;
    end loop;
    if v_template is null then
      o_outcome := case when v_blocked then 'blocked' else 'no_template' end;
      return next;
      return;
    end if;
    v_problem := app.message_template_sendable(p_org, v_template);
    if v_problem is not null then
      perform app.message_send_refused(p_org, v_template, v_problem);
      o_outcome := 'template:' || left(regexp_replace(v_problem, '[^a-z_]', '_', 'g'), 40);
      return next;
      return;
    end if;

    -- review 1: valid until the next stage's day begins (the last stage: 7 days from its own day)
    select min(k) into v_next from unnest(app.collection_reminder_offsets()) k where k > p_offset;
    if v_next is null then
      v_until := p_reminder_day + 7;
    else
      v_until := app.add_business_days(p_org, p_due + v_next, 0);
    end if;
    v_event := v_until::timestamp at time zone p_zone;

    -- review 1: the document's earlier messages still waiting are superseded by this one
    for v_old in
      select r.customer_job_id from app.collection_reminders_sent r
       where r.organization_id = p_org and r.document_id = p_document and r.customer_outcome = 'queued'
         and r.customer_job_id is not null
    loop
      perform app.collection_customer_cancel(p_org, v_old.customer_job_id, 'superseded', 'superseded');
    end loop;

    -- see the header: the future sender re-reads the document by collection_document_id and fills the amount at send time
    o_job := app.enqueue_job(
      p_org, 'message.send',
      jsonb_build_object('channel', v_channel, 'message_type', 'collection', 'template_id', v_template,
                         'contact_id', v_contact, 'collection_document_id', p_document,
                         'event_at', to_char(v_event at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
    o_outcome := 'queued';
    return next;
  exception when others then
    raise warning 'crm-collection-reminders: customer message of document % failed (SQLSTATE %)', p_document, sqlstate;
    o_outcome := 'failed';
    o_job := null;
    return next;
  end;
end;
$$;
revoke all on function app.collection_customer_message(uuid, uuid, uuid, uuid, date, integer, date, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The sweep: a waiting customer message that may no longer go is cancelled; a finished one gets its final outcome
-- ----------------------------------------------------------------------------
-- Driven by the stage rows still marked 'queued' (a partial index holds only those): a job the queue finished moves the row to
-- 'sent' (done), 'dead' or 'cancelled' (refused by the queue, e.g. its event_at passed); a job still waiting is judged by
-- app.collection_customer_refusal and cancelled with that reason (refused:<reason>, outcome 'cancelled'); a claimed job is
-- left to the worker. Second review 2: a waiting job whose event_at has passed is cancelled first (refused:expired), so dead
-- rows leave the set. Second review 3: the stage rows are taken for update skip locked (a row another transaction holds
-- waits for the next run). At most app.collection_reminder_limit() rows a run, the longest unchecked first
-- (customer_checked_at), so no business starves another.
create or replace function app.cancel_settled_collection_messages(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_reason text;
  v_done integer := 0;
begin
  for v_row in
    select r.organization_id, r.customer_job_id, r.document_id, r.due_date, r.offset_days, j.status as job_status,
           (j.payload ->> 'contact_id')::uuid as contact_id,
           case when j.payload ? 'event_at' then (j.payload ->> 'event_at')::timestamptz end as event_at
      from app.collection_reminders_sent r
      left join app.jobs j on j.id = r.customer_job_id
     where r.customer_outcome = 'queued'
       and (p_orgs is null or r.organization_id = any (p_orgs))
     order by r.customer_checked_at nulls first, r.customer_job_id
     limit app.collection_reminder_limit()
     for update of r skip locked
  loop
    begin
      if v_row.job_status is null or v_row.job_status not in ('queued', 'failed', 'running') then
        update app.collection_reminders_sent r
           set customer_outcome = case v_row.job_status when 'done' then 'sent' when 'dead' then 'dead' else 'cancelled' end,
               customer_checked_at = now()
         where r.customer_job_id = v_row.customer_job_id and r.organization_id = v_row.organization_id;
        -- third review 1 (b): a message that ended dead or was refused by the queue's own send check (our own cancels set
        -- the row's outcome themselves, so they never reach here) never went out: the stage gets the rep's task, once
        if v_row.job_status in ('dead', 'refused') then
          perform app.collection_stage_task_try(v_row.organization_id, v_row.customer_job_id, v_row.document_id,
                                                v_row.due_date, v_row.offset_days);
        end if;
      elsif v_row.job_status = 'running' then
        update app.collection_reminders_sent r set customer_checked_at = now()
         where r.customer_job_id = v_row.customer_job_id and r.organization_id = v_row.organization_id;
      else
        v_reason := case when v_row.event_at is not null and v_row.event_at <= now() then 'expired'
                         else app.collection_customer_refusal(v_row.organization_id, v_row.document_id, v_row.contact_id,
                                                              v_row.offset_days) end;
        if v_reason is not null
           and app.collection_customer_cancel(v_row.organization_id, v_row.customer_job_id, v_reason) then
          v_done := v_done + 1;
          -- third review 1 (b): a message held past its time never went out: the stage gets the rep's task, once. Never for
          -- superseded, debt_settled, reminder_off, stage_off, customer_changed or business_off
          if v_reason = 'expired' then
            perform app.collection_stage_task_try(v_row.organization_id, v_row.customer_job_id, v_row.document_id,
                                                  v_row.due_date, v_row.offset_days);
          end if;
        else
          update app.collection_reminders_sent r set customer_checked_at = now()
           where r.customer_job_id = v_row.customer_job_id and r.organization_id = v_row.organization_id;
        end if;
      end if;
    exception when others then
      raise warning 'crm-collection-reminders: customer message % not judged (SQLSTATE %)', v_row.customer_job_id, sqlstate;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.cancel_settled_collection_messages(uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rep's task of a stage: 021135's lines, moved here unchanged so the job and the sweep's backstop (third review 1 (b)) make
-- it the same way. One open reminder task per document: a still-open earlier one moves to this stage while it is as the job
-- left it (title and due time), still attached to its document (app.collection_task_attached) and its owner an active full-seat
-- non-viewer; otherwise a new task for the rep (MNY-01's owner rule), else the business's owner, else its oldest admin. A task
-- made while customer sending is paused carries the HEB-09 line.
-- ----------------------------------------------------------------------------
create or replace function app.collection_stage_task(p_org uuid, p_document uuid, p_doc_type text, p_number text,
                                                     p_deal uuid, p_contact uuid, p_company uuid, p_due date,
                                                     p_reminder_day date, p_today date, p_zone text)
returns table (o_task uuid, o_due_at timestamptz, o_title text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_rep uuid;
  v_task uuid;
  v_title text;
  v_due_at timestamptz;
begin
  -- answers (2): the stage by the (moved) reminder day
  v_title := left('תזכורת גבייה: ' || app.document_type_label(p_doc_type) || coalesce(' ' || p_number, '')
                  || ' · ' || app.collection_reminder_stage(p_reminder_day - p_due), 300);
  v_due_at := greatest(now(), (p_today + time '12:00') at time zone p_zone);

  select t.id into v_task
    from public.tasks t
    join app.collection_reminders_sent s
      on s.organization_id = t.organization_id and s.task_id = t.id and s.document_id = p_document
    join public.memberships m
      on m.organization_id = t.organization_id and m.user_id = t.owner_id
     and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
   where t.organization_id = p_org and t.collection_document_id = p_document
     and t.status = 'open' and t.deleted_at is null
     and app.collection_task_attached(t.deal_id, t.contact_id, t.company_id, p_deal, p_contact, p_company)
     and t.due_at = s.task_due_at
     -- answers (2): the title the job kept; rows made before it, the old rule
     and t.title = coalesce(s.task_title,
                            left('תזכורת גבייה: ' || app.document_type_label(p_doc_type) || coalesce(' ' || p_number, '')
                                 || ' · ' || app.collection_reminder_stage(s.offset_days), 300))
   order by s.done_at desc nulls last, t.created_at desc, t.id
   limit 1;

  if v_task is not null then
    update public.tasks t
       set title = v_title, due_at = v_due_at
     where t.organization_id = p_org and t.id = v_task;
  else
    -- the rep (MNY-01's owner rule), else the business's owner, else its oldest admin
    select m.user_id into v_rep
      from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
       and m.user_id = (select coalesce(dl.owner_id, ct.owner_id, co.owner_id)
                          from (select 1) one
                          left join public.deals dl on dl.organization_id = p_org and dl.id = p_deal
                          left join public.contacts ct on ct.organization_id = p_org and ct.id = p_contact
                          left join public.companies co on co.organization_id = p_org and co.id = p_company);
    if v_rep is null then
      select m.user_id into v_rep
        from public.memberships m
       where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin')
       order by (m.role = 'owner') desc, m.created_at, m.user_id
       limit 1;
    end if;

    -- HEB-09 (owner 2 November 2026, answer (45) א): the task is still made while customer sending is paused, and then
    -- says so
    insert into public.tasks (organization_id, title, task_type, due_at, priority, owner_id,
                              deal_id, contact_id, company_id, collection_document_id, description)
    values (p_org, v_title, 'todo', v_due_at, 2, v_rep,
            p_deal, p_contact, p_company, p_document,
            case when app.customer_sending_paused(p_org) then 'השליחה ללקוחות עצורה' end)
    returning id into v_task;
  end if;
  o_task := v_task;
  o_due_at := v_due_at;
  o_title := v_title;
  return next;
end;
$$;
revoke all on function app.collection_stage_task(uuid, uuid, text, text, uuid, uuid, uuid, date, date, date, text)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Third review 1 (b): a stage whose customer message never went out (expired, refused by the queue's own send check, or dead)
-- gets the rep's task after all, once, while the debt still is (the job's own conditions); answers the task or null
-- ----------------------------------------------------------------------------
create or replace function app.collection_stage_task_backstop(p_org uuid, p_document uuid, p_due date, p_offset integer)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_doc public.accounting_documents;
  v_zone text;
  v_today date;
  v_balance bigint;
  v_task uuid;
  v_due_at timestamptz;
  v_title text;
begin
  -- once: a stage row that already has a task (the +14 stage, or an earlier backstop) gets no other
  if exists (select 1 from app.collection_reminders_sent s
              where s.document_id = p_document and s.due_date = p_due and s.offset_days = p_offset and s.task_id is not null) then
    return null;
  end if;
  -- final review 1: a later stage of the same document and due date was already handled (its message or task made): the
  -- earlier stage's message is out of date, and the later stage's task (or message) stands
  if exists (select 1 from app.collection_reminders_sent s
              where s.organization_id = p_org and s.document_id = p_document and s.due_date = p_due
                and s.offset_days > p_offset and s.done_at is not null) then
    return null;
  end if;
  if not exists (select 1 from app.collection_reminder_orgs(array[p_org]) o) then
    return null;
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = p_org and d.id = p_document;
  if not found or v_doc.status <> 'active' or v_doc.due_date is distinct from p_due
     or (v_doc.deal_id is null and v_doc.contact_id is null and v_doc.company_id is null)
     or (v_doc.doc_type = 'proforma'
         and exists (select 1 from public.accounting_documents i
                      where i.organization_id = p_org and i.proforma_id = v_doc.id and i.status = 'active'))
     or exists (select 1 from public.deals dl where dl.organization_id = p_org and dl.id = v_doc.deal_id and dl.deleted_at is not null)
     or exists (select 1 from public.contacts ct where ct.organization_id = p_org and ct.id = v_doc.contact_id and ct.deleted_at is not null)
     or exists (select 1 from public.companies co where co.organization_id = p_org and co.id = v_doc.company_id and co.deleted_at is not null)
     or app.collection_held_until(p_org, v_doc.id) is not null then
    return null;
  end if;
  select coalesce((x ->> 'balance')::bigint, 0) into v_balance
    from jsonb_array_elements(public.money_allocation_state(p_org, array[v_doc.id], '{}'::uuid[]) -> 'documents') x
   where (x ->> 'id')::uuid = v_doc.id;
  if coalesce(v_balance, 0) <= 0 then
    return null;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
  v_today := (now() at time zone v_zone)::date;
  select st.o_task, st.o_due_at, st.o_title into v_task, v_due_at, v_title
    from app.collection_stage_task(p_org, v_doc.id, v_doc.doc_type, v_doc.number, v_doc.deal_id, v_doc.contact_id,
                                   v_doc.company_id, p_due, app.add_business_days(p_org, p_due + p_offset, 0), v_today,
                                   v_zone) st;
  update app.collection_reminders_sent s
     set task_id = v_task, task_due_at = v_due_at, task_title = v_title
   where s.document_id = p_document and s.due_date = p_due and s.offset_days = p_offset;
  return v_task;
end;
$$;
revoke all on function app.collection_stage_task_backstop(uuid, uuid, date, integer) from public, anon, authenticated, service_role;

-- Final review 2: the sweep's call of the backstop, in its own block. A failure puts the row back to 'queued' (the next
-- sweep finalizes it again and tries again) and is counted; after 3 failures the row ends 'failed'.
create or replace function app.collection_stage_task_try(p_org uuid, p_job uuid, p_document uuid, p_due date, p_offset integer)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_failures integer;
begin
  begin
    perform app.collection_stage_task_backstop(p_org, p_document, p_due, p_offset);
  exception when others then
    update app.collection_reminders_sent r
       set customer_task_failures = r.customer_task_failures + 1,
           customer_outcome = case when r.customer_task_failures + 1 >= 3 then 'failed' else 'queued' end
     where r.organization_id = p_org and r.customer_job_id = p_job
    returning r.customer_task_failures into v_failures;
    raise warning 'crm-collection-reminders: stage task of document % failed (SQLSTATE %)%', p_document, sqlstate,
      case when coalesce(v_failures, 0) >= 3 then ', given up after 3 failures' else '' end;
  end;
end;
$$;
revoke all on function app.collection_stage_task_try(uuid, uuid, uuid, date, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job: 021135's body, with only the lines marked COL-07
-- ----------------------------------------------------------------------------
create or replace function app.send_collection_reminders(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_balance bigint;
  v_rep uuid;
  v_task uuid;
  v_title text;
  v_due_at timestamptz;
  v_done integer := 0;
  v_served uuid[] := '{}'::uuid[];
  -- COL-07: the customer's message of this stage
  v_customer_outcome text;
  v_customer_job uuid;
begin
  -- answers (4): first close the reminder tasks whose debt was paid
  perform app.close_paid_collection_tasks(p_orgs);
  -- COL-07: and cancel the customer messages still waiting in the queue for a debt that no longer is (paid, cancelled, held)
  begin
    perform app.cancel_settled_collection_messages(p_orgs);
  exception when others then
    raise warning 'crm-collection-reminders: settled messages not cancelled (SQLSTATE %)', sqlstate;
  end;

  for v_row in
    -- answers (review): the businesses first (writable, the three keys), then the documents that can be due at all, and only
    -- then the per-document rule (app.collection_reminder_at)
    with cand as materialized (
      select d.organization_id, d.id, d.doc_type, d.number, d.due_date, d.deal_id, d.contact_id, d.company_id, d.amount_agorot,
             o.timezone
        from app.collection_reminder_orgs(p_orgs) og(id)
        join public.organizations o on o.id = og.id
        join public.accounting_documents d on d.organization_id = og.id
       where d.status = 'active'
         and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
         and d.amount_agorot > 0
         -- 021116: a document with no customer left (deal, contact and company all purged) gets no reminder
         and (d.deal_id is not null or d.contact_id is not null or d.company_id is not null)
         -- a cheap bound first (every zone's today is within a day of the server's): an offset's day is reached only while
         -- today - due is in -3..20 plus the days it was moved (answers (2): up to 30), so nothing outside it can be due
         and d.due_date between current_date - 52 and current_date + 4
         -- a proforma billed by an active tax invoice owes through the invoice
         and not (d.doc_type = 'proforma'
                  and exists (select 1 from public.accounting_documents i
                               where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
         -- a document whose deal, contact or company is in the recycle bin waits (nothing is recorded)
         and not exists (select 1 from public.deals dl where dl.organization_id = d.organization_id and dl.id = d.deal_id and dl.deleted_at is not null)
         and not exists (select 1 from public.contacts ct where ct.organization_id = d.organization_id and ct.id = d.contact_id and ct.deleted_at is not null)
         and not exists (select 1 from public.companies co where co.organization_id = d.organization_id and co.id = d.company_id and co.deleted_at is not null)
         -- a cheap first cut (public.collection_documents' candidates); the balance itself is read below
         and coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                        where a.organization_id = d.organization_id and a.document_id = d.id
                          and a.released_at is null and a.removed_at is null), 0)
             + coalesce((select sum(oc.amount_agorot) from public.opening_credit_allocations oc
                          where oc.organization_id = d.organization_id and oc.document_id = d.id
                            and oc.released_at is null and oc.removed_at is null), 0)
             < d.amount_agorot
    )
    select z.* from (
      select d.organization_id, d.id, d.doc_type, d.number, d.due_date, d.deal_id, d.contact_id, d.company_id,
             c.today, c.zone, c.offset_days, c.reminder_day, s.last_attempt_at, tn.served_at,
             -- a document that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by d.organization_id order by s.last_attempt_at nulls first, d.due_date, d.id) as n
        from cand d
        cross join lateral (
          select (now() at time zone app.intake_zone(d.timezone))::date as today, app.intake_zone(d.timezone) as zone
        ) t0
        -- answers (2): the reminder moved to the business's next working day (app.collection_reminder_at)
        cross join lateral (
          select t0.today, t0.zone, r.offset_days, r.reminder_day
            -- no day (nothing to do, the rule is not evaluated) outside the bound or before 08:00 in the business's zone
            from app.collection_reminder_at(d.organization_id, d.due_date,
                                            case when d.due_date between t0.today - 50 and t0.today + 3
                                                      and (now() at time zone t0.zone)::time >= time '08:00'
                                                 then t0.today end) r
        ) c
        left join app.collection_reminders_sent s
          on s.document_id = d.id and s.due_date = d.due_date and s.offset_days = c.offset_days
        left join app.collection_reminder_turns tn on tn.organization_id = d.organization_id
       where c.offset_days is not null
         and (s.document_id is null or (s.done_at is null and s.failures < 3))
         -- COL-03: a promise holds the reminders; nothing is recorded, so the offset is judged again after the promise. Here,
         -- before the per-business cap, so held documents never take the places of the others
         and app.collection_held_until(d.organization_id, d.id) is null
    ) z
     where z.n <= app.collection_reminder_per_org()
     -- businesses take turns: every business's first document, then every business's second, ...; among businesses, the
     -- one served longest ago first (app.collection_reminder_turns), so a business with many documents never blocks another
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.due_date, z.id
     limit app.collection_reminder_limit()
  loop
    v_rep := null;
    v_task := null;
    v_balance := null;
    -- COL-07
    v_customer_outcome := null;
    v_customer_job := null;
    if not (v_row.organization_id = any (v_served)) then
      v_served := v_served || v_row.organization_id;
    end if;
    begin
      select coalesce((x ->> 'balance')::bigint, 0) into v_balance
        from jsonb_array_elements(public.money_allocation_state(v_row.organization_id, array[v_row.id], '{}'::uuid[]) -> 'documents') x
       where (x ->> 'id')::uuid = v_row.id;

      if coalesce(v_balance, 0) > 0 then
        -- answers (2): the stage by the (moved) reminder day
        v_title := left('תזכורת גבייה: ' || app.document_type_label(v_row.doc_type) || coalesce(' ' || v_row.number, '')
                        || ' · ' || app.collection_reminder_stage(v_row.reminder_day - v_row.due_date), 300);
        v_due_at := greatest(now(), (v_row.today + time '12:00') at time zone v_row.zone);

        -- COL-07: with the business's switch on and this stage chosen (owner (256) ג), the stage first queues ONE message to
        -- the customer (its own block inside the function: a failure there is recorded as 'failed' and the task is made)
        select cm.o_outcome, cm.o_job into v_customer_outcome, v_customer_job
          from app.collection_customer_message(v_row.organization_id, v_row.id, v_row.deal_id, v_row.contact_id,
                                           v_row.due_date, v_row.offset_days, v_row.reminder_day, v_row.zone) cm;

        -- COL-07, owner (258) ב: the rep's task only when no message to the customer was queued for this stage, and always at
        -- the last stage (+14). The task lines below are 021135's, unchanged, inside this condition
        if v_customer_outcome is distinct from 'queued' or v_row.offset_days = 14 then

        -- third review 1 (b): 021135's task lines moved unchanged into app.collection_stage_task, which the sweep's
        -- backstop calls too
        select st.o_task, st.o_due_at, st.o_title into v_task, v_due_at, v_title
          from app.collection_stage_task(v_row.organization_id, v_row.id, v_row.doc_type, v_row.number, v_row.deal_id,
                                         v_row.contact_id, v_row.company_id, v_row.due_date, v_row.reminder_day,
                                         v_row.today, v_row.zone) st;
        else
          -- COL-07 (258) ב: the customer was sent the message of this stage; no task, and an earlier open task is left as it is
          v_title := null;
          v_due_at := null;
        end if;
      else
        v_task := null;
        v_due_at := null;
        v_title := null;
      end if;

      -- COL-07: the customer's message is kept on the stage's own row
      insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, task_id, task_due_at, task_title, done_at,
                                                 customer_outcome, customer_job_id)
      values (v_row.organization_id, v_row.id, v_row.due_date, v_row.offset_days, v_task, v_due_at, v_title, now(),
              v_customer_outcome, v_customer_job)
      on conflict (document_id, due_date, offset_days)
        do update set task_id = excluded.task_id, task_due_at = excluded.task_due_at, task_title = excluded.task_title,
                      done_at = excluded.done_at, customer_outcome = excluded.customer_outcome,
                      customer_job_id = excluded.customer_job_id;
      v_done := v_done + 1;
    exception when others then
      -- this document's reminder is tried again on a later run, after the fresh ones; after 3 failures it is skipped. One
      -- redacted line: the document id and the SQLSTATE only
      insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, failures, last_attempt_at)
      values (v_row.organization_id, v_row.id, v_row.due_date, v_row.offset_days, 1, now())
      on conflict (document_id, due_date, offset_days)
        do update set failures = app.collection_reminders_sent.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-collection-reminders: document % failed (SQLSTATE %)%', v_row.id, sqlstate,
        case when coalesce((select s.failures from app.collection_reminders_sent s
                             where s.document_id = v_row.id and s.due_date = v_row.due_date and s.offset_days = v_row.offset_days), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;

  -- the businesses served in this run go to the back of the line
  insert into app.collection_reminder_turns (organization_id, served_at)
  select o, clock_timestamp() from unnest(v_served) o
  on conflict (organization_id) do update set served_at = excluded.served_at;
  return v_done;
end;
$$;
revoke all on function app.send_collection_reminders(uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Switching the customer's reminder off, or removing the settings row (review 2), cancels the business's messages still
-- waiting in the queue
-- ----------------------------------------------------------------------------
create or replace function app.org_document_settings_collection_reminder_off() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_job record;
begin
  if tg_op = 'DELETE' then
    -- the business itself is going: its jobs go with it
    if not coalesce(old.collection_customer_reminder, false) or not app.org_exists(old.organization_id) then
      return null;
    end if;
    v_org := old.organization_id;
  else
    -- no settings row means off, so only an update from on to off switches anything off
    if not (coalesce(old.collection_customer_reminder, false) and not new.collection_customer_reminder) then
      return null;
    end if;
    v_org := new.organization_id;
  end if;
  for v_job in
    select r.customer_job_id from app.collection_reminders_sent r
     where r.organization_id = v_org and r.customer_outcome = 'queued' and r.customer_job_id is not null
  loop
    perform app.collection_customer_cancel(v_org, v_job.customer_job_id, 'reminder_off');
  end loop;
  return null;
end;
$$;
revoke all on function app.org_document_settings_collection_reminder_off() from public, anon, authenticated, service_role;

create or replace trigger org_document_settings_collection_reminder_off
  after update of collection_customer_reminder or delete on public.org_document_settings
  for each row execute function app.org_document_settings_collection_reminder_off();
