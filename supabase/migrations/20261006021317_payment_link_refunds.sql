-- =============================================================================
-- LNK-07: refunding a payment made through a link, all or part, through the payment provider
-- =============================================================================
-- Owner (394) א: the call to the clearing provider ("creating a link, and later a refund") is an OPS-04 job kind, under
-- answer (55)'s conditions. A refund is its own kind, `payment_link.refund`, not a second mode of `payment_link.create`: its
-- payload, its rights (owners and admins, PAY-08's, judged when asked and again at the claim), its money check and its
-- "may have happened at the provider" handling differ, and each kind's claim and record stay one small pinned pair.
--
-- The flow:
--   1. public.payment_link_refund_begin(org, key, payment, amount, note) (definer, authenticated): an active owner or admin of
--      a writable business with `payments` and `payment_links` (PAY-08's refund rights); a recorded or confirmed payment that
--      paid a link (payment_links status paid with the provider's payment id) whose provider is accepted here; the amount at
--      most what the payment still holds after its active refunds and the refund requests still open. One request per
--      idempotency key (a reload answers the same request) in app.payment_link_refund_requests (no grants), and one
--      `payment_link.refund` job ({request_id} only).
--   2. public.payment_link_refund_claim(job, lease) (service_role, the live lease only) judges it all again (the requester
--      still an active owner or admin, the business writable, the payment still holding the amount, the provider accepted) and
--      answers the provider's payment id and the amount; the worker asks the provider with the REQUEST'S ID as the
--      idempotency key, so a retry never refunds twice.
--   3. public.payment_link_refund_record(job, lease, result) (service_role, the live lease only): only after the provider
--      answered ok is a public.payment_refunds row written (PAY-08's trigger applies: the status in full, released
--      allocations, the timeline), method credit, the provider's refund id as its reference, its requester as the recorder.
--      A provider failure records nothing and tells the requester; when an earlier try may have reached the provider (a
--      later try, the last try without an answer, a refund the provider made that the database could not record) the request
--      ends `unrecorded` and the requester and the active owners and admins are told to check at the provider.
--   4. public.payment_link_refund_state(org, payment): the requests of a payment (owners and admins), for the card.
--   5. public.payment_link_refund_close(org, request, outcome) (review 4, like invoice.issue's `checked`): an owner or admin
--      of a writable business closes an `unrecorded` request after checking at the provider: refunded_at_provider records
--      the refund row now (through PAY-08's trigger), not_refunded releases the amount (status `released`). Audited.
--   PAY-08's app.payment_refunds_check (021154's body) is redefined here (review 2, 3): a manual refund's cap also subtracts
--   the requests still open at the provider (pending, unrecorded), under the payment row lock both paths take; and a refund
--   row a provider request recorded is never cancelled by hand (hint refund:provider_made). PAY-08's app.payments_refund_guard
--   (021154's body, its last definition) is redefined too (delta review 2): open requests count like refunds, so while one is
--   open the payment's status moves only between recorded and confirmed and its amount stays above refunds plus open requests
--   (hint payment:refund_request_open).
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run', 'digest.send', 'report.send', 'invite.send', 'invoice.issue',
                   'payment_link.create', 'payment_link.refund']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021315's body, plus payment_link.refund (owner (394) א): exactly {request_id}
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
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The requests (schema app: no grants, RLS on without policies)
-- ----------------------------------------------------------------------------
create table if not exists app.payment_link_refund_requests (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  payment_id          uuid not null,
  link_id             uuid not null,
  idempotency_key     uuid not null,
  amount_agorot       bigint not null check (amount_agorot between 1 and 1000000000000),
  note                text check (note is null or (char_length(note) between 1 and 1000 and note = btrim(note))),
  provider            text not null check (provider in ('fake')),
  requested_by        uuid not null references auth.users (id) on delete cascade,
  status              text not null default 'pending' check (status in ('pending', 'refunded', 'failed', 'unrecorded', 'released')),
  error_code          text check (error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  provider_refund_id  text check (provider_refund_id is null or provider_refund_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  refund_id           uuid,
  job_id              uuid,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz,
  -- review 4: who closed an unrecorded request after checking at the provider, and when
  closed_by           uuid references auth.users (id) on delete set null,
  closed_at           timestamptz,
  unique (organization_id, idempotency_key),
  constraint payment_link_refund_requests_payment_fk foreign key (organization_id, payment_id)
    references public.payments (organization_id, id) on delete cascade
);
create index if not exists payment_link_refund_requests_payment_idx on app.payment_link_refund_requests (organization_id, payment_id);
create index if not exists payment_link_refund_requests_job_idx on app.payment_link_refund_requests (job_id);
create index if not exists payment_link_refund_requests_requester_idx on app.payment_link_refund_requests (requested_by);
create index if not exists payment_link_refund_requests_closer_idx on app.payment_link_refund_requests (closed_by);
create index if not exists payment_link_refund_requests_refund_idx on app.payment_link_refund_requests (organization_id, refund_id);
alter table app.payment_link_refund_requests enable row level security;
revoke all on app.payment_link_refund_requests from public, anon, authenticated, service_role;

-- What a payment can still give back: its amount less its active refunds and the refund requests still open (pending, or
-- unrecorded while nobody knows whether the provider refunded), the given request left out
create or replace function app.payment_link_refund_room(p_org uuid, p_payment uuid, p_except uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select p.amount_agorot
         - coalesce((select sum(r.amount_agorot) from public.payment_refunds r
                      where r.organization_id = p_org and r.payment_id = p_payment and r.status = 'active'), 0)
         - coalesce((select sum(q.amount_agorot) from app.payment_link_refund_requests q
                      where q.organization_id = p_org and q.payment_id = p_payment and q.status in ('pending', 'unrecorded')
                        and q.id is distinct from p_except), 0)
    from public.payments p where p.organization_id = p_org and p.id = p_payment
$$;
revoke all on function app.payment_link_refund_room(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- One `system` notice about a refund request (the amount only, never a customer's name)
create or replace function app.payment_link_refund_notice(p_req app.payment_link_refund_requests, p_kind text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_amount text := app.payment_amount_text(p_req.amount_agorot);
begin
  if p_kind = 'failed' then
    perform app.payment_link_notice(p_req.organization_id, p_req.requested_by, 'ההחזר דרך ספק הסליקה לא בוצע',
      'ספק הסליקה לא ביצע את ההחזר של ' || v_amount || '. שום דבר לא נרשם. אפשר לנסות שוב, או להחזיר בדרך אחרת ולרשום את ההחזר ידנית.');
    return;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', 'בדקו החזר אצל ספק הסליקה',
         'לא הצלחנו לברר אם ההחזר של ' || v_amount || ' בוצע אצל ספק הסליקה, או שבוצע ולא נרשם. בדקו אצל הספק, ואז סמנו בכרטיס התשלום "בוצע אצל הספק" או "לא בוצע". אל תרשמו את ההחזר ידנית.'
    from public.memberships m
   where m.organization_id = p_req.organization_id and m.status = 'active'
     and (m.role in ('owner', 'admin') or m.user_id = p_req.requested_by);
end;
$$;
revoke all on function app.payment_link_refund_notice(app.payment_link_refund_requests, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 1. The person's request (owners and admins)
-- ----------------------------------------------------------------------------
create or replace function public.payment_link_refund_begin(p_org uuid, p_key uuid, p_payment uuid, p_amount bigint, p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req app.payment_link_refund_requests;
  v_payment public.payments;
  v_link public.payment_links;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_room bigint;
  v_id uuid;
begin
  -- outsider guard first: PAY-08's refund rights, as RLS would refuse
  if auth.uid() is null or not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners and admins refund' using errcode = '42501';
  end if;
  if p_key is null or p_payment is null then
    raise exception 'a request and a payment' using errcode = '22023';
  end if;
  select * into v_req from app.payment_link_refund_requests r where r.organization_id = p_org and r.idempotency_key = p_key;
  if v_req.id is not null then
    if v_req.payment_id <> p_payment or v_req.requested_by <> auth.uid() then
      raise exception 'the key belongs to another request' using errcode = '22023';
    end if;
    return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'code', v_req.error_code);
  end if;
  if not app.org_has_feature(p_org, 'payments') then
    raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
  end if;
  if not app.org_has_feature(p_org, 'payment_links') then
    raise exception 'payment links are not in the plan' using errcode = 'P0001', hint = 'feature:payment_links';
  end if;
  -- the payment first (PAY-08's lock order), then its link
  select * into v_payment from public.payments p where p.organization_id = p_org and p.id = p_payment for update;
  if v_payment.id is null then
    raise exception 'the payment is of this business' using errcode = 'P0001', hint = 'refund:payment_state';
  end if;
  -- delta review (3): a double submit waited on the payment row above; the request the first one made is answered
  select * into v_req from app.payment_link_refund_requests r where r.organization_id = p_org and r.idempotency_key = p_key;
  if v_req.id is not null then
    if v_req.payment_id <> p_payment or v_req.requested_by <> auth.uid() then
      raise exception 'the key belongs to another request' using errcode = '22023';
    end if;
    return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'code', v_req.error_code);
  end if;
  if v_payment.status not in ('recorded', 'confirmed') then
    raise exception 'only a recorded or confirmed payment is refunded' using errcode = 'P0001', hint = 'refund:payment_state';
  end if;
  select * into v_link from public.payment_links l
   where l.organization_id = p_org and l.payment_id = p_payment and l.status = 'paid' and l.provider_payment_id is not null
   order by l.paid_at limit 1;
  if v_link.id is null then
    raise exception 'the payment did not come from a payment link' using errcode = 'P0001', hint = 'payment_link_refund:not_link';
  end if;
  if not app.payment_link_provider_usable(v_link.provider) then
    raise exception 'the payment provider is off here' using errcode = 'P0001', hint = 'payment_link:provider';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'the note is at most 1000 characters' using errcode = '22023';
  end if;
  v_room := app.payment_link_refund_room(p_org, p_payment, null);
  if p_amount is null or p_amount < 1 or p_amount > coalesce(v_room, 0) then
    raise exception 'more than the payment holds' using errcode = 'P0001', hint = 'refund:over';
  end if;
  begin
    insert into app.payment_link_refund_requests
      (organization_id, payment_id, link_id, idempotency_key, amount_agorot, note, provider, requested_by)
    values (p_org, p_payment, v_link.id, p_key, p_amount, v_note, v_link.provider, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    -- review 10: the same key sent twice at once answers the request the other call made
    select * into v_req from app.payment_link_refund_requests r where r.organization_id = p_org and r.idempotency_key = p_key;
    if v_req.payment_id <> p_payment or v_req.requested_by <> auth.uid() then
      raise exception 'the key belongs to another request' using errcode = '22023';
    end if;
    return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'code', v_req.error_code);
  end;
  update app.payment_link_refund_requests r
     set job_id = app.enqueue_job(p_org, 'payment_link.refund', jsonb_build_object('request_id', v_id::text), now())
   where r.id = v_id;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'refund_request', 'payments', p_payment, jsonb_build_object('amount_agorot', p_amount, 'request_id', v_id));
  return jsonb_build_object('request_id', v_id, 'status', 'pending');
end;
$$;
revoke all on function public.payment_link_refund_begin(uuid, uuid, uuid, bigint, text) from public, anon;
grant execute on function public.payment_link_refund_begin(uuid, uuid, uuid, bigint, text) to authenticated;

-- The requests of a payment (owners and admins; nothing for anyone else)
create or replace function public.payment_link_refund_state(p_org uuid, p_payment uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not app.is_admin(p_org) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'amount_agorot', r.amount_agorot, 'status', r.status, 'code', r.error_code,
                                        'created_at', r.created_at) order by r.created_at desc)
      from (select * from app.payment_link_refund_requests q
             where q.organization_id = p_org and q.payment_id = p_payment
             order by q.created_at desc limit 20) r), '[]'::jsonb);
end;
$$;
revoke all on function public.payment_link_refund_state(uuid, uuid) from public, anon;
grant execute on function public.payment_link_refund_state(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. The worker's claim (service_role, the job's live lease only)
-- ----------------------------------------------------------------------------
-- Answers {refused: stale} on a lease that is not this job's live one; {refused: invalid}; {refused: finished} when the
-- request already ended; {refused: <code>} after ending it (requester_gone, org_not_writable, feature:payments,
-- feature:payment_links, refund:payment_state, refund:over, payment_link:provider); else {request_id, provider,
-- provider_payment_id, amount_agorot}.
create or replace function public.payment_link_refund_claim(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req app.payment_link_refund_requests;
  v_payment public.payments;
  v_link public.payment_links;
  v_code text;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'payment_link.refund' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if not app.job_payload_ok('payment_link.refund', v_job.payload) then
    return jsonb_build_object('refused', 'invalid');
  end if;
  select * into v_req from app.payment_link_refund_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid and r.job_id = v_job.id
   for update;
  if v_req.id is null then
    return jsonb_build_object('refused', 'invalid');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('refused', 'finished');
  end if;
  select * into v_payment from public.payments p where p.organization_id = v_req.organization_id and p.id = v_req.payment_id;
  select * into v_link from public.payment_links l where l.organization_id = v_req.organization_id and l.id = v_req.link_id;
  v_code := case
    when not exists (select 1 from public.memberships m
                      where m.organization_id = v_req.organization_id and m.user_id = v_req.requested_by and m.status = 'active'
                        and m.role in ('owner', 'admin')) then 'requester_gone'
    when not app.org_writable(v_req.organization_id) then 'org_not_writable'
    when not app.org_has_feature(v_req.organization_id, 'payments') then 'feature:payments'
    when not app.org_has_feature(v_req.organization_id, 'payment_links') then 'feature:payment_links'
    when v_payment.id is null or v_payment.status not in ('recorded', 'confirmed') then 'refund:payment_state'
    when v_link.id is null or v_link.provider_payment_id is null or v_link.payment_id is distinct from v_payment.id then 'refund:payment_state'
    when not app.payment_link_provider_usable(v_req.provider) or v_link.provider <> v_req.provider then 'payment_link:provider'
    when v_req.amount_agorot > coalesce(app.payment_link_refund_room(v_req.organization_id, v_req.payment_id, v_req.id), 0) then 'refund:over'
  end;
  if v_code is not null then
    -- the first try cannot have reached the provider; a later one may have
    update app.payment_link_refund_requests r
       set status = case when v_job.attempts > 1 then 'unrecorded' else 'failed' end, error_code = v_code, finished_at = now()
     where r.id = v_req.id;
    perform app.payment_link_refund_notice(v_req, case when v_job.attempts > 1 then 'check_provider' else 'failed' end);
    return jsonb_build_object('refused', v_code);
  end if;
  return jsonb_build_object('request_id', v_req.id, 'provider', v_req.provider, 'provider_payment_id', v_link.provider_payment_id,
                            'amount_agorot', v_req.amount_agorot);
end;
$$;
revoke all on function public.payment_link_refund_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.payment_link_refund_claim(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 3. The worker's record of the provider's answer (service_role, the job's live lease only)
-- ----------------------------------------------------------------------------
-- p_result is {ok: true, provider_refund_id} or {ok: false, code, final}. Answers {status: stale} on a dead lease, else the
-- request's status after it (pending = the queue tries again).
create or replace function public.payment_link_refund_record(p_job uuid, p_lease uuid, p_result jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req app.payment_link_refund_requests;
  v_ref text;
  v_code text;
  v_state text;
  v_hint text;
  v_today date;
  v_paid_on date;
  v_refund uuid;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'payment_link.refund' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() or not app.job_payload_ok('payment_link.refund', v_job.payload) then
    return jsonb_build_object('status', 'stale');
  end if;
  -- delta review (4): the payment row first, then the request (the order of begin and close)
  perform 1 from public.payments p
    where p.organization_id = v_job.organization_id
      and p.id = (select r.payment_id from app.payment_link_refund_requests r
                   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid)
    for update;
  select * into v_req from app.payment_link_refund_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid and r.job_id = v_job.id
   for update;
  if v_req.id is null then
    return jsonb_build_object('status', 'stale');
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or jsonb_typeof(p_result -> 'ok') is distinct from 'boolean' then
    raise exception 'the provider''s answer is ok or a failure' using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('status', v_req.status, 'code', v_req.error_code);
  end if;

  if not (p_result ->> 'ok')::boolean then
    v_code := coalesce(substring(coalesce(p_result ->> 'code', '') from '^[A-Za-z0-9_.:-]{1,64}$'), 'provider_error');
    if jsonb_typeof(p_result -> 'final') = 'boolean' and (p_result ->> 'final')::boolean then
      -- after an earlier try a refusal now does not prove the earlier one refunded nothing
      update app.payment_link_refund_requests r
         set status = case when v_job.attempts > 1 then 'unrecorded' else 'failed' end, error_code = v_code, finished_at = now()
       where r.id = v_req.id;
      perform app.payment_link_refund_notice(v_req, case when v_job.attempts > 1 then 'check_provider' else 'failed' end);
      return jsonb_build_object('status', case when v_job.attempts > 1 then 'unrecorded' else 'failed' end, 'code', v_code);
    end if;
    if v_job.attempts >= app.job_max_attempts() then
      update app.payment_link_refund_requests r set status = 'unrecorded', error_code = 'retries_spent', finished_at = now()
       where r.id = v_req.id;
      perform app.payment_link_refund_notice(v_req, 'check_provider');
      return jsonb_build_object('status', 'unrecorded', 'code', 'retries_spent');
    end if;
    update app.payment_link_refund_requests r set error_code = v_code where r.id = v_req.id;
    return jsonb_build_object('status', 'pending', 'code', v_code);
  end if;

  v_ref := p_result ->> 'provider_refund_id';
  if v_ref is null or v_ref !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    raise exception 'the provider''s answer is a refund id' using errcode = '22023';
  end if;
  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = v_req.organization_id;
  select p.paid_on into v_paid_on from public.payments p where p.organization_id = v_req.organization_id and p.id = v_req.payment_id;
  begin
    -- the request leaves the open ones first, so PAY-08's cap does not count it twice (rolled back with the block)
    update app.payment_link_refund_requests r set status = 'refunded' where r.id = v_req.id;
    insert into public.payment_refunds
      (organization_id, payment_id, amount_agorot, refunded_on, method, reference, note, created_by)
    values
      (v_req.organization_id, v_req.payment_id, v_req.amount_agorot, greatest(coalesce(v_today, current_date), coalesce(v_paid_on, v_today)),
       'credit', left(v_ref, 100), v_req.note, v_req.requested_by)
    returning id into v_refund;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_state in ('40P01', '40001', '55P03') then
      raise;
    end if;
    -- the provider refunded and the database could not record it: kept, told, and nothing is lost
    v_code := coalesce(substring(coalesce(nullif(v_hint, ''), v_state, '') from '^[A-Za-z0-9_.:-]{1,64}$'), 'not_recorded');
    update app.payment_link_refund_requests r
       set status = 'unrecorded', provider_refund_id = v_ref, error_code = v_code, finished_at = now()
     where r.id = v_req.id;
    perform app.payment_link_refund_notice(v_req, 'check_provider');
    return jsonb_build_object('status', 'unrecorded', 'code', v_code);
  end;
  update app.payment_link_refund_requests r
     set status = 'refunded', provider_refund_id = v_ref, refund_id = v_refund, error_code = null, finished_at = now()
   where r.id = v_req.id;
  return jsonb_build_object('status', 'refunded', 'refund_id', v_refund);
end;
$$;
revoke all on function public.payment_link_refund_record(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.payment_link_refund_record(uuid, uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 5. Closing an unrecorded request after checking at the provider (owners and admins; review 4)
-- ----------------------------------------------------------------------------
-- p_outcome: refunded_at_provider (the refund row is recorded now, with the closer as its recorder) | not_refunded (the
-- amount is released). Only an `unrecorded` request; answers {status}.
create or replace function public.payment_link_refund_close(p_org uuid, p_request uuid, p_outcome text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req app.payment_link_refund_requests;
  v_today date;
  v_paid_on date;
  v_refund uuid;
begin
  if auth.uid() is null or not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners and admins close a refund request' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('refunded_at_provider', 'not_refunded') then
    raise exception 'refunded at the provider or not' using errcode = '22023';
  end if;
  -- the payment first (PAY-08's lock order), then the request
  perform 1 from public.payments p
    where p.organization_id = p_org
      and p.id = (select r.payment_id from app.payment_link_refund_requests r where r.organization_id = p_org and r.id = p_request)
    for update;
  select * into v_req from app.payment_link_refund_requests r where r.organization_id = p_org and r.id = p_request for update;
  if v_req.id is null then
    raise exception 'no such refund request' using errcode = 'P0001', hint = 'payment_link_refund:closed';
  end if;
  if v_req.status <> 'unrecorded' then
    raise exception 'only an unrecorded refund request is closed' using errcode = 'P0001', hint = 'payment_link_refund:closed';
  end if;
  if p_outcome = 'not_refunded' then
    update app.payment_link_refund_requests r
       set status = 'released', closed_by = auth.uid(), closed_at = now()
     where r.id = v_req.id;
  else
    -- delta review (1): a refund already recorded with the provider's refund id (by hand) is not recorded a second time
    if v_req.provider_refund_id is not null
       and exists (select 1 from public.payment_refunds f
                    where f.organization_id = p_org and f.payment_id = v_req.payment_id and f.status = 'active'
                      and f.reference = left(v_req.provider_refund_id, 100)) then
      raise exception 'this provider refund is already recorded' using errcode = 'P0001', hint = 'payment_link_refund:recorded';
    end if;
    select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
      from public.organizations o where o.id = p_org;
    select p.paid_on into v_paid_on from public.payments p where p.organization_id = p_org and p.id = v_req.payment_id;
    -- leaves the open requests first, so PAY-08's cap does not count it twice; PAY-08's trigger judges the rest
    update app.payment_link_refund_requests r
       set status = 'refunded', closed_by = auth.uid(), closed_at = now()
     where r.id = v_req.id;
    insert into public.payment_refunds
      (organization_id, payment_id, amount_agorot, refunded_on, method, reference, note, created_by)
    values
      (p_org, v_req.payment_id, v_req.amount_agorot, greatest(coalesce(v_today, current_date), coalesce(v_paid_on, v_today)),
       'credit', left(v_req.provider_refund_id, 100), v_req.note, auth.uid())
    returning id into v_refund;
    update app.payment_link_refund_requests r set refund_id = v_refund where r.id = v_req.id;
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'refund_request_close', 'payments', v_req.payment_id,
          jsonb_build_object('request_id', v_req.id, 'outcome', p_outcome, 'amount_agorot', v_req.amount_agorot));
  return jsonb_build_object('status', case when p_outcome = 'not_refunded' then 'released' else 'refunded' end);
end;
$$;
revoke all on function public.payment_link_refund_close(uuid, uuid, text) from public, anon;
grant execute on function public.payment_link_refund_close(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- PAY-08's refund rules: 021154's body, plus the open provider requests in the cap (review 2) and no hand cancel of a
-- provider-made refund (review 3)
-- ----------------------------------------------------------------------------
create or replace function app.payment_refunds_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_doc public.accounting_documents;
  v_refunded bigint;
begin
  -- outsider guard: RLS refuses (42501) a person who may not refund here, before anything is revealed
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- the currency is held to 'ILS' by its check until DEAL-12 (as payment_allocations): a change of it is the check's to refuse
    if new.currency is distinct from old.currency then
      return new;
    end if;
    -- the FK's own set-null of the credit document (a nested trigger): only that passes
    if pg_trigger_depth() > 1 and new.credit_document_id is null
       and row(new.organization_id, new.payment_id, new.amount_agorot, new.currency, new.refunded_on, new.method, new.reference,
               new.note, new.status, new.cancel_reason, new.cancelled_at, new.cancelled_by, new.payment_status_before,
               new.created_by, new.created_at)
           is not distinct from
           row(old.organization_id, old.payment_id, old.amount_agorot, old.currency, old.refunded_on, old.method, old.reference,
               old.note, old.status, old.cancel_reason, old.cancelled_at, old.cancelled_by, old.payment_status_before,
               old.created_by, old.created_at) then
      return new;
    end if;
    -- a privacy erasure (payments_zz_refunds_erase sets app.payment_server = 'erase'): reference and note emptied, a cancel
    -- reason replaced by the neutral text; nothing else
    if current_setting('app.payment_server', true) = 'erase'
       and new.reference is null and new.note is null
       and (new.cancel_reason is not distinct from old.cancel_reason
            or (old.status = 'cancelled' and new.cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'))
       and row(new.organization_id, new.payment_id, new.amount_agorot, new.currency, new.refunded_on, new.method,
               new.credit_document_id, new.status, new.cancelled_at, new.cancelled_by, new.payment_status_before,
               new.created_by, new.created_at)
           is not distinct from
           row(old.organization_id, old.payment_id, old.amount_agorot, old.currency, old.refunded_on, old.method,
               old.credit_document_id, old.status, old.cancelled_at, old.cancelled_by, old.payment_status_before,
               old.created_by, old.created_at) then
      return new;
    end if;
    if old.status = 'cancelled' then
      raise exception 'a cancelled refund stays cancelled' using errcode = 'P0001', hint = 'refund:cancelled';
    end if;
    -- LNK-07 review (3): the provider made this refund (a payment link's refund request recorded it); cancelling it here would
    -- free money the provider already gave back
    if exists (select 1 from app.payment_link_refund_requests q
                where q.organization_id = old.organization_id and q.refund_id = old.id) then
      raise exception 'the payment provider made this refund' using errcode = 'P0001', hint = 'refund:provider_made';
    end if;
    if row(new.organization_id, new.payment_id, new.amount_agorot, new.currency, new.refunded_on, new.method, new.reference,
           new.note, new.credit_document_id, new.payment_status_before, new.created_by, new.created_at)
       is distinct from
       row(old.organization_id, old.payment_id, old.amount_agorot, old.currency, old.refunded_on, old.method, old.reference,
           old.note, old.credit_document_id, old.payment_status_before, old.created_by, old.created_at)
       or new.status <> 'cancelled' then
      raise exception 'a refund is cancelled, never changed' using errcode = 'P0001', hint = 'refund:frozen';
    end if;
    new.cancel_reason := nullif(btrim(coalesce(new.cancel_reason, '')), '');
    if new.cancel_reason is null or char_length(new.cancel_reason) > 500 then
      raise exception 'cancelling a refund needs a reason' using errcode = 'P0001', hint = 'refund:cancel_reason';
    end if;
    -- the payment first (the lock order of an insert)
    perform 1 from public.payments p where p.organization_id = new.organization_id and p.id = new.payment_id for update;
    new.cancelled_at := now();
    new.cancelled_by := auth.uid();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
    return new;
  end if;

  -- INSERT
  new.reference := nullif(btrim(coalesce(new.reference, '')), '');
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  new.status := 'active';
  new.cancel_reason := null;
  new.cancelled_at := null;
  new.cancelled_by := null;
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.updated_by := new.created_by;
  if not app.org_has_feature(new.organization_id, 'payments') then
    raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
  end if;
  select * into v_payment from public.payments p
   where p.organization_id = new.organization_id and p.id = new.payment_id for update;
  if v_payment.id is null then
    raise exception 'the payment is of this business' using errcode = 'P0001', hint = 'refund:payment_state';
  end if;
  if v_payment.status not in ('recorded', 'confirmed') then
    raise exception 'only a recorded or confirmed payment is refunded' using errcode = 'P0001', hint = 'refund:payment_state';
  end if;
  if new.refunded_on < v_payment.paid_on then
    raise exception 'a refund is not dated before its payment' using errcode = 'P0001', hint = 'refund:date';
  end if;
  select coalesce(sum(r.amount_agorot), 0) into v_refunded from public.payment_refunds r
   where r.organization_id = new.organization_id and r.payment_id = new.payment_id and r.status = 'active';
  -- LNK-07 review (2): the refund requests still open at the payment provider (pending, or unrecorded while nobody knows) hold
  -- their amount too, judged under the same payment row lock their requests take
  v_refunded := v_refunded + coalesce((select sum(q.amount_agorot) from app.payment_link_refund_requests q
                                        where q.organization_id = new.organization_id and q.payment_id = new.payment_id
                                          and q.status in ('pending', 'unrecorded')), 0);
  if v_refunded + new.amount_agorot > v_payment.amount_agorot then
    raise exception 'more than the payment holds' using errcode = 'P0001', hint = 'refund:over';
  end if;
  if new.credit_document_id is not null then
    select * into v_doc from public.accounting_documents d
     where d.organization_id = new.organization_id and d.id = new.credit_document_id;
    if v_doc.id is null or v_doc.doc_type <> 'credit_invoice' or v_doc.status <> 'active'
       or not coalesce(app.money_same_customer(new.organization_id, v_payment.deal_id, v_payment.contact_id,
                                               v_doc.deal_id, v_doc.contact_id), false) then
      raise exception 'only an active credit invoice of the same customer' using errcode = 'P0001', hint = 'refund:credit_document';
    end if;
  end if;
  new.payment_status_before := v_payment.status;
  return new;
end;
$$;
revoke all on function app.payment_refunds_check() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- PAY-08's guard on a payment with refunds: 021154's body, plus the open provider requests (delta review 2)
-- ----------------------------------------------------------------------------
create or replace function app.payments_refund_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_refunded bigint;
  v_open bigint;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record payments here
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if coalesce(current_setting('app.payment_server', true), '') = 'refund' then
    return new;
  end if;
  select coalesce(sum(r.amount_agorot), 0) into v_refunded from public.payment_refunds r
   where r.organization_id = new.organization_id and r.payment_id = new.id and r.status = 'active';
  -- LNK-07 delta review (2): a refund asked of the payment provider and still open (pending, or unrecorded until someone
  -- checks) holds its amount like a refund, so the payment keeps its status and enough amount for it
  select coalesce(sum(q.amount_agorot), 0) into v_open from app.payment_link_refund_requests q
   where q.organization_id = new.organization_id and q.payment_id = new.id and q.status in ('pending', 'unrecorded');
  v_refunded := v_refunded + v_open;
  if v_refunded = 0 then
    return new;
  end if;
  if new.status is distinct from old.status
     and not (new.status in ('recorded', 'confirmed') and old.status in ('recorded', 'confirmed')) then
    if v_open > 0 then
      raise exception 'a refund through the payment provider is still open' using errcode = 'P0001', hint = 'payment:refund_request_open';
    end if;
    raise exception 'the payment has refunds; cancel them first' using errcode = 'P0001', hint = 'payment:has_refunds';
  end if;
  if new.amount_agorot is distinct from old.amount_agorot then
    -- refunded in full: a correction would leave a surplus nobody counts; cancel the refunds first
    if old.status = 'refunded' then
      raise exception 'the payment has refunds; cancel them first' using errcode = 'P0001', hint = 'payment:has_refunds';
    end if;
    -- a recorded or confirmed payment keeps something counted: never down to its refunds or below
    if new.amount_agorot <= v_refunded and v_open > 0 then
      raise exception 'a refund through the payment provider is still open' using errcode = 'P0001', hint = 'payment:refund_request_open';
    end if;
    if new.amount_agorot <= v_refunded then
      raise exception 'the payment has more refunded than the new amount' using errcode = 'P0001', hint = 'payment:refunded_amount';
    end if;
    -- allocations are capped by the amount less ACTIVE refunds only (021154's meaning); open requests are not part of it
    if new.amount_agorot - (v_refunded - v_open) < app.allocated_on_payment(new.organization_id, new.id, null) then
      raise exception 'the payment has more allocated than the new amount' using errcode = 'P0001', hint = 'payment:allocated';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.payments_refund_guard() from public, anon, authenticated;
