-- =============================================================================
-- DOC-07 / DOC-08 / DOC-09 (first part): issuing a document through the business's invoice provider
-- =============================================================================
-- Owner (270) (1) א: behind the fake provider, hidden on the live site (src/features/invoicing/providers/select.ts). Owner
-- (398) א (16 November 2026): the call to the provider and the recording of its answer are the OPS-04 background worker's,
-- under answer (55)'s conditions: a new job kind `invoice.issue` whose payload is the request's id only; the worker calls
-- with the service key only the two service_role functions below (no table access); a person never records a provider's
-- answer (no function taking one is granted to `authenticated`).
--
-- The flow:
--   1. public.invoice_issue_customer(org, kind, id): who the document will name, and what is missing (DOC-08), for the
--      preview. INVOKER: the source and its customer are read under the caller's RLS.
--   2. public.invoice_issue_begin(org, key, kind, id, doc), the person's session: INVOKER wrapper; the source (a deal, a
--      contact, an accepted quote or a numbered order) is read under the caller's RLS by app.invoice_source, then
--      app.invoice_issue_open (definer) judges the person, the business, the connection, the lines and the customer,
--      computes the totals in the database (app.document_totals at the day's rate, never the browser's numbers), keeps one
--      request per idempotency key (DOC-09) in app.invoice_issue_requests and queues one `invoice.issue` job for it
--      ({request_id}). The same key again answers the same request (and, once ended, its outcome). A reload: the same
--      person, source and type while their own request of the last 15 minutes is still pending gets that request back
--      (`reused`), so reloading the page never issues a second document by accident.
--   3. The worker (src/features/invoicing/issue-handler.ts through src/features/jobs/run-server.ts) claims the job, asks
--      public.invoice_issue_claim(job, lease) (service_role, the live lease only): the request while still pending, its
--      requester still an active member (owner's review item 2: the issuing right is judged at begin; once a request exists
--      only membership is asked), the provider on the closed list and still the business's connection, the business still
--      able to record documents; a refusal ends the request `failed` (first try: nothing can have been issued) or
--      `unrecorded` (a later try: an earlier one may have reached the provider) with its code. It answers the stored
--      request, which the worker sends to the provider with the request's id as the provider's idempotency key, so retries
--      never issue twice.
--   4. public.invoice_issue_record(job, lease, result) (service_role, the live lease only) keeps the provider's answer: a
--      refusal (final) ends the request `failed`; a retryable failure leaves it pending for the queue's next try, or ends it
--      `unrecorded` (`retries_spent`) on the last try; an issued document is recorded once (accounting_documents with
--      provider + provider_document_id, DOC-02's server-only columns, the allocation number, the VAT split and the lines)
--      from the request's stored amounts, while the business can still record (else `unrecorded` with org_not_writable |
--      feature:documents and the provider's id and number). created_by is the requester, and the audit entries of the
--      document and its lines are stamped with the requester as their actor (owner's review item 6). A receipt records no
--      VAT split (its amount is the money received). A number recorded by hand before (document:duplicate) stays on the
--      request as `unrecorded`; DOC-11's sync will attach it.
--   5. public.invoice_issue_state(org, request): the page's poll (the requester, or an owner/admin): status, document,
--      number, code. public.invoice_issue_requests_open(org) lists the open (pending or stale) requests, all of them to
--      owners and admins, one's own to anyone else; public.invoice_issue_close(org, request) marks one `unrecorded` (code
--      `closed`) for its requester or an owner/admin. pg_cron `crm-invoice-issue-stale` (hourly, app.invoice_issue_mark_stale)
--      marks a request pending for over 24 hours `stale`, and a pending request whose job died or was refused `unrecorded`
--      (job_dead). Nothing is deleted. A request closed or marked stale after an earlier try of its job was claimed may
--      already exist at the provider: the job's next try only LOOKS IT UP by the same key (never issues) and records what it
--      finds, or keeps it as issued_after_close with a notice; not found leaves it final; a lookup that gets no answer is
--      tried again and, on the queue's last try, the people are told to check at the provider (check_provider). One closed
--      before any try was claimed stays final. Nothing is recorded in the name of someone who is no longer a member.
--      Review of DOC-07 (17 November 2026): wherever a document may exist at the provider and nothing could find out
--      (retries_spent, job_dead, a refusal after an earlier try, a late lookup that could not be made, a late request whose
--      job died) the requester and the active owners and admins get one `system` notice to check at the provider
--      (app.invoice_issue_late_notice 'check_provider', nothing personal), and the request is listed by
--      invoice_issue_requests_open as `check` until someone closes it (code `checked`). A provider document the business
--      could not record (org_not_writable, feature:documents, a refused record) is told too ('cannot_record', its number
--      only). A late lookup stays final silently only on not_at_provider; any other final refusal of it, and a final refusal
--      after an earlier try, is told and listed. A job refused on its first try ends its request `failed` (job_refused),
--      no alarm. A cancelled order is no source (hint invoice:order_cancelled), also when cancelled before the first claim.
--   Privacy: an erasure of the source contact, company or deal empties the request's customer block and line texts (also 12
--   months after a request ended); a merge moves a duplicate's requests to the kept record first; a request whose customer
--   was erased is never sent (customer_erased).
-- The providers are a closed list (app.invoice_provider_usable): today only the fake, accepted at begin, claim and record
-- only while the app.settings key `invoice_provider_fake` is 'on' (never set by a migration; unset on the hosted project).
-- The adapter is still only the fake, refused on Vercel production and preview (select.ts).
-- VAT (TAX-01): a business that charges no VAT (exempt, nonprofit) issues no tax invoice or tax invoice-receipt
-- (hint invoice:type_exempt).
--
-- Who issues (DOC-17): app.can_issue_documents (owners, admins, the key `issue_documents`), in a writable business with the
-- `documents` key and a connected provider. DOC-08: a business customer (a company, or a contact with a tax id) needs a tax
-- id and an address; every customer needs a name (hint invoice:customer, the missing parts in the answer).
-- Every statement is safe to run twice. No drops, no row removal, no escaped code points.

-- ----------------------------------------------------------------------------
-- The job kind (owner (398) א) and its payload
-- ----------------------------------------------------------------------------
create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run', 'digest.send', 'report.send', 'invite.send', 'invoice.issue']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021290's body, plus invoice.issue (owner (398) א): exactly {request_id}
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
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The requests (schema app: no grants, RLS on without policies)
-- ----------------------------------------------------------------------------
create table if not exists app.invoice_issue_requests (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  idempotency_key       uuid not null,
  requested_by          uuid not null,
  provider              text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  source                jsonb not null,
  payload               jsonb not null,
  status                text not null default 'pending' check (status in ('pending', 'issued', 'unrecorded', 'failed', 'stale')),
  document_id           uuid,
  provider_document_id  text,
  number                text,
  allocation_number     text,
  allocation_failure    text,
  error_code            text,
  created_at            timestamptz not null default now(),
  finished_at           timestamptz,
  closed_by             uuid,
  job_id                uuid,
  -- the customer block and the line texts emptied (privacy erasure of the source, or 12 months after the request ended)
  customer_erased_at    timestamptz,
  unique (organization_id, id),
  constraint invoice_issue_requests_key_once unique (organization_id, idempotency_key),
  constraint invoice_issue_requests_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete set null (document_id)
);
create index if not exists invoice_issue_requests_document_idx on app.invoice_issue_requests (organization_id, document_id);
create index if not exists invoice_issue_requests_open_idx on app.invoice_issue_requests (organization_id, requested_by, created_at)
  where status = 'pending';
