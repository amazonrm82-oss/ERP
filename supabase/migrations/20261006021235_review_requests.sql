-- =============================================================================
-- RET-02: a request for a review (a link to the business's Google review page) after a won deal or a held meeting
-- =============================================================================
-- SPEC-ADDITIONS RET-02: "בקשת חוות דעת אחרי סגירה או אחרי פגישה: הודעה עם קישור לביקורת ב-Google, או לסקר פנימי". Owner
-- 11 November 2026: (273) a NEW plan key `review_requests`, basic and up; (271) ב the internal survey is NOT built now (no
-- public page here). The spec's note under RET-02: the system never chooses who gets the Google link by how satisfied the
-- customer is (Google's review policy forbids "review gating"). So there is no rating step and no filter on a score, a
-- status, an amount or an outcome: every eligible customer gets the same request, and none of the rules below reads
-- satisfaction.
--
-- Lead's choices (open questions in the report):
-- * A review request is MARKETING (CNS-07): it promotes the business and is not part of a service the customer asked for. Its
--   type `review_request` is NOT in app.service_message_types(), so public.job_message_may_send (md5-pinned by test 284 and
--   NOT changed here) judges it as marketing: no opt-out (app.consent_suppressed) and a recorded grant of the channel
--   (app.consent_granted), the marketing caps of MSG-05/MSG-06 and the sending hours. Every sender wraps it in
--   marketingEnvelope() ("פרסומת", the sender line, the unsubscribe line).
-- * Its templates are nevertheless judged like a service type by app.message_notice_template_problem (021233's body; only the
--   first condition changes; 021233's offer block stays an instant reply's only): a closed list of fields, app.message_type_fields('review_request') = first name, business name,
--   business phone and the review link {קישור לביקורת} (new in app.message_merge_fields, 021218's list plus it); no link of
--   its own (the review link comes only through the field); the service length cap. Mirrored by messageTemplateProblem().
-- * The link: app.review_url_ok = reviewUrlOk() (shared fixture tests/unit/fixtures/review-urls.json): BIZ-03's
--   app.qr_target_url_ok (https, ASCII, no user name, a DNS host), the default port only, and one of Google's known review
--   shapes: g.page/r/..., search.google.com/local/writereview?..., www.google.com|google.com|www.google.co.il|google.co.il
--   /maps/..., maps.app.goo.gl/<id>, g.co/kgs/<id>, each with a closed path character set and only the query keys it needs
--   (app.review_url_query_ok: writereview needs placeid; maps takes hl and entry; maps.app.goo.gl g_st; the others none);
--   never a '%', an empty segment or a '.' / '..' segment in the path (so no escaped or relative step leaves /maps/), never a
--   fragment, a path holding /amp/ or a q=, url=, continue=, adurl=, pcurl=, redirect=, dest= or next= parameter (Google's
--   redirect pages; delta review). Strict on purpose: the link goes out in the business's name to many customers, so any other site (or a look-alike) is
--   refused (hint review_request:url).
-- * Once per contact per 90 days (app.review_request_gap_days()): a contact with a request QUEUED in the last 90 days is not
--   asked again (outcome 'recent').
-- * The channel: the contact's preferred channel (CON-10) when SMS or email, else SMS (with the `sms` key and the month's
--   quota, app.collection_sms_room), else email, each tried once ('quota' when only a phone the used-up SMS quota cannot reach); the first with an address, an active marked template that is sendable now
--   and a recorded marketing grant of that channel for that address (app.consent_granted and not app.consent_suppressed).
--   The grant is read only to CHOOSE a channel, so a request the queue would refuse is not queued and does not use up the
--   90 days ('no_consent'); the queue's own send check still decides whether and when the message goes.
-- * The delay is whole days in the business's zone (0..30, default 1) after the deal's close day (deals.closed_at) or the
--   meeting's end day (meetings.ends_at). Only events at or after the moment the business switched requests on
--   (review_request_settings.enabled_at, server only), and at most 7 days late, so switching on never writes to past
--   customers in bulk and a run that missed days catches up only for a week (the job's event_at, below, is never past).
--
-- * public.review_request_settings: one row per business (no row = off). enabled, review_url, on_deal_won (default true),
--   on_meeting_held (default false), delay_days 0..30 (default 1), enabled_at (server only). Members read; owners/admins of a
--   writable business insert and update through column grants; no delete; audited. Definer trigger
--   review_request_settings_check (outsider guard first): the link rule (hint review_request:url); a business that is on needs
--   a link and at least one trigger (hint review_request:incomplete); switching on needs the plan key (hint
--   feature:review_requests, every writer) and stamps enabled_at; switching off is always allowed.
-- * The type joins the closed lists: app.message_types() (021225's body plus the type before 'marketing'; the service list,
--   021225's body, is defined again unchanged), the templates' type and notice_kind checks (021226's lists plus
--   'review_request'), and constraint message_templates_review_request_mark: a template of type review_request is the
--   system's own (notice_kind 'review_request', server only) and the mark belongs to that type only. So a person never writes
--   one, and the existing refusals of marked templates on every person's and rule's send path (SGN-03 review M1) keep it off
--   cards and rules. A person may edit the text (app.message_templates_wording_version clears the wording version) or switch
--   it off.
-- * Two DRAFT templates (SMS and email), wording version 'review-draft-1', = DEFAULT_REVIEW_REQUEST_TEMPLATES, seeded once
--   per business and channel (app.review_request_template_seeds) when requests are switched on and again before a request
--   is queued; a refused insert (the 50-template cap) is recorded as done, with one warning.
-- * The job: pg_cron `crm-review-requests` (four times an hour) runs app.send_review_requests(). Nothing while no worker
--   asked for message jobs in the last day (app.collection_message_worker_seen). Businesses that are on, hold the key, can
--   write and are not paused (HEB-09 app.customer_sending_paused) take turns (app.review_request_turns), at most 100 a run,
--   each under a try-lock (a second run skips it); at most 50 events per business and 500 per run
--   (app.review_request_business_cap / app.review_request_run_cap). Events: a won deal (status won, not in the bin, with a
--   contact, not imported: deals.import_job_id is null, so history imported after switching on is never asked about;
--   meetings are never imported) and a held meeting (not a block; its contact, else its deal's contact; a meeting whose deal is in the bin is
--   skipped). Each event is judged once (app.review_requests, unique per business, kind and record; written first, on
--   conflict nothing) in its own exception block (outcome 'failed', one warning). The contact must be live (not in the bin).
--   One OPS-04 message.send job per queued request through app.enqueue_job: {channel, message_type review_request,
--   template_id, contact_id, review_request_id, event_at} (ids only); event_at is the end of the 7th day after the event's
--   due day, so a request held too long (a pause, the caps) is cancelled by the queue's own check. A contact merge moves the
--   duplicate's requests to the kept contact (app.merge_review_requests on the `merged` entry), so the 90 days hold after it.
-- * app.job_payload_ok: 021226's body plus (1) 'review_request_id' at the end of the allowed-key list and (2) the block
--   commented "RET-02" right before the event_at block.
-- * app.plan_key_defaults: 021202's body plus "review_requests": false. The plans: basic, pro, business on; personal off.
-- * app.message_merge_fields: 021218's body plus 'קישור לביקורת' at the end. app.message_type_fields: 021225's body plus the
--   review_request line. app.message_notice_template_problem: 021233_instant_reply_editable's body (021218's plus the offer
--   block); only the first condition (and its comment). {קישור לביקורת} is a field of the review_request type only (no other
--   type's list holds it), so app.message_notice_template_problem refuses it on every service template and the future sender
--   fills it only for a review_request.
-- * public.plans_public (021232's body): the closed landing list gains 'review_requests' after 'sms' (the order of
--   PLAN_CAPABILITIES, unit test plans-public); nothing else changes. Test 344 pins the new md5 (rechecked: only that key).
--
-- THE FUTURE SENDER (its own "In use" line in hard rule 5 once a provider sends these): right before it sends it re-reads
-- the request by review_request_id (scoped to the job's business and contact) and the business's settings, and sends
-- nothing unless the business still holds `review_requests`, requests are still on and the stored link still passes
-- app.review_url_ok; it fills {קישור לביקורת} only with that stored link, wraps the text in marketingEnvelope(), asks
-- app.message_template_sendable and app.message_filled_problem, and never adds a rating step or any filter by satisfaction.
--
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The plan key (owner (273): basic and up)
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": {}, "features": { "review_requests": false } },
  "basic": { "limits": {}, "features": { "review_requests": true } },
  "pro": { "limits": {}, "features": { "review_requests": true } },
  "business": { "limits": {}, "features": { "review_requests": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- 021202's fallback with the key (a plan that does not hold it: off)
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
    "meeting_reminders": false,
    "signatures": false,
    "sms": false,
    "review_requests": false
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
    "ai_credits_per_user_per_month": 0,
    "max_signatures_per_month": 0,
    "max_sms_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- every other plan (the hidden free plan, a plan added in the panel) holds it too, off
update public.plans p
   set features = jsonb_build_object('review_requests', false) || coalesce(p.features, '{}'::jsonb)
 where not (coalesce(p.features, '{}'::jsonb) ? 'review_requests');

-- ----------------------------------------------------------------------------
-- The message type (021225's lists plus review_request, a marketing type)
-- ----------------------------------------------------------------------------
create or replace function app.message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'instant_reply', 'review_request', 'marketing']::text[] $$;
revoke all on function app.message_types() from public, anon, authenticated;

-- unchanged (021225's body): a review request is not a service message
create or replace function app.service_message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'instant_reply']::text[] $$;
revoke all on function app.service_message_types() from public, anon, authenticated;

alter table public.message_templates
  drop constraint if exists message_templates_message_type_check,
  add constraint message_templates_message_type_check
    check (message_type in ('meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'instant_reply', 'review_request', 'marketing'));

-- the system's own marks (021226's list plus the review request)
alter table public.message_templates
  drop constraint if exists message_templates_notice_kind_check,
  add constraint message_templates_notice_kind_check
    check (notice_kind is null or notice_kind in ('punch_card_low', 'punch_card_expiry',
                                                  'meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour',
                                                  'signature_reminder', 'instant_reply_open', 'instant_reply_closed',
                                                  'collection_reminder', 'review_request'));

-- a review request template is the system's own, and the mark belongs to that type only
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'message_templates_review_request_mark'
                    and conrelid = 'public.message_templates'::regclass) then
    alter table public.message_templates add constraint message_templates_review_request_mark
      check ((message_type = 'review_request') = (notice_kind is not distinct from 'review_request'));
  end if;
end;
$$;

-- The closed list of merge fields (021218's body plus {קישור לביקורת}). Mirrors MESSAGE_MERGE_FIELDS.
create or replace function app.message_merge_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'תאריך', 'שעה', 'מסמך', 'סכום', 'מועד תשלום', 'קישור להצעה',
               'טלפון העסק', 'כתובת העסק', 'תוקף', 'תוכן העדכון', 'קישור הסרה', 'קוד אימות', 'שם הכרטיסייה', 'כניסות',
               'מיקום', 'קישור', 'שם המסמך', 'קישור לביקורת']::text[]
$$;
revoke all on function app.message_merge_fields() from public, anon, authenticated;
-- the table's check trigger runs as the writer (a person)
grant execute on function app.message_merge_fields() to authenticated;


-- The merge fields a judged type may hold (021225's body plus review_request). Mirrors JUDGED_TYPE_FIELDS.
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
    -- RET-02: a review request (a marketing type with its own closed list): the business signs it, the review link
    when 'review_request' then array['שם פרטי', 'שם העסק', 'טלפון העסק', 'קישור לביקורת']::text[]
  end
$$;
revoke all on function app.message_type_fields(text) from public, anon, authenticated;

-- 021233's rule (021218's plus the offer block); RET-02: a review request is judged too (see the header)
create or replace function app.message_notice_template_problem(p_channel text, p_message_type text, p_notice_kind text,
                                                               p_subject text, p_body text, p_own_domain text,
                                                               p_business_email text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_fields text[];
  v_text text := coalesce(p_subject, '') || chr(10) || coalesce(p_body, '');
  v_glue text;
begin
  -- RET-02: a review request is marketing, but judged like a service type (its closed field list, no link of its own,
  -- the service length cap); every other marketing type is never judged here
  if not (coalesce(p_message_type, '') = any (app.service_message_types()) or p_message_type = 'review_request') then
    return null;
  end if;
  -- SGN-03 review M1: the fields of the type, plus those only the system's own mark may hold
  v_fields := coalesce(app.message_type_fields(p_message_type), '{}'::text[]) || app.message_notice_fields(p_message_type, p_notice_kind);
  -- the same field pattern as app.message_unknown_field / MERGE_FIELD_PATTERN (a gender block always holds ":")
  if exists (select 1
               from regexp_matches(v_text, '\{([^{}:|\n]{1,30})\}', 'g') as m
              where not (m[1] = any (v_fields))) then
    return 'field_not_allowed';
  end if;
  -- SPD-04 (282) ב: an instant reply holds no price, percent discount or marketing word
  if p_message_type = 'instant_reply' and app.message_offer(v_text) then
    return 'offer';
  end if;
  -- owner (113) א: an address glued to text is another address, with its own message
  v_glue := app.message_address_glue(v_text, p_own_domain, p_business_email);
  if v_glue = 'glued_address' then
    return 'glued_address';
  end if;
  if v_glue = 'external_link' or app.message_external_link(v_text, p_own_domain, p_business_email) then
    return 'external_link';
  end if;
  if char_length(coalesce(p_body, '')) > coalesce(app.message_service_body_max(p_channel), 0) then
    return 'too_long';
  end if;
  return null;
end;
$$;
revoke all on function app.message_notice_template_problem(text, text, text, text, text, text, text) from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- The queue payload: an optional review_request_id (021226's rule plus the key)
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
                               'collection_document_id', 'review_request_id'))
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
      -- contact, by SMS or email, with no files, reply-to person, sender or rule
      and (not (p_payload ? 'review_request_id')
           or (jsonb_typeof(p_payload -> 'review_request_id') = 'string'
               and (p_payload ->> 'review_request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'review_request'
               and p_payload ? 'contact_id'
               and (p_payload ->> 'channel') in ('email', 'sms')
               and not (p_payload ?| array['file_ids', 'library_file_ids', 'reply_to_user_id', 'sent_by_user_id',
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
-- The review link (= reviewUrlOk in src/features/review-requests/review-url.ts; fixture tests/unit/fixtures/review-urls.json)
-- ----------------------------------------------------------------------------
-- Delta review: a query holds only the keys its shape allows, each part key=value with a closed character set (no '/', '%'
-- or '?', so no address can ride in it); an empty query, or none, passes only when no key is required.
create or replace function app.review_url_query_ok(p_query text, p_keys text[], p_required text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_query is null then p_required is null
    when p_query = '' then false
    else not exists (select 1 from unnest(string_to_array(p_query, '&')) part
                      where not (part ~ '^[a-z_]{1,20}=[A-Za-z0-9_.:-]{1,200}$' and split_part(part, '=', 1) = any (p_keys)))
         and (p_required is null or exists (select 1 from unnest(string_to_array(p_query, '&')) part
                                             where split_part(part, '=', 1) = p_required))
  end
$$;
revoke all on function app.review_url_query_ok(text, text[], text) from public, anon, authenticated;

create or replace function app.review_url_ok(p_url text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce((
    select app.qr_target_url_ok(p_url)
       -- the default port only, no fragment
       and x.port in ('', ':443')
       and position('#' in p_url) = 0
       -- delta review: the path is plain: no percent escape, no empty segment, no '.' or '..' segment
       and position('%' in x.path) = 0
       and position('//' in x.path) = 0
       and x.path !~ '(^|/)[.]{1,2}(/|$)'
       -- never one of Google's redirect or AMP pages, never a redirect parameter
       and x.path !~* '/amp(/|$)'
       and coalesce(x.query, '') !~* '(^|&)(q|url|continue|adurl|pcurl|redirect|dest|next)='
       -- one of the known shapes, each with its own closed path and the query keys it needs only
       and (   (x.host = 'g.page' and x.path ~ '^/r/[A-Za-z0-9_-]+(/review)?$'
                and app.review_url_query_ok(x.query, '{}'::text[], null))
            or (x.host = 'search.google.com' and x.path = '/local/writereview'
                and app.review_url_query_ok(x.query, array['placeid'], 'placeid'))
            or (x.host in ('www.google.com', 'google.com', 'www.google.co.il', 'google.co.il')
                and x.path ~ '^/maps/[A-Za-z0-9@,+_~./-]+$'
                and app.review_url_query_ok(x.query, array['hl', 'entry'], null))
            or (x.host = 'maps.app.goo.gl' and x.path ~ '^/[A-Za-z0-9_-]+$'
                and app.review_url_query_ok(x.query, array['g_st'], null))
            or (x.host = 'g.co' and x.path ~ '^/kgs/[A-Za-z0-9_-]+$'
                and app.review_url_query_ok(x.query, '{}'::text[], null)))
      from (select lower(substring(p_url from '^https://([^/?#:]+)')) as host,
                   coalesce(substring(p_url from '^https://[^/?#:]+(:[0-9]+)'), '') as port,
                   coalesce(substring(p_url from '^https://[^/?#]+([^?#]*)'), '') as path,
                   substring(p_url from '^[^?#]*[?]([^#]*)') as query) x),
    false)
$$;
revoke all on function app.review_url_ok(text) from public, anon, authenticated;

create or replace function app.review_request_gap_days() returns integer
language sql immutable
set search_path = ''
as $$ select 90 $$;
revoke all on function app.review_request_gap_days() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The business's settings
-- ----------------------------------------------------------------------------
create table if not exists public.review_request_settings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  enabled          boolean not null default false,
  review_url       text,
  on_deal_won      boolean not null default true,
  on_meeting_held  boolean not null default false,
  delay_days       smallint not null default 1,
  -- server only: when the requests were last switched on (only events from then on are asked about)
  enabled_at       timestamptz,
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint review_request_settings_delay_range check (delay_days between 0 and 30),
  constraint review_request_settings_url_length check (review_url is null or char_length(review_url) <= 2000)
);
comment on table public.review_request_settings is
  'RET-02: the business''s review requests (one row per business; no row = off). No filter by satisfaction (Google''s policy).';

create or replace trigger review_request_settings_touch before insert or update on public.review_request_settings
  for each row execute function app.touch_row();
create or replace trigger review_request_settings_audit after insert or update or delete on public.review_request_settings
  for each row execute function app.audit_row();

alter table public.review_request_settings enable row level security;
revoke all on public.review_request_settings from anon, authenticated;
grant select on public.review_request_settings to authenticated;
grant insert (organization_id, enabled, review_url, on_deal_won, on_meeting_held, delay_days) on public.review_request_settings to authenticated;
grant update (enabled, review_url, on_deal_won, on_meeting_held, delay_days) on public.review_request_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'review_request_settings'
                   and policyname = 'review_request_settings_select') then
    create policy review_request_settings_select on public.review_request_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'review_request_settings'
                   and policyname = 'review_request_settings_insert') then
    create policy review_request_settings_insert on public.review_request_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'review_request_settings'
                   and policyname = 'review_request_settings_update') then
    create policy review_request_settings_update on public.review_request_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- The rules of a row (every writer; an outsider is left to RLS, so it learns nothing about the business's plan)
create or replace function app.review_request_settings_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_turning_on boolean;
begin
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- enabled_at is the server's: kept on an update, set only when the requests are switched on
  if tg_op = 'UPDATE' then
    new.enabled_at := old.enabled_at;
    v_turning_on := new.enabled and not old.enabled;
  else
    new.enabled_at := null;
    v_turning_on := new.enabled;
  end if;
  new.review_url := nullif(btrim(new.review_url), '');
  if new.review_url is not null and not app.review_url_ok(new.review_url) then
    raise exception 'the review link is not a Google review link'
      using errcode = 'P0001', hint = 'review_request:url';
  end if;
  if new.enabled and (new.review_url is null or not (new.on_deal_won or new.on_meeting_held)) then
    raise exception 'review requests need a link and at least one trigger'
      using errcode = 'P0001', hint = 'review_request:incomplete';
  end if;
  if v_turning_on then
    if not coalesce(app.org_has_feature(new.organization_id, 'review_requests'), false) then
      raise exception 'review requests are not in the plan'
        using errcode = 'P0001', hint = 'feature:review_requests';
    end if;
    new.enabled_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.review_request_settings_check() from public, anon, authenticated, service_role;

create or replace trigger review_request_settings_check
  before insert or update on public.review_request_settings
  for each row execute function app.review_request_settings_check();

-- ----------------------------------------------------------------------------
-- Server-only bookkeeping (schema app: RLS on, no grants)
-- ----------------------------------------------------------------------------
-- one row per event judged (a won deal or a held meeting), with its outcome; the 90 days are read from the queued rows
create table if not exists app.review_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  source_kind     text not null check (source_kind in ('deal', 'meeting')),
  source_id       uuid not null,
  contact_id      uuid,
  outcome         text not null default 'pending',
  channel         text check (channel is null or channel in ('sms', 'email')),
  job_id          uuid,
  created_at      timestamptz not null default now(),
  unique (organization_id, source_kind, source_id),
  -- a contact that is purged takes its requests with it
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  constraint review_requests_outcome_check
    check (outcome in ('pending', 'queued', 'recent', 'no_contact', 'no_address', 'no_consent', 'no_template', 'quota', 'failed')
           or outcome ~ '^template:[a-z_]{1,40}$')
);
alter table app.review_requests enable row level security;
revoke all on app.review_requests from public, anon, authenticated, service_role;
-- a full index: it covers the contact foreign key, and the 90 days' read (queued rows of a contact, newest)
create index if not exists review_requests_contact_idx on app.review_requests (organization_id, contact_id, created_at);

-- Review (7): a merge moves the duplicate's requests to the kept contact (through the `merged` entry, written before the
-- duplicate is deleted, as app.merge_payment_promises), so the 90 days survive it; the rows' FK would otherwise cascade.
create or replace function app.merge_review_requests() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if coalesce(new.metadata ->> 'merged_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if v_merged <> new.contact_id then
    update app.review_requests r set contact_id = new.contact_id
     where r.organization_id = new.organization_id and r.contact_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_review_requests() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_review_requests after insert on public.activities
  for each row
  when (new.type = 'system' and new.contact_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_review_requests();

-- the businesses' turns (the one served longest ago goes first)
create table if not exists app.review_request_turns (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  last_run_at     timestamptz not null default now()
);
alter table app.review_request_turns enable row level security;
revoke all on app.review_request_turns from public, anon, authenticated, service_role;

-- the templates added to a business, once per channel (a deleted one is not brought back)
create table if not exists app.review_request_template_seeds (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel         text not null check (channel in ('sms', 'email')),
  seeded_at       timestamptz not null default now(),
  primary key (organization_id, channel)
);
alter table app.review_request_template_seeds enable row level security;
revoke all on app.review_request_template_seeds from public, anon, authenticated, service_role;

-- the won deals the job reads, by business and close time
create index if not exists deals_won_closed_idx on public.deals (organization_id, closed_at)
  where status = 'won' and deleted_at is null;

-- ----------------------------------------------------------------------------
-- The templates (DRAFT wording until the lawyer edits it; = DEFAULT_REVIEW_REQUEST_TEMPLATES)
-- ----------------------------------------------------------------------------
create or replace function app.review_request_wording_version() returns text
language sql immutable
set search_path = ''
as $$ select 'review-draft-1' $$;
revoke all on function app.review_request_wording_version() from public, anon, authenticated, service_role;

-- Each is added while the business has no template of the mark on its channel and none of its name, once per business and
-- channel, each on its own: an insert the 50-template cap (or anything else) refuses is recorded as done all the same, with
-- one warning, so it is never tried again on every run.
create or replace function app.seed_review_request_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select d.* from (values
      (1, 'בקשת ביקורת (SMS)', 'sms', null::text,
          'שלום {שם פרטי}, תודה שבחרתם ב-{שם העסק}. נשמח מאוד אם תקדישו דקה לכתוב לנו ביקורת: {קישור לביקורת}'),
      (2, 'בקשת ביקורת (אימייל)', 'email', 'נשמח לשמוע מכם, {שם העסק}',
          'שלום {שם פרטי}, תודה שבחרתם ב-{שם העסק}. נשמח מאוד אם תקדישו דקה לכתוב לנו ביקורת: {קישור לביקורת}. לשאלות: {טלפון העסק}')
    ) as d(n, name, channel, subject, body)
     where not exists (select 1 from app.review_request_template_seeds s where s.organization_id = p_org and s.channel = d.channel)
     order by d.n
  loop
    begin
      if not exists (select 1 from public.message_templates t
                      where t.organization_id = p_org and t.notice_kind = 'review_request' and t.channel = v_row.channel)
         and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(v_row.name)) then
        insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind, wording_version)
        values (p_org, v_row.name, v_row.channel, 'review_request', v_row.subject, v_row.body, 'review_request',
                app.review_request_wording_version());
      end if;
      insert into app.review_request_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    exception when others then
      raise warning 'review request template % not seeded for business % (SQLSTATE %)', v_row.n, p_org, sqlstate;
      insert into app.review_request_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    end;
  end loop;
end;
$$;
revoke all on function app.seed_review_request_templates(uuid) from public, anon, authenticated, service_role;

-- switching the requests on adds the templates (never fails the save)
create or replace function app.review_request_settings_seed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled) then
    begin
      perform app.seed_review_request_templates(new.organization_id);
    exception when others then
      raise warning 'review request templates not seeded for business % (SQLSTATE %)', new.organization_id, sqlstate;
    end;
  end if;
  return null;
end;
$$;
revoke all on function app.review_request_settings_seed() from public, anon, authenticated, service_role;

create or replace trigger review_request_settings_seed
  after insert or update of enabled on public.review_request_settings
  for each row execute function app.review_request_settings_seed();

-- ----------------------------------------------------------------------------
-- The limits of a run (a transaction may lower them)
-- ----------------------------------------------------------------------------
create or replace function app.review_request_business_cap() returns integer
language sql stable
set search_path = ''
as $$ select least(coalesce(nullif(current_setting('app.review_request_business_cap', true), '')::integer, 50), 50) $$;
revoke all on function app.review_request_business_cap() from public, anon, authenticated, service_role;

create or replace function app.review_request_run_cap() returns integer
language sql stable
set search_path = ''
as $$ select least(coalesce(nullif(current_setting('app.review_request_run_cap', true), '')::integer, 500), 500) $$;
revoke all on function app.review_request_run_cap() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- One event: judged once, at most one request queued
-- ----------------------------------------------------------------------------
-- Answers the outcome. Never raises (its own exception block: 'failed' and one warning).
create or replace function app.review_request_one(p_org uuid, p_kind text, p_source uuid, p_contact uuid, p_due date,
                                                  p_zone text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_contact uuid;
  v_phone text;
  v_email text;
  v_preferred text;
  v_sms boolean;
  v_try text;
  v_address text;
  v_template uuid;
  v_tpl uuid;
  v_no_consent boolean := false;
  v_channel text;
  v_problem text;
  v_last_problem text;
  v_found_template boolean := false;
  v_found_address boolean := false;
  v_job uuid;
  v_outcome text;
begin
  insert into app.review_requests (organization_id, source_kind, source_id, contact_id)
  values (p_org, p_kind, p_source, null)
  on conflict (organization_id, source_kind, source_id) do nothing
  returning id into v_id;
  if v_id is null then
    -- judged already (by an earlier run or a run beside this one)
    return null;
  end if;
  begin
    select c.id, nullif(btrim(c.phone_e164), ''), nullif(btrim(c.email), ''), c.preferred_channel
      into v_contact, v_phone, v_email, v_preferred
      from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null;
    if v_contact is null then
      update app.review_requests set outcome = 'no_contact' where id = v_id;
      return 'no_contact';
    end if;
    update app.review_requests set contact_id = v_contact where id = v_id;
    -- once per contact per 90 days (a request queued, whatever became of it)
    if exists (select 1 from app.review_requests r
                where r.organization_id = p_org and r.contact_id = v_contact and r.outcome = 'queued'
                  and r.created_at > now() - make_interval(days => app.review_request_gap_days())) then
      update app.review_requests set outcome = 'recent' where id = v_id;
      return 'recent';
    end if;

    perform app.seed_review_request_templates(p_org);
    v_sms := app.collection_sms_room(p_org);
    foreach v_try in array case when v_preferred = 'email' then array['email', 'sms'] else array['sms', 'email'] end loop
      continue when v_template is not null;
      v_address := case when v_try = 'email' then v_email else v_phone end;
      continue when v_address is null or (v_try = 'sms' and not v_sms);
      v_found_address := true;
      select t.id into v_tpl
        from public.message_templates t
       where t.organization_id = p_org and t.channel = v_try and t.is_active
         and t.message_type = 'review_request' and t.notice_kind = 'review_request'
       order by t.created_at, t.id
       limit 1;
      continue when v_tpl is null;
      v_found_template := true;
      v_problem := app.message_template_sendable(p_org, v_tpl);
      if v_problem is not null then
        v_last_problem := v_problem;
        perform app.message_send_refused(p_org, v_tpl, v_problem);
        continue;
      end if;
      -- the grant is read to choose the channel only; the queue's send check decides
      if coalesce(app.consent_granted(p_org, v_try, v_address), false)
         and not coalesce(app.consent_suppressed(p_org, v_try, v_address), true) then
        v_template := v_tpl;
        v_channel := v_try;
      else
        v_no_consent := true;
      end if;
    end loop;
    if v_template is null then
      v_outcome := case
        -- a phone the plan's SMS (on, but used up this month) cannot reach and no email: 'quota'
        when not v_found_address and v_phone is not null and v_email is null
             and coalesce(app.org_has_feature(p_org, 'sms'), false) then 'quota'
        when not v_found_address then 'no_address'
        when not v_found_template then 'no_template'
        when v_no_consent then 'no_consent'
        else 'template:' || left(regexp_replace(coalesce(v_last_problem, 'unknown'), '[^a-z_]', '_', 'g'), 40) end;
      update app.review_requests set outcome = v_outcome where id = v_id;
      return v_outcome;
    end if;

    v_job := app.enqueue_job(
      p_org, 'message.send',
      jsonb_build_object('channel', v_channel, 'message_type', 'review_request', 'template_id', v_template,
                         'contact_id', v_contact, 'review_request_id', v_id,
                         -- valid until the end of the 7th day after the due day, in the business's zone
                         'event_at', to_char(((p_due + 8)::timestamp at time zone p_zone) at time zone 'UTC',
                                             'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
    update app.review_requests set outcome = 'queued', channel = v_channel, job_id = v_job where id = v_id;
    return 'queued';
  exception when others then
    raise warning 'crm-review-requests: % % of business % failed (SQLSTATE %)', p_kind, p_source, p_org, sqlstate;
    update app.review_requests set outcome = 'failed' where id = v_id;
    return 'failed';
  end;
end;
$$;
revoke all on function app.review_request_one(uuid, text, uuid, uuid, date, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job
-- ----------------------------------------------------------------------------
-- Answers how many events were judged. p_orgs narrows the run (tests); null = every business.
create or replace function app.send_review_requests(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org record;
  v_event record;
  v_zone text;
  v_today date;
  v_room integer;
  v_left integer := app.review_request_run_cap();
  v_done integer := 0;
begin
  -- nothing is expected to go out while no worker asked for message jobs in the last day
  if not app.collection_message_worker_seen() then
    return 0;
  end if;
  for v_org in
    select s.organization_id, s.enabled_at, s.delay_days, s.on_deal_won, s.on_meeting_held, o.timezone
      from public.review_request_settings s
      join public.organizations o on o.id = s.organization_id
      left join app.review_request_turns t on t.organization_id = s.organization_id
     where s.enabled and s.review_url is not null and s.enabled_at is not null
       and (p_orgs is null or s.organization_id = any (p_orgs))
       and coalesce(app.org_has_feature(s.organization_id, 'review_requests'), false)
       and app.org_writable(s.organization_id)
       and not app.customer_sending_paused(s.organization_id)
     order by t.last_run_at nulls first, s.organization_id
     limit 100
  loop
    exit when v_left <= 0;
    begin
      -- a second run beside this one leaves the business to it
      continue when not pg_try_advisory_xact_lock(hashtextextended('review_requests:' || v_org.organization_id::text, 0));
      insert into app.review_request_turns (organization_id, last_run_at) values (v_org.organization_id, now())
      on conflict (organization_id) do update set last_run_at = excluded.last_run_at;
      v_zone := app.intake_zone(v_org.timezone);
      v_today := (now() at time zone v_zone)::date;
      v_room := least(app.review_request_business_cap(), v_left);
      for v_event in
        select e.kind, e.source_id, e.contact_id, e.event_day
          from (
            select 'deal'::text as kind, d.id as source_id, d.contact_id, (d.closed_at at time zone v_zone)::date as event_day,
                   d.closed_at as at
              from public.deals d
             where v_org.on_deal_won
               and d.organization_id = v_org.organization_id and d.status = 'won' and d.deleted_at is null
               and d.contact_id is not null
               -- an imported deal is history: switching on and then importing never asks past customers
               and d.import_job_id is null
               and d.closed_at >= v_org.enabled_at and d.closed_at <= now()
               and (d.closed_at at time zone v_zone)::date between v_today - v_org.delay_days - 7 and v_today - v_org.delay_days
               and not exists (select 1 from app.review_requests r
                                where r.organization_id = d.organization_id and r.source_kind = 'deal' and r.source_id = d.id)
            union all
            select 'meeting'::text, m.id, coalesce(m.contact_id, dl.contact_id), (m.ends_at at time zone v_zone)::date, m.ends_at
              from public.meetings m
              left join public.deals dl on dl.organization_id = m.organization_id and dl.id = m.deal_id
             where v_org.on_meeting_held
               and m.organization_id = v_org.organization_id and m.status = 'held' and not m.is_block
               -- the index on starts_at narrows the read; a meeting starts before it ends
               and m.starts_at <= now() and m.starts_at >= v_org.enabled_at - interval '2 days'
               and m.ends_at >= v_org.enabled_at and m.ends_at <= now()
               and (m.ends_at at time zone v_zone)::date between v_today - v_org.delay_days - 7 and v_today - v_org.delay_days
               and (m.deal_id is null or (dl.id is not null and dl.deleted_at is null))
               and coalesce(m.contact_id, dl.contact_id) is not null
               and not exists (select 1 from app.review_requests r
                                where r.organization_id = m.organization_id and r.source_kind = 'meeting' and r.source_id = m.id)
          ) e
         order by e.at, e.source_id
         limit v_room
      loop
        if app.review_request_one(v_org.organization_id, v_event.kind, v_event.source_id, v_event.contact_id,
                                  v_event.event_day + v_org.delay_days, v_zone) is not null then
          v_done := v_done + 1;
          v_left := v_left - 1;
        end if;
      end loop;
    exception when others then
      raise warning 'crm-review-requests: business % skipped (SQLSTATE %)', v_org.organization_id, sqlstate;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_review_requests(uuid[]) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-review-requests', '7,22,37,52 * * * *', 'select app.send_review_requests();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The landing page's price list (021232's body; the closed list gains 'review_requests' after 'sms')
-- ----------------------------------------------------------------------------
create or replace function public.plans_public()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', p.key,
        'name', p.name_he,
        'price_monthly_agorot', p.price_monthly_agorot,
        'price_annual_agorot', p.price_annual_agorot,
        'price_unit', p.price_unit,
        'availability', p.availability,
        'position', p.position,
        'limits', (
          select coalesce(jsonb_object_agg(l.key, l.value), '{}'::jsonb)
            from jsonb_each(case when jsonb_typeof(p.limits) = 'object' then p.limits else '{}'::jsonb end) l
           where l.key in ('max_users', 'max_records', 'storage_gb')
             and jsonb_typeof(l.value) in ('number', 'null')
        ),
        'features', (
          select coalesce(jsonb_agg(c.key order by c.n), '[]'::jsonb)
            from unnest(array[
              -- landing-capabilities: built, non-core keys of PLAN_CAPABILITIES (unit test compares)
              'products', 'discounts', 'quotes', 'documents', 'payments', 'collection', 'balances',
              'booking_page', 'business_card', 'qr_codes', 'site_widget', 'money_waiting', 'instant_reply',
              'goals', 'campaign_costs', 'punch_cards', 'segments', 'auto_reassign', 'lead_distribution',
              'meta_leads', 'meeting_reminders', 'signatures', 'sms', 'review_requests', 'orders', 'goals_per_rep',
              'granular_permissions', 'view_seats', 'remove_built_with'
              -- end landing-capabilities
            ]::text[]) with ordinality c(key, n)
           where jsonb_typeof(p.features) = 'object'
             and p.features -> c.key = 'true'::jsonb
        )
      )
      order by p.position, p.key
    ),
    '[]'::jsonb
  )
  from public.plans p
  where p.availability in ('available', 'coming_soon')
$$;

comment on function public.plans_public() is
  'LND-13: the public fields of available and coming-soon plans for the landing page price list; anon may execute it (owner, 11 November 2026).';

-- anon and authenticated only (owner, 11 November 2026); test 01 names it beside health_check
revoke all on function public.plans_public() from public, anon, authenticated, service_role;
grant execute on function public.plans_public() to anon, authenticated;
