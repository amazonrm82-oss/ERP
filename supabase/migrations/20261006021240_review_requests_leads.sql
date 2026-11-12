-- =============================================================================
-- RET-02 (owner 12 November 2026, answer (309) ב): a lead with whom a meeting was held gets a review request too
-- =============================================================================
-- A held meeting (status held, not a block) linked to a LEAD that is not converted, with no contact of its own or through its
-- deal, now asks that lead, under the contacts' rules: the trigger "meeting held" only (a won deal stays contact based), the
-- plan key `review_requests` and the switch, only events since enabled_at and at most 7 days late, one row per event in
-- app.review_requests, once per person per 90 days (for a lead keyed on the lead), the channel rule (the lead's
-- preferred_channel when SMS or email, else SMS with room, else email) with a recorded grant and no suppression of the
-- address (app.consent_granted / app.consent_suppressed, by address across the business). A meeting that has a contact (its
-- own, else its deal's) goes to the contact, once: the event is the meeting, judged once. A converted lead is never asked: a
-- meeting linked only to a converted lead goes to the lead's contact (convert_lead already gives the lead's meetings the
-- contact; this covers a meeting linked to the lead later). Meetings are never imported, so the "never imported" rule of a
-- won deal has no lead counterpart.
--
-- * app.review_requests gains lead_id (composite FK to leads on delete cascade, a full index (organization_id, lead_id,
--   created_at) that also serves the 90 days' read). At most one of lead_id / contact_id (review_requests_one_person); a
--   queued request names exactly one (review_requests_queued_person). A row whose person was gone when judged
--   ('no_contact') names neither, as before.
-- * The 90 days follow the person: when a lead is converted (converted_at and converted_contact_id set) its rows move to the
--   contact (trigger leads_review_requests_convert, app.convert_review_requests), and a lead merge moves the duplicate's rows
--   to the kept lead, or to the kept lead's contact when the kept lead is converted (app.merge_review_requests, now with a
--   lead branch; trigger activities_merge_review_requests also fires on a lead's `merged` entry).
-- * app.review_request_person(org, kind, source, lead, contact, due, zone) judges one event for a lead or a contact (exactly
--   one given); app.review_request_one (021235's signature) is now its wrapper for a contact. The job payload names the lead
--   (`lead_id`) or the contact, ids only: app.job_payload_ok (021235's body; only the review_request_id block: a contact OR a
--   lead).
-- * app.send_review_requests: 021235's body; only the meeting branch of the events query (the lead column, the converted
--   lead's contact) and the call (app.review_request_person).
--
-- Independent review of the branch:
-- * (1) The job skips a business while the platform's outside-link switch holds it (app.qr_external_off; the settings check
--   of 021239 refuses switching on or a new link meanwhile).
-- * (3) A race with conversion: a lead found converted when its event is judged asks its converted contact (live) instead,
--   and a contact's 90 days also count the rows still on a lead converted into it.
-- * (2) The 90 days also hold per address: a request queued in the last 90 days to the same address (the chosen channel's
--   phone or email) makes a new one 'recent', whoever holds the address now. The address is kept only as its HMAC
--   (app.consent_address_hash, the consent hash key, keyed per business) in app.review_requests.address_hash, set when a
--   request is queued; without the key nothing is hashed and only the per-person rule holds.
--
-- THE FUTURE SENDER (021235's note, plus): right before it sends it re-reads the request by review_request_id scoped to the
-- job's business only, and takes the person (lead_id or contact_id) and the address from the request row and that person's
-- current record, never from the payload's lead_id / contact_id; it sends nothing while the platform's outside-link switch
-- holds the business (app.qr_external_off), and otherwise keeps 021235's conditions (the key, the switch, the stored link
-- passing app.review_url_ok, filled only with that link, marketingEnvelope(), app.message_template_sendable,
-- app.message_filled_problem, no rating step).
--
-- Safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The table: the lead
-- ----------------------------------------------------------------------------
alter table app.review_requests add column if not exists lead_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'review_requests_lead_fk' and conrelid = 'app.review_requests'::regclass) then
    alter table app.review_requests add constraint review_requests_lead_fk
      foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'review_requests_one_person' and conrelid = 'app.review_requests'::regclass) then
    alter table app.review_requests add constraint review_requests_one_person check (num_nonnulls(lead_id, contact_id) <= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'review_requests_queued_person' and conrelid = 'app.review_requests'::regclass) then
    alter table app.review_requests add constraint review_requests_queued_person
      check (outcome <> 'queued' or num_nonnulls(lead_id, contact_id) = 1);
  end if;
end;
$$;
-- a full index: it covers the lead foreign key, and the 90 days' read for a lead
create index if not exists review_requests_lead_idx on app.review_requests (organization_id, lead_id, created_at);
-- review (2): the HMAC of the address a request was queued to (server only; null without the key)
alter table app.review_requests add column if not exists address_hash text;
create index if not exists review_requests_address_idx on app.review_requests (organization_id, address_hash, created_at)
  where address_hash is not null;