create index if not exists invoice_issue_requests_job_idx on app.invoice_issue_requests (job_id);
create index if not exists invoice_issue_requests_stale_idx on app.invoice_issue_requests (created_at) where status = 'pending';
create index if not exists invoice_issue_requests_retention_idx on app.invoice_issue_requests (finished_at)
  where customer_erased_at is null;
alter table app.invoice_issue_requests enable row level security;
revoke all on app.invoice_issue_requests from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The source, read under the caller's RLS (invoker): a deal, a contact, an accepted quote or a numbered order
-- ----------------------------------------------------------------------------
create or replace function app.invoice_source(p_org uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_deal uuid;
  v_contact uuid;
  v_company uuid;
  v_order uuid;
  v_quote uuid;
  v_status text;
begin
  if p_kind = 'deal' then
    select d.id, d.contact_id, d.company_id into v_deal, v_contact, v_company
      from public.deals d where d.organization_id = p_org and d.id = p_id and d.deleted_at is null;
    if not found then v_deal := null; end if;
    if v_deal is null then
      raise exception 'the source is not found' using errcode = 'P0001', hint = 'invoice:source';
    end if;
  elsif p_kind = 'contact' then
    select c.id, c.company_id into v_contact, v_company
      from public.contacts c where c.organization_id = p_org and c.id = p_id and c.deleted_at is null;
    if v_contact is null then
      raise exception 'the source is not found' using errcode = 'P0001', hint = 'invoice:source';
    end if;
  elsif p_kind = 'quote' then
    select q.id, q.deal_id, q.contact_id, q.company_id, q.status into v_quote, v_deal, v_contact, v_company, v_status
      from public.quotes q where q.organization_id = p_org and q.id = p_id;
    if v_quote is null or v_status <> 'accepted' then
      raise exception 'the source is not found' using errcode = 'P0001', hint = 'invoice:source';
    end if;
  elsif p_kind = 'order' then
    select o.id, o.deal_id, o.contact_id, o.company_id, o.status into v_order, v_deal, v_contact, v_company, v_status
      from public.orders o where o.organization_id = p_org and o.id = p_id;
    if v_order is null or v_status = 'draft' then
      raise exception 'the source is not found' using errcode = 'P0001', hint = 'invoice:source';
    end if;
    -- a cancelled order is billed by nothing (lead's decision, review of DOC-07)
    if v_status = 'cancelled' then
      raise exception 'a cancelled order is not a source' using errcode = 'P0001', hint = 'invoice:order_cancelled';
    end if;
  else
    raise exception 'unknown source kind' using errcode = '22023';
  end if;

  -- a linked deal, contact or company the caller does not read (or in the bin) is left out, as RVW-45 does for documents
  if v_deal is not null and not exists (select 1 from public.deals d
                                         where d.organization_id = p_org and d.id = v_deal and d.deleted_at is null) then
    v_deal := null;
  end if;
  if v_contact is not null and not exists (select 1 from public.contacts c
                                            where c.organization_id = p_org and c.id = v_contact and c.deleted_at is null) then
    v_contact := null;
  end if;
  -- the customer's company: the source's own, else the contact's
  if v_company is null and v_contact is not null then
    select c.company_id into v_company from public.contacts c where c.organization_id = p_org and c.id = v_contact;
  end if;
  if v_company is not null and not exists (select 1 from public.companies co
                                            where co.organization_id = p_org and co.id = v_company and co.deleted_at is null) then
    v_company := null;
  end if;
  return jsonb_build_object('kind', p_kind, 'id', p_id, 'deal_id', v_deal, 'contact_id', v_contact, 'company_id', v_company,
                            'order_id', v_order, 'quote_id', v_quote);
end;
$$;
revoke all on function app.invoice_source(uuid, text, uuid) from public, anon;
grant execute on function app.invoice_source(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer as the document names it, and what is missing (DOC-08). Definer: called only with ids the caller's own
-- app.invoice_source read under RLS (schema app is not in the API).
-- A contact's own billing field wins, else its company's (app.quote_customer_billing's rule, effectiveBilling()).
-- ----------------------------------------------------------------------------
create or replace function app.invoice_customer(p_org uuid, p_contact uuid, p_company uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_company public.companies;
  v_name text;
  v_tax text;
  v_address text;
  v_email text;
  v_business boolean;
  v_problems text[] := '{}';
begin
  if not app.is_member(p_org) then
    raise exception 'only members read a customer' using errcode = '42501';
  end if;
  if p_contact is not null then
    select * into v_contact from public.contacts c where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null;
  end if;
  if p_company is not null then
    select * into v_company from public.companies co where co.organization_id = p_org and co.id = p_company and co.deleted_at is null;
  end if;
  v_name := coalesce(nullif(btrim(v_contact.billing_name), ''), nullif(btrim(v_company.billing_name), ''),
                     nullif(btrim(v_company.name), ''), nullif(btrim(v_contact.full_name), ''));
  v_tax := coalesce(nullif(btrim(v_contact.billing_tax_id), ''), nullif(btrim(v_company.tax_id), ''));
  v_address := coalesce(nullif(btrim(v_contact.billing_address), ''), nullif(btrim(v_company.billing_address), ''),
                        nullif(concat_ws(', ', nullif(btrim(v_company.address_line), ''), nullif(btrim(v_company.city), '')), ''),
                        nullif(concat_ws(', ', nullif(btrim(v_contact.address_line), ''), nullif(btrim(v_contact.city), '')), ''));
  v_email := coalesce(nullif(btrim(v_contact.billing_email), ''), nullif(btrim(v_company.billing_email), ''),
                      nullif(btrim(v_contact.email), ''), nullif(btrim(v_company.email), ''));
  v_business := v_company.id is not null or nullif(btrim(v_contact.billing_tax_id), '') is not null;
  if v_name is null then
    v_problems := v_problems || 'name'::text;
  end if;
  if v_business and v_tax is null then
    v_problems := v_problems || 'tax_id'::text;
  end if;
  if v_business and v_address is null then
    v_problems := v_problems || 'address'::text;
  end if;
  return jsonb_build_object(
    'external_ref', case when v_contact.id is not null then 'contact:' || v_contact.id::text
                         when v_company.id is not null then 'company:' || v_company.id::text end,
    'name', v_name, 'tax_id', v_tax, 'address', v_address, 'email', v_email, 'is_business', v_business,
    'problems', to_jsonb(v_problems));
end;
$$;
revoke all on function app.invoice_customer(uuid, uuid, uuid) from public, anon;
grant execute on function app.invoice_customer(uuid, uuid, uuid) to authenticated;

-- the connection the business issues through, or null
create or replace function app.invoice_provider_of(p_org uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select s.provider from public.invoice_provider_settings s where s.organization_id = p_org and s.status = 'connected';
$$;
revoke all on function app.invoice_provider_of(uuid) from public, anon, authenticated, service_role;

-- one person who may issue here now, or 42501 / feature:documents
create or replace function app.invoice_issuer_check(p_org uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not (app.can_issue_documents(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners, admins and holders of the issuing permission issue documents' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'documents') then
    raise exception 'the plan has no documents' using errcode = 'P0001', hint = 'feature:documents';
  end if;
end;
$$;
revoke all on function app.invoice_issuer_check(uuid) from public, anon;
grant execute on function app.invoice_issuer_check(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 1. The preview's customer
-- ----------------------------------------------------------------------------
create or replace function public.invoice_issue_customer(p_org uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_source jsonb;
begin
  perform app.invoice_issuer_check(p_org);
  v_source := app.invoice_source(p_org, p_kind, p_id);
  return app.invoice_customer(p_org, (v_source ->> 'contact_id')::uuid, (v_source ->> 'company_id')::uuid)
         || jsonb_build_object('source', v_source);
end;
$$;
revoke all on function public.invoice_issue_customer(uuid, text, uuid) from public, anon;
grant execute on function public.invoice_issue_customer(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Begin: one request per idempotency key
-- ----------------------------------------------------------------------------
create or replace function app.invoice_issue_open(p_org uuid, p_key uuid, p_source jsonb, p_doc jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_known app.invoice_issue_requests;
  v_type text;
  v_today date;
  v_date date;
  v_due date;
  v_gross boolean;
  v_rate integer;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_desc text;
  v_qty numeric;
  v_price numeric;
  v_discount numeric;
  v_exempt boolean;
  v_totals jsonb;
  v_customer jsonb;
  v_payload jsonb;
  v_id uuid;
  v_settings public.invoice_provider_settings;
  v_reuse app.invoice_issue_requests;
begin
  perform app.invoice_issuer_check(p_org);
  if p_key is null then
    raise exception 'a request needs its key' using errcode = '22023';
  end if;

  -- DOC-09: one request per key; the same key again answers the first request, whatever else was sent
  perform pg_advisory_xact_lock(hashtextextended('invoice_issue:' || p_org::text || ':' || p_key::text, 0));
  select * into v_known from app.invoice_issue_requests r where r.organization_id = p_org and r.idempotency_key = p_key;
  if found then
    if v_known.requested_by is distinct from auth.uid() then
      raise exception 'this request is someone else''s' using errcode = 'P0001', hint = 'invoice:request';
    end if;
    return jsonb_build_object('status', v_known.status, 'request_id', v_known.id, 'provider', v_known.provider,
                              'document_id', v_known.document_id, 'number', v_known.number, 'code', v_known.error_code,
                              'request', v_known.payload);
  end if;

  v_provider := app.invoice_provider_of(p_org);
  if v_provider is null then
    raise exception 'the business has no connected invoice provider' using errcode = 'P0001', hint = 'invoice:not_connected';
  end if;
  if not app.invoice_provider_usable(v_provider) then
    raise exception 'this provider is not offered' using errcode = 'P0001', hint = 'invoice:provider';
  end if;
  select * into v_settings from public.invoice_provider_settings s where s.organization_id = p_org;

  if p_doc is null or jsonb_typeof(p_doc) <> 'object' or jsonb_typeof(p_doc -> 'lines') is distinct from 'array' then
    raise exception 'a document is an object with its lines' using errcode = '22023';
  end if;
  v_type := p_doc ->> 'doc_type';
  if v_type is null or v_type not in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'proforma') then
    raise exception 'this type is not issued here' using errcode = 'P0001', hint = 'invoice:type';
  end if;
  if v_type in ('tax_invoice', 'tax_invoice_receipt') and app.org_charges_vat(p_org) is false then
    raise exception 'a business that charges no VAT issues no tax invoice' using errcode = 'P0001', hint = 'invoice:type_exempt';
  end if;

  -- a reload: the same person, source and type, with their own request of the last 15 minutes still pending, gets it back
  perform pg_advisory_xact_lock(hashtextextended('invoice_issue_source:' || p_org::text || ':' || auth.uid()::text || ':'
                                                 || coalesce(p_source ->> 'kind', '') || ':' || coalesce(p_source ->> 'id', ''), 0));
  select * into v_reuse from app.invoice_issue_requests r
   where r.organization_id = p_org and r.requested_by = auth.uid() and r.status = 'pending'
     and r.created_at > now() - interval '15 minutes'
     and r.source ->> 'kind' = p_source ->> 'kind' and r.source ->> 'id' = p_source ->> 'id'
     and r.payload ->> 'doc_type' = v_type
   order by r.created_at desc
   limit 1;
  if found then
    return jsonb_build_object('status', 'pending', 'request_id', v_reuse.id, 'provider', v_reuse.provider, 'reused', true,
                              'request', v_reuse.payload);
  end if;
  v_today := (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date;
  begin
    v_date := coalesce((p_doc ->> 'doc_date')::date, v_today);
    v_due := (p_doc ->> 'due_date')::date;
  exception when others then
    raise exception 'a date is YYYY-MM-DD' using errcode = 'P0001', hint = 'invoice:date';
  end;
  if v_date > v_today or v_date < v_today - 365 then
    raise exception 'the document''s date is today or up to a year back' using errcode = 'P0001', hint = 'invoice:date';
  end if;
  if v_due is not null and (v_type not in ('tax_invoice', 'proforma') or v_due < v_date or v_due > v_date + 366) then
    raise exception 'a due date belongs on a tax invoice or a proforma, on or after its date' using errcode = 'P0001', hint = 'invoice:due_date';
  end if;
  begin
    v_gross := coalesce((p_doc ->> 'prices_include_vat')::boolean, false);
  exception when others then
    raise exception 'prices include VAT or not' using errcode = 'P0001', hint = 'invoice:lines';
  end;

  if jsonb_array_length(p_doc -> 'lines') = 0 or jsonb_array_length(p_doc -> 'lines') > 200 then
    raise exception 'a document has 1 to 200 lines' using errcode = 'P0001', hint = 'invoice:lines';
  end if;
  for v_line in select x from jsonb_array_elements(p_doc -> 'lines') x loop
    begin
      if jsonb_typeof(v_line) <> 'object' then
        raise exception 'a line is an object';
      end if;
      v_desc := btrim(coalesce(v_line ->> 'description', ''));
      v_qty := (v_line ->> 'quantity')::numeric;
      v_price := (v_line ->> 'unit_price_agorot')::numeric;
      v_discount := coalesce((v_line ->> 'discount_agorot')::numeric, 0);
      v_exempt := coalesce((v_line ->> 'vat_exempt')::boolean, false);
    exception when others then
      raise exception 'a line is description, quantity, price' using errcode = 'P0001', hint = 'invoice:lines';
    end;
    if v_desc = '' or char_length(v_desc) > 500 or v_desc ~ '[[:cntrl:]]'
       or v_qty is null or v_qty <= 0 or v_qty > 1000000 or v_qty <> round(v_qty, 3)
       or v_price is null or v_price < 0 or v_price > 1000000000000 or v_price <> trunc(v_price)
       or v_discount < 0 or v_discount <> trunc(v_discount) then
      raise exception 'a line is description, quantity, price' using errcode = 'P0001', hint = 'invoice:lines';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description', v_desc, 'quantity', v_qty, 'unit_price_agorot', v_price::bigint,
      'discount_agorot', v_discount::bigint, 'vat_exempt', v_exempt));
  end loop;

  v_rate := app.org_document_vat_rate(p_org, v_date);
  if v_rate is null then
    raise exception 'set the business''s VAT status first' using errcode = 'P0001', hint = 'invoice:vat_unknown';
  end if;
  -- a receipt is the money received: its typed amounts are what was paid, no VAT added or split (TAX-01)
  if v_type = 'receipt' then
    v_rate := 0;
  end if;
  begin
    v_totals := app.document_totals(v_lines, v_rate, v_gross);
  exception when sqlstate '22023' then
    raise exception 'a line is description, quantity, price' using errcode = 'P0001', hint = 'invoice:lines';
  end;
  if (v_totals ->> 'total_agorot')::bigint <= 0 or (v_totals ->> 'total_agorot')::bigint > 1000000000000 then
    raise exception 'the document''s total is above zero' using errcode = 'P0001', hint = 'invoice:total';
  end if;

  -- every id the source names is of this business (app.invoice_source read them under the caller's RLS; checked again here)
  if (p_source ->> 'deal_id' is not null
        and not exists (select 1 from public.deals d where d.organization_id = p_org and d.id = (p_source ->> 'deal_id')::uuid))
     or (p_source ->> 'contact_id' is not null
        and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = (p_source ->> 'contact_id')::uuid))
     or (p_source ->> 'company_id' is not null
        and not exists (select 1 from public.companies co where co.organization_id = p_org and co.id = (p_source ->> 'company_id')::uuid))
     or (p_source ->> 'order_id' is not null
        and not exists (select 1 from public.orders o where o.organization_id = p_org and o.id = (p_source ->> 'order_id')::uuid))
     or (p_source ->> 'quote_id' is not null
        and not exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = (p_source ->> 'quote_id')::uuid)) then
    raise exception 'the source is not found' using errcode = 'P0001', hint = 'invoice:source';
  end if;

  -- DOC-08
  v_customer := app.invoice_customer(p_org, (p_source ->> 'contact_id')::uuid, (p_source ->> 'company_id')::uuid);
  if jsonb_array_length(v_customer -> 'problems') > 0 then
    return jsonb_build_object('status', 'blocked', 'problems', v_customer -> 'problems');
  end if;
  -- a document belongs to a deal or a contact (DOC-01)
  if p_source ->> 'deal_id' is null and p_source ->> 'contact_id' is null then
    raise exception 'a document belongs to a deal or a contact' using errcode = 'P0001', hint = 'invoice:parent';
  end if;

  v_payload := jsonb_build_object(
    'doc_type', v_type, 'doc_date', v_date, 'due_date', v_due,
    'locale', v_settings.locale, 'send_email', v_settings.provider_sends_email,
    'customer', v_customer - 'problems', 'lines', v_lines,
    'totals', jsonb_build_object(
      'net_agorot', (v_totals ->> 'net_total_agorot')::bigint, 'vat_agorot', (v_totals ->> 'vat_agorot')::bigint,
      'total_agorot', (v_totals ->> 'total_agorot')::bigint, 'rate_bp', v_rate, 'prices_include_vat', v_gross));
  insert into app.invoice_issue_requests (organization_id, idempotency_key, requested_by, provider, source, payload)
  values (p_org, p_key, auth.uid(), v_provider, p_source, v_payload)
  returning id into v_id;
  -- owner (398) א: the provider is asked by the background worker; the queue holds the request's id only
  update app.invoice_issue_requests r
     set job_id = app.enqueue_job(p_org, 'invoice.issue', jsonb_build_object('request_id', v_id::text), now())
   where r.id = v_id;
  return jsonb_build_object('status', 'pending', 'request_id', v_id, 'provider', v_provider, 'request', v_payload);
end;
$$;
revoke all on function app.invoice_issue_open(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function app.invoice_issue_open(uuid, uuid, jsonb, jsonb) to authenticated;

create or replace function public.invoice_issue_begin(p_org uuid, p_key uuid, p_kind text, p_id uuid, p_doc jsonb) returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
begin
  perform app.invoice_issuer_check(p_org);
  return app.invoice_issue_open(p_org, p_key, app.invoice_source(p_org, p_kind, p_id), p_doc);
end;
$$;
revoke all on function public.invoice_issue_begin(uuid, uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.invoice_issue_begin(uuid, uuid, text, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. The worker's claim (service_role, the job's live lease only)
-- ----------------------------------------------------------------------------
-- Answers {refused: stale} on a lease that is not this job's live one; {refused: invalid} for a payload or request that does
-- not match; {refused: finished, status} when the request already ended (the worker ends the job, nothing sent); {refused:
-- <code>} after ending the request (requester_gone, customer_erased, invoice:provider, invoice:not_connected,
-- org_not_writable, feature:documents); else {request_id, provider, request, late} (the stored request, as begin made it).
-- A request closed by hand or marked stale (code closed | stale, no provider document yet) after an earlier try of its job was
-- claimed (attempts > 1 now) may already exist at the provider (a timeout, or a lease that ran out mid-call): the worker LOOKS
-- IT UP with the same key (`late`: true; findDocument, never issueDocument), and a found document is recorded or kept as
-- issued_after_close; not found leaves the closed request final. One closed before any try was claimed stays final: nothing
-- is sent. A late claim also refuses while the business cannot record (org_not_writable, feature:documents).
create or replace function public.invoice_issue_claim(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req app.invoice_issue_requests;
  v_code text;
  v_late boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'invoice.issue' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if not app.job_payload_ok('invoice.issue', v_job.payload) then
    return jsonb_build_object('refused', 'invalid');
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid and r.job_id = v_job.id
   for update;
  if v_req.id is null then
    return jsonb_build_object('refused', 'invalid');
  end if;
  v_late := v_req.status in ('unrecorded', 'stale') and v_req.error_code in ('closed', 'stale')
            and v_req.provider_document_id is null and v_req.document_id is null and v_job.attempts > 1;
  if v_req.status <> 'pending' and not v_late then
    return jsonb_build_object('refused', 'finished', 'status', v_req.status);
  end if;
  if v_late then
    -- the worker only LOOKS UP what an earlier try may have issued with this key (never issues); nothing is looked up
    -- while the business could not record it anyway
    v_code := case
      when v_req.customer_erased_at is not null then 'customer_erased'
      when not app.invoice_provider_usable(v_req.provider) then 'invoice:provider'
      when app.invoice_provider_of(v_req.organization_id) is distinct from v_req.provider then 'invoice:not_connected'
      when not app.org_writable(v_req.organization_id) then 'org_not_writable'
      when not app.org_has_feature(v_req.organization_id, 'documents') then 'feature:documents'
    end;
    if v_code is not null then
      -- the lookup cannot be made: an earlier try may have issued it, so the people are told to check at the provider (the
      -- request leaves the late state, final, and is listed until someone closes it)
      update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'check_provider', finished_at = now()
       where r.id = v_req.id;
      perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
      return jsonb_build_object('refused', v_code);
    end if;
    return jsonb_build_object('request_id', v_req.id, 'provider', v_req.provider, 'request', v_req.payload, 'late', true);
  end if;
  v_code := case
    when v_req.customer_erased_at is not null then 'customer_erased'
    when not exists (select 1 from public.memberships m
                      where m.organization_id = v_req.organization_id and m.user_id = v_req.requested_by and m.status = 'active')
      then 'requester_gone'
    -- an order cancelled after begin is billed by nothing (the rule of app.invoice_source)
    when v_req.source ->> 'order_id' is not null
         and exists (select 1 from public.orders o
                      where o.organization_id = v_req.organization_id and o.id = (v_req.source ->> 'order_id')::uuid
                        and o.status = 'cancelled') then 'invoice:order_cancelled'
    when not app.invoice_provider_usable(v_req.provider) then 'invoice:provider'
    when app.invoice_provider_of(v_req.organization_id) is distinct from v_req.provider then 'invoice:not_connected'
    when not app.org_writable(v_req.organization_id) then 'org_not_writable'
    when not app.org_has_feature(v_req.organization_id, 'documents') then 'feature:documents'
  end;
  if v_code is not null then
    -- the first try cannot have reached the provider; a later one may have
    update app.invoice_issue_requests r
       set status = case when v_job.attempts > 1 then 'unrecorded' else 'failed' end, error_code = v_code, finished_at = now()
     where r.id = v_req.id;
    if v_job.attempts > 1 then
      perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
    end if;
    return jsonb_build_object('refused', v_code);
  end if;
  return jsonb_build_object('request_id', v_req.id, 'provider', v_req.provider, 'request', v_req.payload);
end;
$$;
revoke all on function public.invoice_issue_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invoice_issue_claim(uuid, uuid) to service_role;

-- One `system` notice to the requester and the active owners and admins (the number only, nothing of the customer) when the
-- provider holds a document this system did not record: `after_close` (a request closed or marked stale, issued by an
-- earlier try, that could not be recorded), `not_recorded` (the requester is no longer an active member, so nothing is
-- recorded in their name), `cannot_record` (the business could not record it: not writable, no `documents` key, or the
-- record refused), or `check_provider` (an earlier try may have issued it and nothing could find out: the last try had no
-- answer, a lease ran out on the last try, or a late lookup could not be made).
create or replace function app.invoice_issue_late_notice(p_req app.invoice_issue_requests, p_number text, p_kind text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_title text;
  v_body text;
begin
  if p_kind = 'check_provider' then
    v_title := 'בדקו בקשת הפקה אצל ספק החשבוניות';
    v_body := 'לא הצלחנו לברר אם בקשת הפקה הופקה אצל הספק בניסיון קודם. בדקו אצל הספק, ואם המסמך הופק, רשמו אותו ידנית. '
              || 'הבקשה מופיעה בהגדרות, בעמוד ספק החשבוניות, עד שסוגרים אותה.';
  elsif p_kind = 'cannot_record' then
    v_title := 'מסמך הופק אצל ספק החשבוניות ולא נרשם';
    v_body := 'מסמך שהופק אצל הספק' || coalesce(' (מספר ' || left(p_number, 40) || ')', '')
              || ' לא נרשם במערכת, כי העסק לא יכול לרשום אותו כרגע. בדקו אותו אצל הספק ורשמו אותו ידנית.';
  elsif p_kind = 'not_recorded' then
    v_title := 'מסמך הופק אצל ספק החשבוניות ולא נרשם';
    v_body := 'מסמך שהופק אצל הספק' || coalesce(' (מספר ' || left(p_number, 40) || ')', '')
              || ' לא נרשם במערכת, כי מי שביקש אותו כבר לא חבר פעיל בעסק. בדקו אותו אצל הספק ורשמו אותו ידנית.';
  else
    v_title := 'מסמך הופק אצל ספק החשבוניות ולא נרשם';
    v_body := 'בקשת הפקה שנסגרה הופקה בכל זאת אצל הספק' || coalesce(' (מספר ' || left(p_number, 40) || ')', '')
              || ', ולא נרשמה במערכת. בדקו אותה אצל הספק ורשמו אותה ידנית.';
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', v_title, v_body
    from public.memberships m
   where m.organization_id = p_req.organization_id and m.status = 'active'
     and (m.role in ('owner', 'admin') or m.user_id = p_req.requested_by);
end;
$$;
revoke all on function app.invoice_issue_late_notice(app.invoice_issue_requests, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. The worker's record of the provider's answer (service_role, the job's live lease only)
-- ----------------------------------------------------------------------------
-- p_result is {ok: true, provider_document_id, number, allocation_number?, allocation_failure?} or {ok: false, code, final}.
-- Answers {status: stale} on a dead lease, else the request's status after it (pending = the queue tries again).
create or replace function public.invoice_issue_record(p_job uuid, p_lease uuid, p_result jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req app.invoice_issue_requests;
  v_doc_id text;
  v_number text;
  v_allocation text;
  v_failure text;
  v_payload jsonb;
  v_totals jsonb;
  v_source jsonb;
  v_type text;
  v_id uuid;
  v_claims text;
  v_sub text;
  v_state text;
  v_hint text;
  v_code text;
  v_receipt boolean;
  v_late boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'invoice.issue' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('status', 'stale');
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid and r.job_id = v_job.id
   for update;
  if v_req.id is null then
    return jsonb_build_object('status', 'stale');
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or jsonb_typeof(p_result -> 'ok') is distinct from 'boolean' then
    raise exception 'the provider''s answer is ok or a failure' using errcode = '22023';
  end if;
  -- a request closed by hand or marked stale after an earlier try (its late call is a LOOKUP only, never a new issue): what
  -- the provider holds is still kept (recorded when the business can record), never lost; any other ended request answers
  -- what it holds
  v_late := v_req.status in ('unrecorded', 'stale') and v_req.error_code in ('closed', 'stale')
            and v_req.document_id is null and v_req.provider_document_id is null;
  if v_req.status <> 'pending' and not v_late then
    return jsonb_build_object('status', v_req.status, 'document_id', v_req.document_id, 'number', v_req.number,
                              'code', v_req.error_code);
  end if;

  if not (p_result ->> 'ok')::boolean then
    v_code := coalesce(substring(coalesce(p_result ->> 'code', '') from '^[A-Za-z0-9_.:-]{1,64}$'), 'provider_error');
    if v_late then
      -- the lookup found nothing (not_at_provider): the closed request stays as it is, final, no notice
      if jsonb_typeof(p_result -> 'final') = 'boolean' and (p_result ->> 'final')::boolean then
        if v_code = 'not_at_provider' then
          return jsonb_build_object('status', v_req.status, 'code', v_req.error_code);
        end if;
        -- any other final refusal of the lookup (a refused key, a changed provider): nobody knows, so the people are told
        update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'check_provider', finished_at = now()
         where r.id = v_req.id;
        perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
        return jsonb_build_object('status', 'unrecorded', 'code', 'check_provider');
      end if;
      -- the lookup did not get an answer: tried again with the same key; on the queue's last try the people are told
      if v_job.attempts >= app.job_max_attempts() then
        update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'check_provider', finished_at = now()
         where r.id = v_req.id;
        perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
        return jsonb_build_object('status', 'unrecorded', 'code', 'check_provider');
      end if;
      return jsonb_build_object('status', 'pending', 'code', v_code);
    end if;
    if jsonb_typeof(p_result -> 'final') = 'boolean' and (p_result ->> 'final')::boolean then
      -- after an earlier try (the claim's rule) a refusal now does not prove the earlier one issued nothing: kept
      -- unrecorded with its code, told, and listed until someone closes it
      if v_job.attempts > 1 then
        update app.invoice_issue_requests r set status = 'unrecorded', error_code = v_code, finished_at = now()
         where r.id = v_req.id;
        perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
        return jsonb_build_object('status', 'unrecorded', 'code', v_code);
      end if;
      update app.invoice_issue_requests r set status = 'failed', error_code = v_code, finished_at = now() where r.id = v_req.id;
      return jsonb_build_object('status', 'failed', 'code', v_code);
    end if;
    -- nothing is known to have happened at the provider: the queue tries again with the same key, until its last try
    if v_job.attempts >= app.job_max_attempts() then
      update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'retries_spent', finished_at = now()
       where r.id = v_req.id;
      -- a timeout or an unreachable provider may still have issued it
      perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
      return jsonb_build_object('status', 'unrecorded', 'code', 'retries_spent');
    end if;
    update app.invoice_issue_requests r set error_code = v_code where r.id = v_req.id;
    return jsonb_build_object('status', 'pending', 'code', v_code);
  end if;

  v_doc_id := btrim(coalesce(p_result ->> 'provider_document_id', ''));
  v_number := btrim(coalesce(p_result ->> 'number', ''));
  v_allocation := nullif(btrim(coalesce(p_result ->> 'allocation_number', '')), '');
  v_failure := left(nullif(btrim(regexp_replace(coalesce(p_result ->> 'allocation_failure', ''), '[[:cntrl:]]', ' ', 'g')), ''), 300);
  if char_length(v_doc_id) not between 1 and 200 or char_length(v_number) not between 1 and 40
     or v_doc_id ~ '[[:cntrl:]]' or v_number ~ '[[:cntrl:]]' then
    raise exception 'the provider''s answer is an id and a number' using errcode = '22023';
  end if;
  v_payload := v_req.payload;
  v_totals := v_payload -> 'totals';
  v_source := v_req.source;
  v_type := v_payload ->> 'doc_type';
  v_receipt := v_type = 'receipt';
  if v_allocation is not null and (v_type not in ('tax_invoice', 'tax_invoice_receipt') or v_allocation !~ '^[0-9]{1,20}$') then
    v_allocation := null;
  end if;

  -- the provider issued it; a business that can no longer record keeps it on the request, and nothing is ever recorded in
  -- the name of someone who is no longer an active member
  v_code := case when not app.org_writable(v_req.organization_id) then 'org_not_writable'
                 when not app.org_has_feature(v_req.organization_id, 'documents') then 'feature:documents'
                 when not exists (select 1 from public.memberships m
                                   where m.organization_id = v_req.organization_id and m.user_id = v_req.requested_by
                                     and m.status = 'active') then 'requester_gone' end;
  if v_code is not null then
    if v_late then
      v_code := 'issued_after_close';
      perform app.invoice_issue_late_notice(v_req, v_number, 'after_close');
    elsif v_code = 'requester_gone' then
      perform app.invoice_issue_late_notice(v_req, v_number, 'not_recorded');
    else
      perform app.invoice_issue_late_notice(v_req, v_number, 'cannot_record');
    end if;
    update app.invoice_issue_requests r
       set status = 'unrecorded', provider_document_id = v_doc_id, number = v_number, allocation_number = v_allocation,
           allocation_failure = v_failure, finished_at = now(), error_code = v_code
     where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'number', v_number, 'code', v_code);
  end if;

  v_claims := current_setting('request.jwt.claims', true);
  v_sub := current_setting('request.jwt.claim.sub', true);
  begin
    -- DOC-02's triggers see the server: no person's claims during the insert (a failure below rolls the setting back)
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    insert into public.accounting_documents
      (organization_id, deal_id, contact_id, order_id, quote_id, doc_type, number, doc_date, amount_agorot, due_date,
       allocation_number, net_agorot, vat_agorot, vat_rate_bp, provider, provider_document_id, created_by)
    values
      (v_req.organization_id, (v_source ->> 'deal_id')::uuid, (v_source ->> 'contact_id')::uuid, (v_source ->> 'order_id')::uuid,
       (v_source ->> 'quote_id')::uuid, v_type, v_number, (v_payload ->> 'doc_date')::date,
       (v_totals ->> 'total_agorot')::bigint, (v_payload ->> 'due_date')::date, v_allocation,
       -- a receipt is the money received: no VAT split (TAX-01)
       case when v_receipt then null else (v_totals ->> 'net_agorot')::bigint end,
       case when v_receipt then null else (v_totals ->> 'vat_agorot')::bigint end,
       case when v_receipt then null else (v_totals ->> 'rate_bp')::integer end,
       v_req.provider, v_doc_id, v_req.requested_by)
    returning id into v_id;
    insert into public.accounting_document_lines
      (organization_id, document_id, position, description, quantity, unit_price_agorot, discount_agorot, vat_exempt, created_by)
    select v_req.organization_id, v_id, x.n::integer, x.line ->> 'description', (x.line ->> 'quantity')::numeric,
           (x.line ->> 'unit_price_agorot')::bigint, (x.line ->> 'discount_agorot')::bigint,
           (x.line ->> 'vat_exempt')::boolean, v_req.requested_by
      from jsonb_array_elements(v_payload -> 'lines') with ordinality as x(line, n);
    -- the audit names who issued: the entries this transaction wrote for the document and its lines, without an actor
    update public.audit_log a
       set actor_id = v_req.requested_by
     where a.organization_id = v_req.organization_id and a.actor_id is null and a.created_at = now()
       and ((a.entity_type = 'accounting_documents' and a.entity_id = v_id)
            or (a.entity_type = 'accounting_document_lines'
                and a.entity_id in (select l.id from public.accounting_document_lines l
                                     where l.organization_id = v_req.organization_id and l.document_id = v_id)));
    if v_claims is not null then
      perform set_config('request.jwt.claims', v_claims, true);
    end if;
    if v_sub is not null then
      perform set_config('request.jwt.claim.sub', v_sub, true);
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    -- a deadlock, a serialization failure or a lock not taken: the queue tries again (same key, nothing lost)
    if v_state in ('40P01', '40001', '55P03') then
      raise;
    end if;
    perform app.invoice_issue_late_notice(v_req, v_number, case when v_late then 'after_close' else 'cannot_record' end);
    v_code := left(coalesce(nullif(v_hint, ''), v_state), 64);
    update app.invoice_issue_requests r
       set status = 'unrecorded', provider_document_id = v_doc_id, number = v_number, allocation_number = v_allocation,
           allocation_failure = v_failure, finished_at = now(), error_code = v_code
     where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'number', v_number, 'code', v_code);
  end;

  update app.invoice_issue_requests r
     set status = 'issued', document_id = v_id, provider_document_id = v_doc_id, number = v_number,
         allocation_number = v_allocation, allocation_failure = v_failure, finished_at = now(), error_code = null
   where r.id = v_req.id;
  return jsonb_build_object('status', 'issued', 'document_id', v_id, 'number', v_number);
end;
$$;
revoke all on function public.invoice_issue_record(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.invoice_issue_record(uuid, uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- The page's poll: one request's state (its requester, or an owner/admin)
-- ----------------------------------------------------------------------------
create or replace function public.invoice_issue_state(p_org uuid, p_request uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_req app.invoice_issue_requests;
begin
  if auth.uid() is null or app.membership_role(p_org) is null then
    raise exception 'only members see a request' using errcode = '42501';
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = p_org and r.id = p_request and (r.requested_by = auth.uid() or app.is_admin(p_org));
  if v_req.id is null then
    raise exception 'no such request' using errcode = 'P0001', hint = 'invoice:request';
  end if;
  return jsonb_build_object('status', v_req.status, 'document_id', v_req.document_id, 'number', v_req.number,
                            'code', v_req.error_code, 'doc_type', v_req.payload ->> 'doc_type',
                            'total_agorot', (v_req.payload -> 'totals' ->> 'total_agorot')::bigint,
                            'source_kind', v_req.source ->> 'kind', 'source_id', v_req.source ->> 'id',
                            'created_at', v_req.created_at);
end;
$$;
revoke all on function public.invoice_issue_state(uuid, uuid) from public, anon;
grant execute on function public.invoice_issue_state(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Requests that never finished: listed, closed by hand, and marked stale after a day
-- ----------------------------------------------------------------------------
-- Listed: pending and stale requests, and ended ones that may exist at the provider and nobody closed (status unrecorded,
-- no provider document and none recorded, any code but closed | checked: retries_spent, job_dead, check_provider, a refusal
-- after an earlier try), answered as status `check` until someone closes them.
create or replace function public.invoice_issue_requests_open(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  if auth.uid() is null or app.membership_role(p_org) is null then
    raise exception 'only members see the requests' using errcode = '42501';
  end if;
  v_admin := app.is_admin(p_org);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'status', case when r.status = 'unrecorded' then 'check' else r.status end, 'code', r.error_code,
             'created_at', r.created_at, 'doc_type', r.payload ->> 'doc_type',
             'total_agorot', (r.payload -> 'totals' ->> 'total_agorot')::bigint, 'source_kind', r.source ->> 'kind',
             'mine', r.requested_by = auth.uid(),
             'requester', (select p.full_name from public.profiles p where p.id = r.requested_by))
           order by r.created_at desc)
      from (select * from app.invoice_issue_requests r
             where r.organization_id = p_org
               and (r.status in ('pending', 'stale')
                    or (r.status = 'unrecorded' and r.document_id is null and r.provider_document_id is null
                        and r.error_code is not null and r.error_code not in ('closed', 'checked')))
               and (v_admin or r.requested_by = auth.uid())
             order by r.created_at desc
             limit 100) r), '[]'::jsonb);
end;
$$;
revoke all on function public.invoice_issue_requests_open(uuid) from public, anon;
grant execute on function public.invoice_issue_requests_open(uuid) to authenticated;

create or replace function public.invoice_issue_close(p_org uuid, p_request uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req app.invoice_issue_requests;
begin
  if auth.uid() is null or app.membership_role(p_org) is null then
    raise exception 'only members close a request' using errcode = '42501';
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = p_org and r.id = p_request
     and (r.requested_by = auth.uid() or app.is_admin(p_org))
   for update;
  if not found then
    raise exception 'no such request' using errcode = 'P0001', hint = 'invoice:request';
  end if;
  -- the provider is being asked right now: closing would race its answer
  if v_req.status in ('pending', 'stale') and exists (select 1 from app.jobs j
                                           where j.id = v_req.job_id and j.status = 'running' and j.locked_until > now()) then
    raise exception 'the provider is being asked right now' using errcode = 'P0001', hint = 'invoice:busy';
  end if;
  if v_req.status in ('pending', 'stale') then
    update app.invoice_issue_requests r
       set status = 'unrecorded', error_code = 'closed', closed_by = auth.uid(), finished_at = now()
     where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'code', 'closed');
  end if;
  -- one that may exist at the provider (listed as `check`): closed once someone checked; nothing is asked again
  if v_req.status = 'unrecorded' and v_req.document_id is null and v_req.provider_document_id is null
     and v_req.error_code is not null and v_req.error_code not in ('closed', 'checked') then
    update app.invoice_issue_requests r set error_code = 'checked', closed_by = auth.uid() where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'code', 'checked');
  end if;
  return jsonb_build_object('status', v_req.status, 'code', v_req.error_code);
end;
$$;
revoke all on function public.invoice_issue_close(uuid, uuid) from public, anon;
grant execute on function public.invoice_issue_close(uuid, uuid) to authenticated;

-- The stored request without the customer: the customer block becomes {erased: true} and every line's text a neutral word;
-- amounts, type and dates stay (the provider's and the recorded document's own copies are kept by their own rules).
create or replace function app.invoice_issue_payload_erased(p_payload jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case when p_payload is null or jsonb_typeof(p_payload) <> 'object' then p_payload
    else jsonb_set(
           jsonb_set(p_payload, '{customer}', '{"erased": true}'::jsonb),
           '{lines}',
           coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object'
                                           then jsonb_set(x, '{description}', to_jsonb('הפריט נמחק (מחיקת פרטיות)'::text))
                                           else x end order by n)
                       from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'lines') = 'array' then p_payload -> 'lines'
                                                      else '[]'::jsonb end) with ordinality as l(x, n)), '[]'::jsonb))
  end
$$;
revoke all on function app.invoice_issue_payload_erased(jsonb) from public, anon, authenticated, service_role;

-- Privacy erasure (app.audit_erase_core, through its own `erase` audit entry, also PRV-01's retention erasure and PRV-03): the
-- requests whose source named the erased contact, company or deal lose their customer block and line texts.
create or replace function app.invoice_issue_requests_erase() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_key text := case new.entity_type when 'contacts' then 'contact_id' when 'companies' then 'company_id'
                                     when 'deals' then 'deal_id' end;
begin
  if v_key is null then
    return null;
  end if;
  update app.invoice_issue_requests r
     set payload = app.invoice_issue_payload_erased(r.payload), customer_erased_at = now()
   where r.organization_id = new.organization_id and r.source ->> v_key = new.entity_id::text;
  return null;
end;
$$;
revoke all on function app.invoice_issue_requests_erase() from public, anon, authenticated, service_role;

-- A merge (the `merged` entry of public.merge_records) moves the duplicate's requests to the kept contact or company, so a
-- later erasure of the kept record still finds them (the privacy requests' pattern, app.merge_privacy_requests).
create or replace function app.merge_invoice_issue_requests() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged text;
  v_key text;
  v_kept uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := lower(new.metadata ->> 'merged_id');
  if new.contact_id is not null then
    v_key := 'contact_id';
    v_kept := new.contact_id;
  elsif new.company_id is not null then
    v_key := 'company_id';
    v_kept := new.company_id;
  else
    return null;
  end if;
  if v_merged = v_kept::text then
    return null;
  end if;
  update app.invoice_issue_requests r
     set source = jsonb_set(r.source, array[v_key], to_jsonb(v_kept::text))
                  || case when r.source ->> 'id' = v_merged and r.source ->> 'kind' = replace(v_key, '_id', '')
                          then jsonb_build_object('id', v_kept::text) else '{}'::jsonb end,
         payload = case when r.payload -> 'customer' ->> 'external_ref' = replace(v_key, '_id', '') || ':' || v_merged
                        then jsonb_set(r.payload, '{customer,external_ref}', to_jsonb(replace(v_key, '_id', '') || ':' || v_kept::text))
                        else r.payload end
   where r.organization_id = new.organization_id and r.source ->> v_key = v_merged;
  return null;
end;
$$;
revoke all on function app.merge_invoice_issue_requests() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_invoice_issue_requests after insert on public.activities
  for each row
  when (new.type = 'system' and (new.contact_id is not null or new.company_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_invoice_issue_requests();

create or replace trigger audit_log_invoice_issue_erase after insert on public.audit_log
  for each row when (new.action = 'erase' and new.entity_type in ('contacts', 'companies', 'deals') and new.entity_id is not null)
  execute function app.invoice_issue_requests_erase();

create or replace function app.invoice_issue_mark_stale(p_limit integer default 5000) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_id uuid;
  v_req app.invoice_issue_requests;
begin
  -- a pending request whose job died or was refused (the queue's last try ended without a record): an earlier try may have
  -- reached the provider, so the people are told to check there (before the stale mark, so a dead job's request is told)
  for v_id in
    with gone as (
      select r.id, (j.status = 'dead' or j.attempts > 1) as alarm from app.invoice_issue_requests r
        join app.jobs j on j.id = r.job_id
       where r.status = 'pending' and j.status in ('dead', 'refused')
       limit greatest(coalesce(p_limit, 5000), 1)
       for update of r skip locked
    ), marked as (
      -- a job refused on its first try (nothing was sent, e.g. an invalid payload) is no alarm: the request just fails
      update app.invoice_issue_requests r
         set status = case when gone.alarm then 'unrecorded' else 'failed' end,
             error_code = case when gone.alarm then 'job_dead' else 'job_refused' end, finished_at = now()
        from gone where r.id = gone.id
      returning r.id, gone.alarm
    )
    select id from marked where alarm
  loop
    select * into v_req from app.invoice_issue_requests r where r.id = v_id;
    perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
  end loop;
  -- a closed or stale request whose late lookup never answered (its job died: a lease ran out on the last try, after an
  -- earlier try was claimed): it may exist at the provider; told once, and listed until someone closes it. A refused job is
  -- not this case: a lookup that found nothing ends it so, and stays final
  for v_id in
    with late as (
      select r.id from app.invoice_issue_requests r
        join app.jobs j on j.id = r.job_id
       where r.status in ('unrecorded', 'stale') and r.error_code in ('closed', 'stale')
         and r.provider_document_id is null and r.document_id is null
         and j.status = 'dead' and j.attempts > 1
       limit greatest(coalesce(p_limit, 5000), 1)
       for update of r skip locked
    ), marked as (
      update app.invoice_issue_requests r
         set status = 'unrecorded', error_code = 'check_provider', finished_at = coalesce(r.finished_at, now())
        from late where r.id = late.id
      returning r.id
    )
    select id from marked
  loop
    select * into v_req from app.invoice_issue_requests r where r.id = v_id;
    perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
  end loop;
  with due as (
    select r.id from app.invoice_issue_requests r
     where r.status = 'pending' and r.created_at < now() - interval '24 hours'
       -- never while the provider is being asked (a live lease): its answer comes first
       and not exists (select 1 from app.jobs j where j.id = r.job_id and j.status = 'running' and j.locked_until > now())
     order by r.created_at
     limit greatest(coalesce(p_limit, 5000), 1)
     for update skip locked
  )
  update app.invoice_issue_requests r
     set status = 'stale', error_code = 'stale', finished_at = now()
    from due where r.id = due.id;
  get diagnostics v_count = row_count;
  -- privacy: 12 months after a request ended, its customer block and line texts are emptied (an update, never a delete)
  with old as (
    select r.id from app.invoice_issue_requests r
     where r.status <> 'pending' and r.customer_erased_at is null and r.finished_at < now() - interval '12 months'
     order by r.finished_at
     limit greatest(coalesce(p_limit, 5000), 1)
     for update skip locked
  )
  update app.invoice_issue_requests r
     set payload = app.invoice_issue_payload_erased(r.payload), customer_erased_at = now()
    from old where r.id = old.id;
  return v_count;
end;
$$;
revoke all on function app.invoice_issue_mark_stale(integer) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-invoice-issue-stale', '29 * * * *', 'select app.invoice_issue_mark_stale();');
  end if;
end;
$$;
