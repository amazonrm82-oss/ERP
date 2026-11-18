-- =============================================================================
-- LNK-02 (the provider call): the payment page of a link is made by the OPS-04 background worker
-- =============================================================================
-- Owner (394) א (16 November 2026): a new OPS-04 job kind calls the clearing provider, under answer (55)'s conditions: ids
-- and codes only in the queue, the functions pinned by md5 (test 385), its own "In use" line in CLAUDE.md, the fake provider
-- until the owner chooses a real one. Only the server records the provider's answer: no function taking one is granted to
-- `authenticated`.
--
-- The flow:
--   1. A new pending link (021294's insert, unchanged for the person) queues one `payment_link.create` job whose payload is
--      the link's id only (trigger payment_links_queue_page, definer, app.enqueue_job).
--   2. The worker (src/features/payment-links/page-handler.ts through src/features/jobs/run-server.ts) claims the job and asks
--      public.payment_link_page_claim(job, lease) (service_role, the job's live lease only): the link while still pending,
--      past no last day, with no page yet; its provider usable here (app.payment_link_provider_usable: the fake only while
--      app.settings `payment_links_fake` is 'on'); the business writable with `payments` and `payment_links`; its source
--      still open (app.payment_link_source_open, the one rule). A refusal cancels the link (closed_reason 'page_failed', or
--      'source_closed' for a closed source; the expiry is left to the closing job) and tells the person who made it. It
--      answers the link's amount, currency, instalments, last moment and title (made by the database, never a name), which
--      the worker sends to the provider with the LINK'S ID as the provider's idempotency key, so a retry never makes two pages.
--   3. public.payment_link_page_record(job, lease, result) (service_role, the job's live lease only) keeps the provider's
--      answer once: its id for the link (it must equal the id already kept, as the fake's `fake_<link id>`) and the page's
--      https address, stamped `page_created_at`. A final refusal, or no answer by the queue's last try, cancels the link
--      ('page_failed', the code in `page_error_code`) with one notice; a retryable one leaves it for the queue's next try.
-- The person's side is unchanged: whoever records payments makes and cancels links (021294, owner (395) א); a person writes
-- none of the new columns (they have no grant and the check keeps them). Every statement is safe to run twice. No drops, no
-- row removal, no escaped code points.

-- ----------------------------------------------------------------------------
-- The link's page: server-only columns, and the new reason the server cancels a link
-- ----------------------------------------------------------------------------
alter table public.payment_links add column if not exists page_created_at timestamptz;
alter table public.payment_links add column if not exists page_error_code text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_links_page_error_shape') then
    alter table public.payment_links add constraint payment_links_page_error_shape
      check (page_error_code is null or page_error_code ~ '^[A-Za-z0-9_.:-]{1,64}$') not valid;
  end if;
end;
$$;
alter table public.payment_links validate constraint payment_links_page_error_shape;
-- 021294's inline check knew 'source_closed' only; a link whose page could not be made is closed 'page_failed'
alter table public.payment_links drop constraint if exists payment_links_closed_reason_check;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_links_closed_reason_known') then
    alter table public.payment_links add constraint payment_links_closed_reason_known
      check (closed_reason is null or closed_reason in ('source_closed', 'page_failed')) not valid;
  end if;
end;
$$;
alter table public.payment_links validate constraint payment_links_closed_reason_known;

-- ----------------------------------------------------------------------------
-- The job kind (owner (394) א) and its payload
-- ----------------------------------------------------------------------------
create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run', 'digest.send', 'report.send', 'invite.send', 'invoice.issue',
                   'payment_link.create']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021297's body, plus payment_link.create (owner (394) א): exactly {link_id}
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
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The rules of a link (every writer): 021294's body, plus the page columns (server only, written once by the record) and the
-- server's new close reason
-- ----------------------------------------------------------------------------
create or replace function app.payment_links_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_today date;
  v_open bigint;
  v_title text;
  v_ok boolean;
  v_count integer;
  v_key text;
  v_pending bigint;
  v_balance bigint;
  v_seen text;
begin
  -- outsider guard on INSERT: RLS refuses (42501) a person who may not record payments here, before anything is revealed.
  -- (An UPDATE by such a person never reaches this trigger: payment_links_update's USING needs the same rights; the
  -- server's merge and FK paths below are judged by their own branches.)
  if tg_op = 'INSERT' and auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if num_nonnulls(new.quote_id, new.order_id, new.accounting_document_id, new.contact_id) <> 1 then
      raise exception 'a payment link has exactly one source' using errcode = 'P0001', hint = 'payment_link:source';
    end if;
    -- finding 4: the fake provider only where app.settings `payment_links_fake` = 'on' (never on the hosted project)
    if new.provider = 'fake'
       and coalesce((select s.value from app.settings s where s.key = 'payment_links_fake'), '') <> 'on' then
      raise exception 'the fake payment provider is off here' using errcode = 'P0001', hint = 'payment_link:provider';
    end if;

    select coalesce(o.timezone, 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = new.organization_id;
    v_today := (now() at time zone v_zone)::date;

    -- the source: open by the one rule, and how much of it is open (the total of a quote or order, a document's balance)
    v_ok := app.payment_link_source_open(new.organization_id, new.quote_id, new.order_id, new.accounting_document_id, new.contact_id);
    if new.quote_id is not null then
      v_key := 'quotes';
      select q.total_agorot, 'מקדמה להצעת מחיר' || coalesce(' ' || q.number_display, '')
        into v_open, v_title
        from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
    elsif new.order_id is not null then
      v_key := 'orders';
      select o.total_agorot, 'תשלום להזמנה' || coalesce(' ' || o.number_display, '')
        into v_open, v_title
        from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
    elsif new.accounting_document_id is not null then
      v_key := 'documents';
      select case when v_ok then app.document_balance(d.organization_id, d.id) end,
             'תשלום ל' || app.document_type_label(d.doc_type) || coalesce(' ' || d.number, '')
        into v_open, v_title
        from public.accounting_documents d where d.organization_id = new.organization_id and d.id = new.accounting_document_id;
    else
      v_title := 'תשלום';
      v_open := null;
    end if;
    -- a source that is not in this business: the composite FK (and RLS) refuse it, revealing nothing
    if v_ok is null then
      return new;
    end if;
    -- the plan keys: payments and payment links, then the source's own
    if not app.org_has_feature(new.organization_id, 'payments') then
      raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
    end if;
    if not app.org_has_feature(new.organization_id, 'payment_links') then
      raise exception 'payment links are not in the plan' using errcode = 'P0001', hint = 'feature:payment_links';
    end if;
    -- the source's own plan key (a quote needs `quotes`, an order `orders`, a document `documents`)
    if v_key is not null and not app.org_has_feature(new.organization_id, v_key) then
      raise exception 'the source''s module is not in the plan' using errcode = 'P0001', hint = 'feature:' || v_key;
    end if;
    -- delta review 1: a person who sees only part of a document's money gets one neutral answer
    if new.accounting_document_id is not null and auth.uid() is not null then
      v_balance := app.document_balance(new.organization_id, new.accounting_document_id);
      v_seen := current_setting('app.payment_link_caller_balance', true);
      if v_seen is null or split_part(v_seen, ':', 1) <> new.id::text
         or nullif(split_part(v_seen, ':', 2), '')::bigint is distinct from v_balance then
        raise exception 'part of this document''s money is hidden from you' using errcode = 'P0001', hint = 'payment_link:partial';
      end if;
    end if;
    if not v_ok then
      raise exception 'the source is not open for payment' using errcode = 'P0001', hint = 'payment_link:source_state';
    end if;
    -- the last day: today .. +90 days in the business zone; the link stops at the end of that day
    if new.expires_on is null or new.expires_on < v_today or new.expires_on > v_today + 90 then
      raise exception 'the last day is today up to 90 days ahead' using errcode = 'P0001', hint = 'payment_link:expires';
    end if;
    new.expires_at := ((new.expires_on + 1)::timestamp at time zone v_zone);

    -- at most 20 pending links per source (one lock per business: counts never race)
    perform pg_advisory_xact_lock(hashtextextended('payment_links:' || new.organization_id::text, 0));
    select count(*), coalesce(sum(l.amount_agorot), 0) into v_count, v_pending
      from public.payment_links l
     where l.organization_id = new.organization_id and l.status = 'pending' and l.expires_at > now()
       and l.quote_id is not distinct from new.quote_id and l.order_id is not distinct from new.order_id
       and l.accounting_document_id is not distinct from new.accounting_document_id
       and l.contact_id is not distinct from new.contact_id;
    if v_count >= 20 then
      raise exception 'too many open payment links on this source' using errcode = 'P0001', hint = 'payment_link:max';
    end if;
    -- delta review 2: a quote's or an order's links already paid count too (a document's balance already holds its payments)
    if new.quote_id is not null or new.order_id is not null then
      v_pending := v_pending + coalesce((
        select sum(l.amount_agorot) from public.payment_links l
         where l.organization_id = new.organization_id and l.status = 'paid'
           and l.quote_id is not distinct from new.quote_id and l.order_id is not distinct from new.order_id), 0);
    end if;
    -- finding 2: this link and the source's other pending links together never pass what is open
    if v_open is not null and new.amount_agorot > v_open - v_pending then
      raise exception 'the amount is more than is open' using errcode = 'P0001', hint = 'payment_link:over';
    end if;

    -- the server's columns
    new.title := v_title;
    new.currency := 'ILS';
    new.status := 'pending';
    new.status_at := now();
    new.payment_id := null;
    new.paid_at := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.closed_reason := null;
    new.source_checked_at := null;
    new.hosted_url := null;
    -- LNK-02: the page is the worker's (public.payment_link_page_record)
    new.page_created_at := null;
    new.page_error_code := null;
    -- LNK-01: the fake provider's id is fixed by the link (no page); a real provider's comes from the worker
    new.provider_link_id := case when new.provider = 'fake' then 'fake_' || new.id::text end;
    new.created_by := coalesce(auth.uid(), new.created_by);
    return new;
  end if;

  -- UPDATE. A purged payment clears payment_id through its composite FK (a nested trigger): only that passes
  if pg_trigger_depth() > 1 and new.payment_id is null and old.payment_id is not null
     and (to_jsonb(new) - 'payment_id' - 'updated_at') = (to_jsonb(old) - 'payment_id' - 'updated_at') then
    return new;
  end if;
  -- a merge moves a free link to the kept contact (app.merge_payment_links sets 'merge'): only contact_id changes
  if current_setting('app.payment_link_server', true) = 'merge'
     and (to_jsonb(new) - 'contact_id' - 'updated_at') = (to_jsonb(old) - 'contact_id' - 'updated_at') then
    return new;
  end if;
  -- LNK-02: the worker's record of the provider's page (public.payment_link_page_record sets 'page'): once, on a pending
  -- link, only the provider's id, the page's address, the time and the last error code; or the error code alone (a retry)
  if current_setting('app.payment_link_server', true) = 'page' and auth.uid() is null then
    if old.status <> 'pending' or new.status <> 'pending' or old.page_created_at is not null
       or (to_jsonb(new) - 'provider_link_id' - 'hosted_url' - 'page_created_at' - 'page_error_code' - 'updated_at')
          <> (to_jsonb(old) - 'provider_link_id' - 'hosted_url' - 'page_created_at' - 'page_error_code' - 'updated_at')
       or (old.provider_link_id is not null and new.provider_link_id is distinct from old.provider_link_id) then
      raise exception 'the provider''s page is recorded once, on a pending link' using errcode = 'P0001', hint = 'payment_link:closed';
    end if;
    return new;
  end if;
  -- the server's status changes (expiry, a closed source; later the provider's webhook): from pending only, never back
  if current_setting('app.payment_link_server', true) = 'on' and auth.uid() is null then
    -- the closing job stamps a pending link it judged still open (only that column)
    if old.status = 'pending' and new.status = 'pending'
       and (to_jsonb(new) - 'source_checked_at' - 'updated_at') = (to_jsonb(old) - 'source_checked_at' - 'updated_at') then
      return new;
    end if;
    if old.status <> 'pending' or new.status not in ('expired', 'paid', 'failed', 'cancelled')
       or (to_jsonb(new) - 'status' - 'status_at' - 'payment_id' - 'paid_at' - 'cancelled_at' - 'closed_reason' - 'source_checked_at' - 'page_error_code' - 'updated_at')
          <> (to_jsonb(old) - 'status' - 'status_at' - 'payment_id' - 'paid_at' - 'cancelled_at' - 'closed_reason' - 'source_checked_at' - 'page_error_code' - 'updated_at') then
      raise exception 'a payment link moves only from pending' using errcode = 'P0001', hint = 'payment_link:closed';
    end if;
    new.status_at := now();
    if new.status = 'cancelled' then
      new.cancelled_at := now();
      new.cancelled_by := null;
      -- LNK-02: a link whose page could not be made is closed 'page_failed'; every other server cancel is a closed source
      new.closed_reason := case when new.closed_reason = 'page_failed' then 'page_failed' else 'source_closed' end;
    else
      new.cancelled_at := null;
      new.closed_reason := null;
    end if;
    return new;
  end if;

  -- a person: only cancelling a pending link
  -- (the currency is held to 'ILS' by its own check until DEAL-12)
  if (to_jsonb(new) - 'status' - 'currency' - 'updated_at') <> (to_jsonb(old) - 'status' - 'currency' - 'updated_at') then
    raise exception 'a payment link does not change' using errcode = 'P0001', hint = 'payment_link:frozen';
  end if;
  if new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'a finished payment link stays as it is' using errcode = 'P0001', hint = 'payment_link:closed';
    end if;
    if new.status <> 'cancelled' then
      raise exception 'a person only cancels a payment link' using errcode = 'P0001', hint = 'payment_link:frozen';
    end if;
    new.cancelled_at := now();
    new.cancelled_by := auth.uid();
    new.status_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.payment_links_check() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 1. A new link queues its page (one job, the link's id only)
-- ----------------------------------------------------------------------------
create or replace function app.payment_links_queue_page() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status = 'pending' then
    perform app.enqueue_job(new.organization_id, 'payment_link.create', jsonb_build_object('link_id', new.id::text), now());
  end if;
  return null;
end;
$$;
revoke all on function app.payment_links_queue_page() from public, anon, authenticated, service_role;

create or replace trigger payment_links_queue_page after insert on public.payment_links
  for each row execute function app.payment_links_queue_page();

-- The providers this database accepts a call for: a closed list; the fake only while app.settings `payment_links_fake` is
-- 'on' (never set by a migration; unset on the hosted project)
create or replace function app.payment_link_provider_usable(p_provider text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p_provider = 'fake'
                  and coalesce((select s.value from app.settings s where s.key = 'payment_links_fake'), '') = 'on', false)
$$;
revoke all on function app.payment_link_provider_usable(text) from public, anon, authenticated, service_role;

-- One `system` notice about a link (its title only, never a customer's name): to the person who made it while an active
-- member, else to the active owners and admins
create or replace function app.payment_link_notice(p_org uuid, p_maker uuid, p_title text, p_body text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_maker is not null and exists (select 1 from public.memberships m
                                      where m.organization_id = p_org and m.user_id = p_maker and m.status = 'active') then
    insert into public.notifications (organization_id, user_id, type, title, body)
    values (p_org, p_maker, 'system', p_title, p_body);
    return;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', p_title, p_body
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
end;
$$;
revoke all on function app.payment_link_notice(uuid, uuid, text, text) from public, anon, authenticated, service_role;

-- The server closes a pending link whose page was not made (or whose source closed), with the code, and tells the maker
create or replace function app.payment_link_page_close(p_link public.payment_links, p_reason text, p_code text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_server text := current_setting('app.payment_link_server', true);
begin
  perform set_config('app.payment_link_server', 'on', true);
  update public.payment_links l
     set status = 'cancelled', closed_reason = p_reason,
         page_error_code = coalesce(substring(coalesce(p_code, '') from '^[A-Za-z0-9_.:-]{1,64}$'), 'provider_error')
   where l.organization_id = p_link.organization_id and l.id = p_link.id and l.status = 'pending';
  perform set_config('app.payment_link_server', coalesce(v_server, ''), true);
  if p_reason = 'page_failed' then
    perform app.payment_link_notice(p_link.organization_id, p_link.created_by, 'קישור התשלום לא נוצר',
      'ספק הסליקה לא יצר את דף התשלום' || coalesce(' של "' || left(p_link.title, 120) || '"', '')
      || '. הקישור בוטל, ואף אחד לא חויב. אפשר ליצור קישור חדש.');
  end if;
end;
$$;
revoke all on function app.payment_link_page_close(public.payment_links, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. The worker's claim (service_role, the job's live lease only)
-- ----------------------------------------------------------------------------
-- Answers {refused: stale} on a lease that is not this job's live one; {refused: invalid} for a payload or link that does
-- not match; {refused: finished} when the link is no longer pending or already has its page (nothing is asked); {refused:
-- expired} past its last moment (the closing job expires it); {refused: <code>} after closing the link (source_closed,
-- payment_link:provider, org_not_writable, feature:payments, feature:payment_links); else {link_id, provider,
-- provider_link_id, request} where request holds the amount, currency, instalments, last moment and title only.
create or replace function public.payment_link_page_claim(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_link public.payment_links;
  v_code text;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'payment_link.create' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if not app.job_payload_ok('payment_link.create', v_job.payload) then
    return jsonb_build_object('refused', 'invalid');
  end if;
  select * into v_link from public.payment_links l
   where l.organization_id = v_job.organization_id and l.id = (v_job.payload ->> 'link_id')::uuid
   for update;
  if v_link.id is null then
    return jsonb_build_object('refused', 'invalid');
  end if;
  if v_link.status <> 'pending' or v_link.page_created_at is not null then
    return jsonb_build_object('refused', 'finished');
  end if;
  if v_link.expires_at <= now() then
    return jsonb_build_object('refused', 'expired');
  end if;
  v_code := case
    when not app.payment_link_provider_usable(v_link.provider) then 'payment_link:provider'
    when not app.org_writable(v_link.organization_id) then 'org_not_writable'
    when not app.org_has_feature(v_link.organization_id, 'payments') then 'feature:payments'
    when not app.org_has_feature(v_link.organization_id, 'payment_links') then 'feature:payment_links'
    when not coalesce(app.payment_link_source_open(v_link.organization_id, v_link.quote_id, v_link.order_id,
                                                   v_link.accounting_document_id, v_link.contact_id), false) then 'source_closed'
  end;
  if v_code is not null then
    perform app.payment_link_page_close(v_link, case when v_code = 'source_closed' then 'source_closed' else 'page_failed' end, v_code);
    return jsonb_build_object('refused', v_code);
  end if;
  return jsonb_build_object(
    'link_id', v_link.id,
    'provider', v_link.provider,
    'provider_link_id', v_link.provider_link_id,
    'request', jsonb_build_object(
      'organization_id', v_link.organization_id,
      'amount_agorot', v_link.amount_agorot,
      'currency', v_link.currency,
      'max_installments', v_link.max_installments,
      'expires_at', v_link.expires_at,
      'title', coalesce(v_link.title, 'תשלום')));
end;
$$;
revoke all on function public.payment_link_page_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.payment_link_page_claim(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 3. The worker's record of the provider's answer (service_role, the job's live lease only)
-- ----------------------------------------------------------------------------
-- p_result is {ok: true, provider_link_id, hosted_url} or {ok: false, code, final}. Answers {status: stale} on a dead lease;
-- else {status: created} (the page kept), {status: pending} (the queue tries again), or the link's status when it is no
-- longer waiting for a page (cancelled after a final refusal or the last try).
create or replace function public.payment_link_page_record(p_job uuid, p_lease uuid, p_result jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_link public.payment_links;
  v_id text;
  v_url text;
  v_code text;
  v_server text;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'payment_link.create' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() or not app.job_payload_ok('payment_link.create', v_job.payload) then
    return jsonb_build_object('status', 'stale');
  end if;
  select * into v_link from public.payment_links l
   where l.organization_id = v_job.organization_id and l.id = (v_job.payload ->> 'link_id')::uuid
   for update;
  if v_link.id is null then
    return jsonb_build_object('status', 'stale');
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or jsonb_typeof(p_result -> 'ok') is distinct from 'boolean' then
    raise exception 'the provider''s answer is ok or a failure' using errcode = '22023';
  end if;
  -- a link that no longer waits for a page answers what it holds (a cancel or an expiry meanwhile: nothing is kept)
  if v_link.status <> 'pending' or v_link.page_created_at is not null then
    return jsonb_build_object('status', case when v_link.page_created_at is not null and v_link.status = 'pending'
                                             then 'created' else v_link.status end);
  end if;

  if (p_result ->> 'ok')::boolean then
    v_id := p_result ->> 'provider_link_id';
    v_url := nullif(p_result ->> 'hosted_url', '');
    if v_id is null or v_id !~ '^[A-Za-z0-9_.:-]{1,128}$' then
      v_code := 'provider_answer';
    elsif v_url is not null and (v_url !~ '^https://[^[:space:][:cntrl:]]+$' or char_length(v_url) > 2000) then
      v_code := 'provider_answer';
    elsif v_link.provider_link_id is not null and v_link.provider_link_id <> v_id then
      v_code := 'provider_id_mismatch';
    end if;
    if v_code is null then
      v_server := current_setting('app.payment_link_server', true);
      begin
        perform set_config('app.payment_link_server', 'page', true);
        update public.payment_links l
           set provider_link_id = v_id, hosted_url = v_url, page_created_at = now(), page_error_code = null
         where l.organization_id = v_link.organization_id and l.id = v_link.id;
        perform set_config('app.payment_link_server', coalesce(v_server, ''), true);
      exception when unique_violation then
        -- another link of the business already holds this provider id: the answer cannot be this link's
        v_code := 'provider_id_taken';
      end;
    end if;
    if v_code is null then
      return jsonb_build_object('status', 'created');
    end if;
    perform app.payment_link_page_close(v_link, 'page_failed', v_code);
    return jsonb_build_object('status', 'cancelled', 'code', v_code);
  end if;

  v_code := coalesce(substring(coalesce(p_result ->> 'code', '') from '^[A-Za-z0-9_.:-]{1,64}$'), 'provider_error');
  if jsonb_typeof(p_result -> 'final') = 'boolean' and (p_result ->> 'final')::boolean then
    perform app.payment_link_page_close(v_link, 'page_failed', v_code);
    return jsonb_build_object('status', 'cancelled', 'code', v_code);
  end if;
  -- nothing is known to have been made: the queue asks again with the same key (the link's id), until its last try
  if v_job.attempts >= app.job_max_attempts() then
    perform app.payment_link_page_close(v_link, 'page_failed', 'retries_spent');
    return jsonb_build_object('status', 'cancelled', 'code', 'retries_spent');
  end if;
  v_server := current_setting('app.payment_link_server', true);
  perform set_config('app.payment_link_server', 'page', true);
  update public.payment_links l set page_error_code = v_code
   where l.organization_id = v_link.organization_id and l.id = v_link.id;
  perform set_config('app.payment_link_server', coalesce(v_server, ''), true);
  return jsonb_build_object('status', 'pending', 'code', v_code);
end;
$$;
revoke all on function public.payment_link_page_record(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.payment_link_page_record(uuid, uuid, jsonb) to service_role;
