-- =============================================================================
-- USR-09: a staff invitation sent by email from the system (OPS-04 job kind invite.send)
-- =============================================================================
-- Owner (387) א (16 November 2026): the system sends the existing invitation through Resend from the noreply address, with a
-- fixed service text (DRAFT, not editable by a business), a "send again" on a pending invitation and several addresses at
-- once; copying the link stays available. The owner approved the new job kind in the same answer, under answer (55)'s
-- conditions: ids and codes only in the queue (the invitation's id and who asked, NEVER its token), the worker's functions
-- pinned by md5 (test 284), its own "In use" line. Seat rules are unchanged (create_invitation / accept_invitation).
--
-- The token. Only the SHA-256 of an invitation's token is stored (foundation 0001); the plain token exists once, in
-- create_invitation's answer to the person who made it. The email therefore cannot carry that token. The composer mints a
-- NEW token on the job's live lease, stores only its SHA-256 on the invitation (public.invitations.token_hash) and answers
-- the plain token to the worker for the email's link alone; nothing plain is ever stored or queued. So the latest email's
-- link is the one that works: a link copied earlier, or an earlier email's, stops working when an email goes out (the
-- screens say so). accept_invitation and invitation_preview are unchanged (they look the hash up as before).
-- Accepted: the token change writes one audit_log 'update' entry of the invitation with the old and new hash and no actor
-- (as the insert's entry already holds the first hash); a hash of a 256-bit random token gives nothing.
--
-- The lead's choices (16 November 2026), recorded in DECISIONS.md:
-- * Who may send: who may invite today (create_invitation's rule): an owner or an admin by app.role_in (never a support
--   session), of a writable business; an admin invitation only by the owner. Judged again on the live lease for the person
--   who asked (a plain active membership).
-- * Limits (review fix 1, never counted down: the send log keeps no foreign key to the invitation): 3 emails per address
--   (business and lower(email)) a business day, so a new invitation to the same address shares the count; 100 invitation
--   emails per business a business day; 100 per requesting account in 24 hours across businesses; at most 20 addresses
--   per press (the app).
-- * Nothing is queued while no worker asked for invite.send in the last day (no email provider): the answer says so and the
--   screen shows the links to copy instead.
--
-- What this file holds:
-- * app.job_kinds() gains 'invite.send'; app.job_payload_ok() (021289's body, one more branch) takes exactly
--   {invitation_id, requested_by}.
-- * app.invitation_email_sends (no grants): one row per requested send, kept with the business only.
-- * public.invitation_email_queue(org, invitation) (definer, authenticated) and public.invitation_email_status(org)
--   (definer, owners and admins: counts, times and the latest send's state only).
-- * public.invitation_job_compose(job, lease) (service_role, the live lease only) for the worker.
-- * app.run_staff_mail_purge(): pg_cron `crm-staff-mail-purge` (02:47 UTC); a no-op until the hand-pasted 021291 defines
--   app.staff_mail_purge_rows() (the only deletes: invitation sends after 30 days, report sends after 90).
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The job kind and its payload
-- ----------------------------------------------------------------------------
create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run', 'digest.send', 'report.send', 'invite.send']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021289's body, plus invite.send (owner (387) א): exactly {invitation_id, requested_by}
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
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Every requested send, one row each (review fix 1: never counted down)
-- ----------------------------------------------------------------------------
-- No foreign key to the invitation: revoking, deleting or replacing an invitation never gives a send back, and a new
-- invitation to the same address shares its day's count (per business and lower(email)). The rows go with the business.
-- composed_at is stamped by the composer when it minted the link's token (the earlier link no longer works from then on).
create table if not exists app.invitation_email_sends (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  invitation_id   uuid not null,
  email           text not null,
  requested_by    uuid not null,
  day             date not null,
  requested_at    timestamptz not null default now(),
  job_id          uuid,
  composed_at     timestamptz
);
create index if not exists invitation_email_sends_org_day_idx on app.invitation_email_sends (organization_id, day);
create index if not exists invitation_email_sends_address_idx on app.invitation_email_sends (organization_id, email, day);
create index if not exists invitation_email_sends_requester_idx on app.invitation_email_sends (requested_by, requested_at);
create index if not exists invitation_email_sends_invitation_idx on app.invitation_email_sends (invitation_id, requested_at);
create index if not exists invitation_email_sends_job_idx on app.invitation_email_sends (job_id);
create index if not exists invitation_email_sends_email_idx on app.invitation_email_sends (email, requested_at);
alter table app.invitation_email_sends enable row level security;
revoke all on app.invitation_email_sends from public, anon, authenticated, service_role;

-- the limits: per address (business and lower(email)) a business day, per business a business day, per requesting account
-- across every business in 24 hours, and (delta review 1a) per address across every business in 24 hours
create or replace function app.invitation_email_limits(out per_address integer, out per_business integer, out per_requester integer,
                                                       out per_address_all integer)
language sql immutable
set search_path = ''
as $$ select 3, 100, 100, 5 $$;
revoke all on function app.invitation_email_limits() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Sending (and sending again) an invitation by email
-- ----------------------------------------------------------------------------
-- Answers {ok: true} when the email is queued, or {ok: false, reason}: unavailable (no worker sends this kind: nothing
-- queued, the link the person copied still works), rate (3 to this address in this business today), rate_business (100 for
-- the business today), rate_requester (100 by this person in 24 hours, across businesses). Raises 42501 for anyone who may
-- not invite, and P0001 hint invitation_email:not_pending for an invitation that is accepted, revoked, expired or not of
-- this business. Lock order (one fixed order): the requesting person, then the address (lower(email), across businesses:
-- at most 5 invitation emails to one address in 24 hours, answered `rate`), then the business, then the invitation row.
create or replace function public.invitation_email_queue(p_org uuid, p_invitation uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.membership_role := app.role_in(p_org);
  v_inv public.invitations;
  v_day date;
  v_limits record;
  v_job uuid;
  v_email text;
begin
  if v_uid is null or v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'only an admin can invite users' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('invitation_email_requester:' || v_uid::text, 0));
  -- the invitation's address (invitations.email is lower case and has no client update grant), read before the address lock
  select i.email into v_email from public.invitations i where i.organization_id = p_org and i.id = p_invitation;
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended('invitation_email_address:' || lower(v_email), 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('invitation_email_sends:' || p_org::text, 0));
  select * into v_inv from public.invitations i where i.organization_id = p_org and i.id = p_invitation for update;
  if v_inv.id is null or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'the invitation is not pending' using errcode = 'P0001', hint = 'invitation_email:not_pending';
  end if;
  if v_inv.role = 'admin' and v_role <> 'owner' then
    raise exception 'only the owner can invite an admin' using errcode = '42501';
  end if;
  -- the address taken under its lock must be the invitation's own
  if v_email is distinct from v_inv.email then
    raise exception 'the invitation is not pending' using errcode = 'P0001', hint = 'invitation_email:not_pending';
  end if;
  if not exists (select 1 from app.job_kind_seen s
                  where s.kind = 'invite.send' and s.last_claimed_at > now() - interval '1 day') then
    return jsonb_build_object('ok', false, 'reason', 'unavailable');
  end if;
  v_day := (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
  select * into v_limits from app.invitation_email_limits();
  if (select count(*) from app.invitation_email_sends s
       where s.organization_id = p_org and s.email = lower(v_inv.email) and s.day = v_day) >= v_limits.per_address then
    return jsonb_build_object('ok', false, 'reason', 'rate');
  end if;
  -- delta review 1a: one address across every business, 24 hours; the same neutral answer
  if (select count(*) from app.invitation_email_sends s
       where s.email = lower(v_inv.email) and s.requested_at > now() - interval '1 day') >= v_limits.per_address_all then
    return jsonb_build_object('ok', false, 'reason', 'rate');
  end if;
  if (select count(*) from app.invitation_email_sends s where s.organization_id = p_org and s.day = v_day) >= v_limits.per_business then
    return jsonb_build_object('ok', false, 'reason', 'rate_business');
  end if;
  if (select count(*) from app.invitation_email_sends s
       where s.requested_by = v_uid and s.requested_at > now() - interval '1 day') >= v_limits.per_requester then
    return jsonb_build_object('ok', false, 'reason', 'rate_requester');
  end if;
  v_job := app.enqueue_job(p_org, 'invite.send',
             jsonb_build_object('invitation_id', v_inv.id::text, 'requested_by', v_uid::text), now());
  insert into app.invitation_email_sends (organization_id, invitation_id, email, requested_by, day, job_id)
  values (p_org, v_inv.id, lower(v_inv.email), v_uid, v_day, v_job);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.invitation_email_queue(uuid, uuid) from public, anon;
grant execute on function public.invitation_email_queue(uuid, uuid) to authenticated;

-- The pending invitations' latest email, for the users screen (owners and admins of the business only; ids, counts, times
-- and states, nothing else): [{invitation_id, sends_today, last_requested_at, state, composed}]. state is the latest
-- send's job: waiting (queued, running, or failed and to be tried again), sent (done) or failed (ended without sending);
-- composed = its link's token was minted, so a failed send left the earlier link dead (review fix 3).
create or replace function public.invitation_email_status(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
  v_day date;
begin
  if v_role is null or v_role not in ('owner', 'admin') then
    return '[]'::jsonb;
  end if;
  v_day := (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'invitation_id', i.id,
             'sends_today', (select count(*) from app.invitation_email_sends s
                              where s.organization_id = p_org and s.email = i.email and s.day = v_day),
             'last_requested_at', l.requested_at,
             'state', case
                        when j.status = 'done' then 'sent'
                        when j.status in ('dead', 'refused') then 'failed'
                        when j.id is null then 'failed'
                        else 'waiting'
                      end,
             'composed', l.composed_at is not null)
             order by i.created_at, i.id)
      from public.invitations i
      cross join lateral (select s.requested_at, s.job_id, s.composed_at from app.invitation_email_sends s
                           where s.organization_id = p_org and s.invitation_id = i.id
                           order by s.requested_at desc, s.id desc limit 1) l
      left join app.jobs j on j.id = l.job_id
     where i.organization_id = p_org and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()), '[]'::jsonb);
end;
$$;
revoke all on function public.invitation_email_status(uuid) from public, anon;
grant execute on function public.invitation_email_status(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The worker's composer: one function, service_role only, on the job's live lease
-- ----------------------------------------------------------------------------
-- Answers {refused: stale} on a lease that is not this job's live one, {refused: <code>} when nothing may be sent (the worker
-- ends the job, nothing sent): invalid, not_pending (accepted, revoked or gone), expired, business_closed (not writable:
-- deleted, suspended, cancelled, read-only, waiting to be removed), inviter_gone (the person who asked is no longer an active
-- owner or admin, or an admin invitation and they are not the owner), no_address. Else {to, business_name, role, expires_at,
-- token}: the invited address, the business's display name (the neutral "העסק" when the name holds a link, an "@" or a "://"),
-- the role, when the invitation ends, and a NEW token whose SHA-256
-- replaces the invitation's (the previous link stops working; the send row is stamped composed_at, so the screen can say so
-- when the send then fails). The token is answered once and stored nowhere plain.
create or replace function public.invitation_job_compose(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_inv public.invitations;
  v_org public.organizations;
  v_role public.membership_role;
  v_token text;
  v_name text;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'invite.send' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if not app.job_payload_ok('invite.send', v_job.payload) then
    return jsonb_build_object('refused', 'invalid');
  end if;
  select * into v_inv from public.invitations i
   where i.organization_id = v_job.organization_id and i.id = (v_job.payload ->> 'invitation_id')::uuid
   for update;
  if v_inv.id is null or v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    return jsonb_build_object('refused', 'not_pending');
  end if;
  if v_inv.expires_at <= now() then
    return jsonb_build_object('refused', 'expired');
  end if;
  select * into v_org from public.organizations o where o.id = v_job.organization_id;
  if v_org.id is null or not app.org_writable(v_org.id) then
    return jsonb_build_object('refused', 'business_closed');
  end if;
  select m.role into v_role from public.memberships m
   where m.organization_id = v_org.id and m.user_id = (v_job.payload ->> 'requested_by')::uuid and m.status = 'active';
  if v_role is null or v_role not in ('owner', 'admin') or (v_inv.role = 'admin' and v_role <> 'owner') then
    return jsonb_build_object('refused', 'inviter_gone');
  end if;
  if not app.email_address_ok(v_inv.email) then
    return jsonb_build_object('refused', 'no_address');
  end if;
  -- create_invitation's shape: two uuids without dashes, 64 hex characters; only its SHA-256 is kept
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  update public.invitations i set token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex') where i.id = v_inv.id;
  update app.invitation_email_sends s set composed_at = now() where s.job_id = v_job.id;
  -- delta review 1b: the business's name goes into the From, the subject and the text of an email to an outside address; a
  -- name that holds a link, an address or a scheme is never sent: the neutral word instead
  v_name := case
              when v_org.name is null or btrim(v_org.name) = '' or position('@' in v_org.name) > 0 or position('://' in v_org.name) > 0
                   or coalesce(app.message_external_link(v_org.name, null, null), true) then 'העסק'
              else v_org.name
            end;
  return jsonb_build_object(
    'to', v_inv.email,
    'business_name', v_name,
    'role', v_inv.role::text,
    'expires_at', to_char(v_inv.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'token', v_token);
end;
$$;
revoke all on function public.invitation_job_compose(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invitation_job_compose(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Retention of the two send logs (delta review 3). The deletes live in the hand-pasted 20261006021291_staff_mail_purge.sql
-- (app.staff_mail_purge_rows); until it is pasted this is a no-op. Every cap looks back one business day or 24 hours, so
-- keeping invitation sends 30 days and report sends 90 days never lowers a count that is still read.
-- ----------------------------------------------------------------------------
create or replace function app.run_staff_mail_purge() returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if to_regprocedure('app.staff_mail_purge_rows(integer)') is not null then
    execute 'select app.staff_mail_purge_rows(5000)';
  end if;
end;
$$;
revoke all on function app.run_staff_mail_purge() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-staff-mail-purge', '47 2 * * *', 'select app.run_staff_mail_purge();');
  end if;
end;
$$;
