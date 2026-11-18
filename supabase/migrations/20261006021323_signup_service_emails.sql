-- =============================================================================
-- WEB-05: service emails to a new sign-up (OPS-04 job kind signup.send)
-- =============================================================================
-- Owner (418) ב (18 November 2026): only the SERVICE emails to a new sign-up (a business owner): a welcome when the person's
-- first business is made, and "the trial is about to end" a few days before it ends. No tips, no marketing, no series. Read
-- as the approval of ONE background job kind for these service emails only, under answer (55)'s conditions: ids and codes
-- only in the queue, the worker's functions pinned by md5 (test 284), its own "In use" line.
--
-- The lead's choices (questions in the worker's report):
-- * welcome: queued for a business made in the last 2 days, still on its trial (organizations 'trial' + subscriptions
--   'trialing'), open (not deleted, closed or waiting to be removed), whose creator is still its active owner and created no
--   business before it (organizations.created_by). Sent at once (an answer to the person's own action).
-- * trial_ending: from 09:00 in the business's zone, 3 calendar days before the trial's last day (the business's local
--   date of trial_ends_at minus one microsecond, so a trial ending at local midnight ends the day before; minus 3), on a
--   working day of the business, only while more than 12 hours of trial are left; to the business's CURRENT active owner;
--   the person's quiet hours move it later on the same day (app.digest_run_at).
-- * Owner (444) א: the trial_ending email, and the welcome's line "the trial is active until X", go ONLY while the trial-end
--   switch is on (app.trial_end_settings.enabled, BIL-08) and staff did not assign the business by hand after its trial end
--   (app.platform_assignments.assigned_at >= trial_ends_at, the rule of app.trial_end_candidates): only then will the trial
--   really end. app.signup_trial_end_applies() is that rule; it is judged at SEND time by the composer (switch off =
--   trial_ending refused 'trial_end_off', a welcome answers no trial end day); the queue also skips trial_ending while it
--   does not hold (cheap, not the rule).
-- * Once per business and kind (app.signup_email_sends, primary key; cascades with the business, so no purge is needed:
--   two rows per business at most). Caps: 1,000 emails an hour system-wide, 3 trial_ending emails per person a day (a person
--   owns at most 5 businesses), 500 queued a run.
-- * Nothing is queued while no worker asked for signup.send in the last day (no email provider).
-- * The stop: the composer judges everything again on the live lease (still trialing, open, the person still the active
--   owner, the trial not over, the queued row still this job's) and answers {refused: <code>} otherwise; nothing is sent.
--
-- What this file holds:
-- * app.job_kinds() gains 'signup.send'; app.job_payload_ok() (021317's body, one more branch) takes exactly
--   {organization_id, user_id, kind} with kind welcome | trial_ending.
-- * app.signup_email_sends (RLS on, no grants), app.signup_email_limits() (tests may only LOWER a cap per transaction through
--   app.signup_email_per_hour | _per_person_day | _per_run), app.signup_trial_end_applies() and app.signup_trial_last_day().
-- * app.queue_signup_emails(): pg_cron `crm-signup-emails` (every 10 minutes).
-- * public.signup_job_compose(job, lease) (service_role, the live lease only) for the worker.
-- Every statement is safe to run twice. No drop statement, no row removal.

create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run', 'digest.send', 'report.send', 'invite.send', 'invoice.issue',
                   'payment_link.create', 'payment_link.refund', 'signup.send']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021317's body, plus signup.send (owner (418) ב): exactly {organization_id, user_id, kind}
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
                               'collection_document_id', 'review_request_id', 'quote_id'))
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
      -- RET-02: the review request a message is (the sender re-reads it and the business's settings); review_request only, on a
      -- contact or (owner (309) ב) a lead, by SMS or email, with no files, reply-to person, sender or rule
      and (not (p_payload ? 'review_request_id')
           or (jsonb_typeof(p_payload -> 'review_request_id') = 'string'
               and (p_payload ->> 'review_request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'review_request'
               and (p_payload ? 'contact_id' or p_payload ? 'lead_id')
               and (p_payload ->> 'channel') in ('email', 'sms')
               and not (p_payload ?| array['file_ids', 'library_file_ids', 'reply_to_user_id', 'sent_by_user_id',
                                           'automation_id', 'pressed_by_user_id', 'sender_check_id'])))
      -- QUO-18: the quote a requested_document is (the sender re-reads it and mints its link); to a contact, by email or SMS,
      -- with no files, rule, button, sender check or other subject
      and (not (p_payload ? 'quote_id')
           or (jsonb_typeof(p_payload -> 'quote_id') = 'string'
               and (p_payload ->> 'quote_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'requested_document'
               and p_payload ? 'contact_id'
               and (p_payload ->> 'channel') in ('email', 'sms')
               and not (p_payload ?| array['deal_id', 'file_ids', 'library_file_ids', 'automation_id', 'pressed_by_user_id',
                                           'sender_check_id', 'signature_document_id', 'collection_document_id',
                                           'form_submission_id', 'review_request_id', 'punch_card_id', 'meeting_id'])))
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
    -- USR-11 / WAB-03 (owner (267) א): the person, the business, the kind of summary and the business day, nothing else
    when p_kind = 'digest.send' then
      coalesce(
        coalesce((select bool_and(k in ('user_id', 'organization_id', 'digest_kind', 'day')) from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 4
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and jsonb_typeof(p_payload -> 'organization_id') = 'string'
        and jsonb_typeof(p_payload -> 'digest_kind') = 'string'
        and jsonb_typeof(p_payload -> 'day') = 'string'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'organization_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'digest_kind') in ('manager', 'personal')
        and (p_payload ->> 'day') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
        false)
    -- RPT-03 (owner (386) א): the schedule, the recipient and the business day, nothing else
    when p_kind = 'report.send' then
      coalesce(
        coalesce((select bool_and(k in ('schedule_id', 'user_id', 'day')) from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 3
        and jsonb_typeof(p_payload -> 'schedule_id') = 'string'
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and jsonb_typeof(p_payload -> 'day') = 'string'
        and (p_payload ->> 'schedule_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'day') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
        false)
    -- USR-09 (owner (387) א): the invitation and the person who asked to send it, nothing else (never the token)
    when p_kind = 'invite.send' then
      coalesce(
        coalesce((select bool_and(k in ('invitation_id', 'requested_by')) from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 2
        and jsonb_typeof(p_payload -> 'invitation_id') = 'string'
        and jsonb_typeof(p_payload -> 'requested_by') = 'string'
        and (p_payload ->> 'invitation_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'requested_by') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false)
    -- DOC-07 (owner (398) א): the issue request's id, nothing else (the request itself stays in its own table)
    when p_kind = 'invoice.issue' then
      coalesce(
        coalesce((select bool_and(k = 'request_id') from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 1
        and jsonb_typeof(p_payload -> 'request_id') = 'string'
        and (p_payload ->> 'request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false)
    -- LNK-02 (owner (394) א): the payment link's id, nothing else (the link itself stays in its own table)
    when p_kind = 'payment_link.create' then
      coalesce(
        coalesce((select bool_and(k = 'link_id') from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 1
        and jsonb_typeof(p_payload -> 'link_id') = 'string'
        and (p_payload ->> 'link_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false)
    -- LNK-07 (owner (394) א): the refund request's id, nothing else (the request stays in its own table)
    when p_kind = 'payment_link.refund' then
      coalesce(
        coalesce((select bool_and(k = 'request_id') from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 1
        and jsonb_typeof(p_payload -> 'request_id') = 'string'
        and (p_payload ->> 'request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false)
    -- WEB-05 (owner (418) ב): the business, its owner and which service email, nothing else (never an address or a text)
    when p_kind = 'signup.send' then
      coalesce(
        coalesce((select bool_and(k in ('organization_id', 'user_id', 'kind')) from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 3
        and jsonb_typeof(p_payload -> 'organization_id') = 'string'
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and jsonb_typeof(p_payload -> 'kind') = 'string'
        and (p_payload ->> 'organization_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'kind') in ('welcome', 'trial_ending'),
        false)
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Once per business and kind (schema app: RLS on, no grants; cascades with the business)
-- ----------------------------------------------------------------------------
-- composed_at is stamped by the composer when it answered an address to the worker.
create table if not exists app.signup_email_sends (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null check (kind in ('welcome', 'trial_ending')),
  user_id         uuid not null,
  queued_at       timestamptz not null default now(),
  job_id          uuid,
  composed_at     timestamptz,
  primary key (organization_id, kind)
);
create index if not exists signup_email_sends_queued_idx on app.signup_email_sends (queued_at);
create index if not exists signup_email_sends_user_idx on app.signup_email_sends (user_id, kind, queued_at);
create index if not exists signup_email_sends_job_idx on app.signup_email_sends (job_id);
alter table app.signup_email_sends enable row level security;
revoke all on app.signup_email_sends from public, anon, authenticated, service_role;

-- the caps: emails queued an hour across every business, trial_ending emails per person in 24 hours, queued a run
-- (a transaction-local setting may only lower a cap, never raise it; the cron sets none)
create or replace function app.signup_email_limits(out per_hour integer, out per_person_day integer, out per_run integer)
language sql stable
set search_path = ''
as $$
  select least(1000, greatest(1, coalesce(nullif(current_setting('app.signup_email_per_hour', true), '')::integer, 1000))),
         least(3, greatest(1, coalesce(nullif(current_setting('app.signup_email_per_person_day', true), '')::integer, 3))),
         least(500, greatest(1, coalesce(nullif(current_setting('app.signup_email_per_run', true), '')::integer, 500)))
$$;
revoke all on function app.signup_email_limits() from public, anon, authenticated, service_role;

-- Owner (444) א: the trial will really end only while BIL-08's switch is on and staff did not assign the business by hand
-- after its trial end (app.trial_end_candidates' rule; keep in step). Only then is "the trial ends" told to the owner.
create or replace function app.signup_trial_end_applies(p_org uuid, p_trial_ends_at timestamptz) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_trial_ends_at is not null
     and coalesce((select st.enabled from app.trial_end_settings st where st.id), false)
     and not exists (select 1 from app.platform_assignments pa
                      where pa.organization_id = p_org and pa.assigned_at >= p_trial_ends_at)
$$;
revoke all on function app.signup_trial_end_applies(uuid, timestamptz) from public, anon, authenticated, service_role;

-- the trial's last day in the business's zone: the local date of its last moment (trial_ends_at is the first moment after it)
create or replace function app.signup_trial_last_day(p_trial_ends_at timestamptz, p_zone text) returns date
language sql stable
set search_path = ''
as $$ select ((p_trial_ends_at - interval '1 microsecond') at time zone p_zone)::date $$;
revoke all on function app.signup_trial_last_day(timestamptz, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The cron: welcome and trial_ending, each once per business
-- ----------------------------------------------------------------------------
-- p_now is for tests only (the cron passes nothing). Returns how many jobs were queued.
create or replace function app.queue_signup_emails(p_limit integer default null, p_now timestamptz default null)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_limits record;
  v_limit integer;
  v_row record;
  v_target date;
  v_job uuid;
  v_queued integer := 0;
begin
  -- no worker sends this kind yet: queue nothing (a job nobody claims would only wait)
  if not exists (select 1 from app.job_kind_seen s
                  where s.kind = 'signup.send' and s.last_claimed_at > now() - interval '1 day') then
    return 0;
  end if;
  -- one run at a time, so two runs never both pass the hour's cap
  if not pg_try_advisory_xact_lock(hashtextextended('signup_email_queue', 0)) then
    return 0;
  end if;
  select * into v_limits from app.signup_email_limits();
  v_limit := least(greatest(coalesce(p_limit, v_limits.per_run), 0), v_limits.per_run);

  -- welcome: a business made in the last 2 days, on its trial and open, whose creator is its active owner and made no
  -- business before it
  for v_row in
    select o.id as organization_id, o.created_by as user_id
      from public.organizations o
      join public.subscriptions s on s.organization_id = o.id
      join public.memberships m on m.organization_id = o.id and m.user_id = o.created_by
                               and m.role = 'owner' and m.status = 'active'
     where o.created_at > v_now - interval '2 days'
       and o.created_at <= v_now
       and o.created_by is not null
       and o.deleted_at is null
       and o.status = 'trial'
       and s.status = 'trialing'
       and not app.org_deletion_pending(o.id)
       and not exists (select 1 from public.organizations e
                        where e.created_by = o.created_by and e.id <> o.id
                          and (e.created_at, e.id) < (o.created_at, o.id))
       and not exists (select 1 from app.signup_email_sends x where x.organization_id = o.id and x.kind = 'welcome')
     order by o.created_at, o.id
  loop
    exit when v_queued >= v_limit;
    exit when (select count(*) from app.signup_email_sends x where x.queued_at > v_now - interval '1 hour') >= v_limits.per_hour;
    begin
      insert into app.signup_email_sends (organization_id, kind, user_id, queued_at)
      values (v_row.organization_id, 'welcome', v_row.user_id, v_now)
      on conflict do nothing;
      continue when not found;
      v_job := app.enqueue_job(v_row.organization_id, 'signup.send',
                 jsonb_build_object('organization_id', v_row.organization_id::text, 'user_id', v_row.user_id::text,
                                    'kind', 'welcome'),
                 v_now);
      update app.signup_email_sends x set job_id = v_job
       where x.organization_id = v_row.organization_id and x.kind = 'welcome';
      v_queued := v_queued + 1;
    exception when others then
      raise warning 'signup welcome not queued (%): %', v_row.organization_id, sqlstate;
    end;
  end loop;

  -- trial_ending: from 09:00 in the business's zone, from 3 days before the trial's last day, on a working day, while
  -- more than 12 hours are left; to the business's current active owner
  for v_row in
    select o.id as organization_id, m.user_id, z.zone, s.trial_ends_at,
           (v_now at time zone z.zone)::date as local_day,
           (v_now at time zone z.zone)::time as local_time
      from public.organizations o
      join public.subscriptions s on s.organization_id = o.id
      join public.memberships m on m.organization_id = o.id and m.role = 'owner' and m.status = 'active'
      cross join lateral (select app.intake_zone(o.timezone) as zone) z
     where o.deleted_at is null
       and o.status = 'trial'
       and s.status = 'trialing'
       and s.trial_ends_at is not null
       and s.trial_ends_at > v_now + interval '12 hours'
       and s.trial_ends_at <= v_now + interval '4 days'
       and not app.org_deletion_pending(o.id)
       and app.signup_trial_end_applies(o.id, s.trial_ends_at)
       and not exists (select 1 from app.signup_email_sends x where x.organization_id = o.id and x.kind = 'trial_ending')
     order by s.trial_ends_at, o.id
  loop
    exit when v_queued >= v_limit;
    exit when (select count(*) from app.signup_email_sends x where x.queued_at > v_now - interval '1 hour') >= v_limits.per_hour;
    v_target := app.signup_trial_last_day(v_row.trial_ends_at, v_row.zone) - 3;
    continue when v_row.local_day < v_target or v_row.local_time < time '09:00';
    begin
      continue when app.org_rest_day(v_row.organization_id, v_row.local_day);
      continue when (select count(*) from app.signup_email_sends x
                      where x.user_id = v_row.user_id and x.kind = 'trial_ending'
                        and x.queued_at > v_now - interval '1 day') >= v_limits.per_person_day;
      insert into app.signup_email_sends (organization_id, kind, user_id, queued_at)
      values (v_row.organization_id, 'trial_ending', v_row.user_id, v_now)
      on conflict do nothing;
      continue when not found;
      v_job := app.enqueue_job(v_row.organization_id, 'signup.send',
                 jsonb_build_object('organization_id', v_row.organization_id::text, 'user_id', v_row.user_id::text,
                                    'kind', 'trial_ending'),
                 app.digest_run_at(v_row.user_id, v_row.zone, v_now));
      update app.signup_email_sends x set job_id = v_job
       where x.organization_id = v_row.organization_id and x.kind = 'trial_ending';
      v_queued := v_queued + 1;
    exception when others then
      raise warning 'signup trial_ending not queued (%): %', v_row.organization_id, sqlstate;
    end;
  end loop;
  return v_queued;
end;
$$;
revoke all on function app.queue_signup_emails(integer, timestamptz) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-signup-emails', '*/10 * * * *', 'select app.queue_signup_emails();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The worker's composer: one function, service_role only, on the job's live lease
-- ----------------------------------------------------------------------------
-- Answers {refused: stale} on a lease that is not this job's live one, {refused: <code>} when nothing may be sent (the worker
-- ends the job, nothing sent): invalid (a payload or a queued row that is not this job's), business_closed (deleted, closed,
-- waiting to be removed), not_trialing (the business left its trial: a paid or active plan, read-only, suspended),
-- trial_over (trial_ending only: no trial end, or it passed), trial_end_off (trial_ending only: owner (444) א, the trial will
-- not end by itself, app.signup_trial_end_applies), not_owner (the person is no longer the business's active owner;
-- a welcome only to its creator), no_address. Else {to, business_name, kind, trial_end_day}: the owner's sign-in address, the
-- business's display name (the neutral "העסק" when the name holds a link, an "@" or a "://"), the kind, and the trial's last
-- day in the business's zone (YYYY-MM-DD; null when the trial will not end by itself). Nothing else.
create or replace function public.signup_job_compose(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_org public.organizations;
  v_sub public.subscriptions;
  v_user uuid;
  v_kind text;
  v_email text;
  v_name text;
  v_trial_end boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'signup.send' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if not app.job_payload_ok('signup.send', v_job.payload)
     or (v_job.payload ->> 'organization_id') is distinct from v_job.organization_id::text then
    return jsonb_build_object('refused', 'invalid');
  end if;
  v_user := (v_job.payload ->> 'user_id')::uuid;
  v_kind := v_job.payload ->> 'kind';
  if not exists (select 1 from app.signup_email_sends x
                  where x.organization_id = v_job.organization_id and x.kind = v_kind
                    and x.job_id = v_job.id and x.user_id = v_user) then
    return jsonb_build_object('refused', 'invalid');
  end if;
  select * into v_org from public.organizations o where o.id = v_job.organization_id;
  if v_org.id is null or v_org.deleted_at is not null or app.org_status_closed(v_org.status) or app.org_deletion_pending(v_org.id) then
    return jsonb_build_object('refused', 'business_closed');
  end if;
  select * into v_sub from public.subscriptions s where s.organization_id = v_org.id;
  if v_org.status <> 'trial' or v_sub.organization_id is null or v_sub.status <> 'trialing' then
    return jsonb_build_object('refused', 'not_trialing');
  end if;
  if v_kind = 'trial_ending' and (v_sub.trial_ends_at is null or v_sub.trial_ends_at <= now()) then
    return jsonb_build_object('refused', 'trial_over');
  end if;
  v_trial_end := app.signup_trial_end_applies(v_org.id, v_sub.trial_ends_at);
  if v_kind = 'trial_ending' and not v_trial_end then
    return jsonb_build_object('refused', 'trial_end_off');
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = v_org.id and m.user_id = v_user and m.role = 'owner' and m.status = 'active')
     or (v_kind = 'welcome' and v_org.created_by is distinct from v_user) then
    return jsonb_build_object('refused', 'not_owner');
  end if;
  select u.email into v_email from auth.users u where u.id = v_user;
  if not app.email_address_ok(v_email) then
    return jsonb_build_object('refused', 'no_address');
  end if;
  update app.signup_email_sends x set composed_at = now() where x.job_id = v_job.id;
  -- USR-09's rule: a name that holds a link, an address or a scheme is never sent: the neutral word instead
  v_name := case
              when v_org.name is null or btrim(v_org.name) = '' or position('@' in v_org.name) > 0 or position('://' in v_org.name) > 0
                   or coalesce(app.message_external_link(v_org.name, null, null), true) then 'העסק'
              else v_org.name
            end;
  return jsonb_build_object(
    'to', v_email,
    'business_name', v_name,
    'kind', v_kind,
    'trial_end_day', case when v_trial_end
                          then to_char(app.signup_trial_last_day(v_sub.trial_ends_at, app.intake_zone(v_org.timezone)), 'YYYY-MM-DD') end);
end;
$$;
revoke all on function public.signup_job_compose(uuid, uuid) from public, anon, authenticated;
grant execute on function public.signup_job_compose(uuid, uuid) to service_role;