-- ----------------------------------------------------------------------------
-- The 90 days follow a converted lead to its contact
-- ----------------------------------------------------------------------------
create or replace function app.convert_review_requests() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.converted_at is null or new.converted_contact_id is null then
    return null;
  end if;
  update app.review_requests r set contact_id = new.converted_contact_id, lead_id = null
   where r.organization_id = new.organization_id and r.lead_id = new.id;
  return null;
end;
$$;
revoke all on function app.convert_review_requests() from public, anon, authenticated, service_role;

create or replace trigger leads_review_requests_convert
  after update of converted_at, converted_contact_id on public.leads
  for each row
  when (new.converted_at is not null and new.converted_contact_id is not null)
  execute function app.convert_review_requests();

-- A merge (021235's contact branch unchanged) moves the duplicate's requests to the kept record, through the `merged` entry
-- written before the duplicate is deleted; a lead's go to the kept lead, or to its contact when the kept lead is converted.
create or replace function app.merge_review_requests() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_contact uuid;
begin
  if coalesce(new.metadata ->> 'merged_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.contact_id is not null then
    if v_merged <> new.contact_id then
      update app.review_requests r set contact_id = new.contact_id
       where r.organization_id = new.organization_id and r.contact_id = v_merged;
    end if;
  elsif new.lead_id is not null and v_merged <> new.lead_id then
    select l.converted_contact_id into v_contact
      from public.leads l
     where l.organization_id = new.organization_id and l.id = new.lead_id and l.converted_at is not null;
    if v_contact is not null then
      update app.review_requests r set contact_id = v_contact, lead_id = null
       where r.organization_id = new.organization_id and r.lead_id = v_merged;
    else
      update app.review_requests r set lead_id = new.lead_id
       where r.organization_id = new.organization_id and r.lead_id = v_merged;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_review_requests() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_review_requests after insert on public.activities
  for each row
  when (new.type = 'system' and (new.contact_id is not null or new.lead_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_review_requests();

-- ----------------------------------------------------------------------------
-- The queue payload: a review request on a contact or a lead
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
      -- contact or (owner (309) ב) a lead, by SMS or email, with no files, reply-to person, sender or rule
      and (not (p_payload ? 'review_request_id')
           or (jsonb_typeof(p_payload -> 'review_request_id') = 'string'
               and (p_payload ->> 'review_request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'review_request'
               and (p_payload ? 'contact_id' or p_payload ? 'lead_id')
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
-- One event, for a lead or a contact (exactly one given): judged once, at most one request queued
-- ----------------------------------------------------------------------------
-- 021235's app.review_request_one body; only the person's read (a live, unconverted lead, or a live contact), the 90 days
-- by that person, and the payload's lead_id | contact_id. Answers the outcome; never raises ('failed' and one warning).
create or replace function app.review_request_person(p_org uuid, p_kind text, p_source uuid, p_lead uuid, p_contact uuid,
                                                     p_due date, p_zone text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_lead uuid;
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
  v_target uuid := p_contact;
  v_converted_at timestamptz;
  v_converted_contact uuid;
  v_hash text;
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
    if v_target is null and p_lead is not null then
      -- (309) ב: a live lead that is not converted; review (3): one converted meanwhile asks its contact instead
      select l.converted_at, l.converted_contact_id into v_converted_at, v_converted_contact
        from public.leads l
       where l.organization_id = p_org and l.id = p_lead and l.deleted_at is null;
      if found and v_converted_at is null then
        select l.id, nullif(btrim(l.phone_e164), ''), nullif(btrim(l.email), ''), l.preferred_channel
          into v_lead, v_phone, v_email, v_preferred
          from public.leads l
         where l.organization_id = p_org and l.id = p_lead;
      elsif found then
        v_target := v_converted_contact;
      end if;
    end if;
    if v_target is not null then
      select c.id, nullif(btrim(c.phone_e164), ''), nullif(btrim(c.email), ''), c.preferred_channel
        into v_contact, v_phone, v_email, v_preferred
        from public.contacts c
       where c.organization_id = p_org and c.id = v_target and c.deleted_at is null;
    end if;
    if v_contact is null and v_lead is null then
      update app.review_requests set outcome = 'no_contact' where id = v_id;
      return 'no_contact';
    end if;
    update app.review_requests set contact_id = v_contact, lead_id = v_lead where id = v_id;
    -- once per person per 90 days (a request queued, whatever became of it)
    if exists (select 1 from app.review_requests r
                where r.organization_id = p_org
                  and (r.contact_id = v_contact or r.lead_id = v_lead
                       -- review (3): a contact's 90 days also count rows still on a lead converted into it
                       or (v_contact is not null and r.lead_id in (select l.id from public.leads l
                                                                     where l.organization_id = p_org
                                                                       and l.converted_contact_id = v_contact)))
                  and r.outcome = 'queued'
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

    -- review (2): once per address per 90 days too (the HMAC of the chosen channel's address; no key = not checked)
    if app.consent_key_present() then
      v_hash := app.consent_address_hash(p_org, case when v_channel = 'email' then 'email' else 'phone' end,
                                         case when v_channel = 'email' then v_email else v_phone end);
    end if;
    if v_hash is not null
       and exists (select 1 from app.review_requests r
                    where r.organization_id = p_org and r.address_hash = v_hash and r.outcome = 'queued'
                      and r.created_at > now() - make_interval(days => app.review_request_gap_days())) then
      update app.review_requests set outcome = 'recent' where id = v_id;
      return 'recent';
    end if;

    v_job := app.enqueue_job(
      p_org, 'message.send',
      jsonb_build_object('channel', v_channel, 'message_type', 'review_request', 'template_id', v_template,
                         'review_request_id', v_id,
                         -- valid until the end of the 7th day after the due day, in the business's zone
                         'event_at', to_char(((p_due + 8)::timestamp at time zone p_zone) at time zone 'UTC',
                                             'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      || case when v_contact is not null then jsonb_build_object('contact_id', v_contact)
              else jsonb_build_object('lead_id', v_lead) end);
    update app.review_requests set outcome = 'queued', channel = v_channel, job_id = v_job, address_hash = v_hash where id = v_id;
    return 'queued';
  exception when others then
    raise warning 'crm-review-requests: % % of business % failed (SQLSTATE %)', p_kind, p_source, p_org, sqlstate;
    update app.review_requests set outcome = 'failed' where id = v_id;
    return 'failed';
  end;
end;
$$;
revoke all on function app.review_request_person(uuid, text, uuid, uuid, uuid, date, text) from public, anon, authenticated, service_role;

-- 021235's signature, for a contact
create or replace function app.review_request_one(p_org uuid, p_kind text, p_source uuid, p_contact uuid, p_due date,
                                                  p_zone text)
returns text
language sql security definer
set search_path = ''
as $$ select app.review_request_person(p_org, p_kind, p_source, null, p_contact, p_due, p_zone) $$;
revoke all on function app.review_request_one(uuid, text, uuid, uuid, date, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job (021235's body; the meeting branch also names an unconverted lead, and a converted lead's contact)
-- ----------------------------------------------------------------------------
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
       -- review (1): never while the platform has switched off the business's outside links
       and not app.qr_external_off(s.organization_id)
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
        select e.kind, e.source_id, e.lead_id, e.contact_id, e.event_day
          from (
            select 'deal'::text as kind, d.id as source_id, null::uuid as lead_id, d.contact_id,
                   (d.closed_at at time zone v_zone)::date as event_day, d.closed_at as at
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
            -- (309) ב: the meeting's contact (its own, else its deal's, else a converted lead's); only without one, its
            -- unconverted lead. One event per meeting, so a meeting with a lead and a contact asks the contact once.
            select 'meeting'::text, m.id,
                   case when coalesce(m.contact_id, dl.contact_id, case when ld.converted_at is not null then ld.converted_contact_id end) is null
                        then case when ld.converted_at is null then ld.id end end,
                   coalesce(m.contact_id, dl.contact_id, case when ld.converted_at is not null then ld.converted_contact_id end),
                   (m.ends_at at time zone v_zone)::date, m.ends_at
              from public.meetings m
              left join public.deals dl on dl.organization_id = m.organization_id and dl.id = m.deal_id
              left join public.leads ld on ld.organization_id = m.organization_id and ld.id = m.lead_id and ld.deleted_at is null
             where v_org.on_meeting_held
               and m.organization_id = v_org.organization_id and m.status = 'held' and not m.is_block
               -- the index on starts_at narrows the read; a meeting starts before it ends
               and m.starts_at <= now() and m.starts_at >= v_org.enabled_at - interval '2 days'
               and m.ends_at >= v_org.enabled_at and m.ends_at <= now()
               and (m.ends_at at time zone v_zone)::date between v_today - v_org.delay_days - 7 and v_today - v_org.delay_days
               and (m.deal_id is null or (dl.id is not null and dl.deleted_at is null))
               and (coalesce(m.contact_id, dl.contact_id) is not null or ld.id is not null)
               and not exists (select 1 from app.review_requests r
                                where r.organization_id = m.organization_id and r.source_kind = 'meeting' and r.source_id = m.id)
          ) e
         where e.lead_id is not null or e.contact_id is not null
         order by e.at, e.source_id
         limit v_room
      loop
        if app.review_request_person(v_org.organization_id, v_event.kind, v_event.source_id, v_event.lead_id, v_event.contact_id,
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
