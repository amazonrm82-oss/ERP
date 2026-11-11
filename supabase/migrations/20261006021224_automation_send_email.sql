-- =============================================================================
-- AUT-08: an automation step that sends one email from a template (send_email), beside SMS-02's send_sms
-- =============================================================================
-- SPEC-ADDITIONS AUT-08 ("send actions: email, SMS and WhatsApp from a template, subject to consents"). SMS-02 (021202) built
-- the SMS step; this adds `send_email` {template_id} on lead, contact and deal rules with the same rules (WhatsApp waits for
-- wave 4 and its provider). Like every message it is an OPS-04 `message.send` job of ids only, judged when it goes out by the
-- queue's own send check (public.job_message_may_send, unchanged: no opt-out and a recorded grant for marketing, the
-- blocklist / erasure for service types, HEB-09's pause, sending hours, rates and MSG-05's caps). Nothing on the worker's
-- path changes (claim_jobs, finish_job, job_message_may_send and app.jobs_record_message keep their md5 in test 284). No new
-- use of the service key. No row is deleted here. Every statement is safe to run twice.
--
-- * app.automation_send_email (new, definer, no grants) = app.automation_send_sms's rule (021218) for email:
--   - the record is a live lead or contact, or a deal's live contact; with a session (a button press or an admin's test run)
--     the deal's contact must also be readable by that person (EML-02's rule, app.record_email_readable);
--   - the address is the record's own primary email (EML-02's shape check); the payload names only the record;
--   - the template (app.record_email_template_refusal, new): the business's, of channel email, never one the system sends
--     itself (notice_kind, 021218), marketing or a card's service types (app.record_email_service_types: requested_document,
--     collection), sendable now (app.message_template_sendable); collection needs the plan keys collection, documents and
--     payments, and with a session the PRESSER's app.can_record_payments;
--   - no attachments (record files and library files are a person's choice on the card only, owner (198) ב);
--   - one email per rule and record a business day (the business's zone), under a lock of the rule and record: a second one
--     queues nothing and the step is ok with the warning 'an email was already sent today by this rule';
--   - a run with a session counts in that person's 30 emails an hour (app.automation_email_sent_last_hour: the card's emails
--     and the button presses' together); over it the step warns 'too many emails this hour by the person who pressed';
--   - while HEB-09's pause holds the job is queued and waits; the step is ok with 'customer sending is paused'.
--   The job: {channel email, message_type, template_id, automation_id, pressed_by_user_id?, lead_id | contact_id, deal_id?}.
-- * app.job_payload_ok (021218's body): automation_id and pressed_by_user_id now on email too; an automation's email carries
--   no reply_to_user_id, file_ids or library_file_ids; sent_by_user_id stays sms only. Changed lines are marked "AUT-08".
-- * app.automation_send_sms (021218's body): the once-a-day check counts only SMS jobs (an email of the same rule and record
--   does not block its SMS). app.record_sms_sent_last_hour (021202's body): a button press counts only its SMS there.
-- * Final review: with a session, app.automation_send_email and app.automation_send_sms take the person's two send locks up
--   front in one fixed order, record_email:<user> then record_sms:<user>, so two button rules with their steps in opposite
--   orders cannot deadlock (40P01). The cards take only their own one lock.
-- * app.automations_sms_collection_check (021202's body) also judges send_email steps: a collection email step is saved only
--   by a payment recorder (hint automation:email_collection; SMS keeps automation:sms_collection). The trigger is unchanged.
-- * app.run_automation_actions: 021202's body (the latest), every line kept, plus the branch `send_email` and its warning.
-- * app.record_email_enqueue (021218's body; review 5): the card's 30 emails an hour count the person's button presses of email
--   rules too, through app.automation_email_sent_last_hour (the only changed lines are marked "AUT-08 review 5").
-- The email itself (the template filled, a marketing one inside marketingEnvelope's rule) is judged by
-- app.message_filled_problem when it goes out, by the future sender (the approved adapter path).

-- ----------------------------------------------------------------------------
-- The queue payload: 021218's body; AUT-08 lets an automation's email carry automation_id / pressed_by_user_id
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
                               'sender_check_id', 'signature_document_id'))
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

-- 021202's body; AUT-08: a button press counts only its SMS here
create or replace function app.record_sms_sent_last_hour(p_user uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select ((select count(*) from app.jobs j
            where j.kind = 'message.send' and j.payload ? 'sent_by_user_id'
              and (j.payload ->> 'sent_by_user_id') = p_user::text and j.created_at > now() - interval '1 hour')
        + (select count(*) from app.jobs j
            where j.kind = 'message.send' and j.payload ? 'pressed_by_user_id'
              and (j.payload ->> 'pressed_by_user_id') = p_user::text and j.created_at > now() - interval '1 hour'
              -- AUT-08: a button press's email is counted with the person's emails (app.automation_email_sent_last_hour)
              and (j.payload ->> 'channel') = 'sms'))::integer
$$;
revoke all on function app.record_sms_sent_last_hour(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.automation_send_sms: 021218's body; AUT-08: the once-a-day check counts this rule's SMS only
-- ----------------------------------------------------------------------------
create or replace function app.automation_send_sms(p_auto public.automations, p_entity text, p_id uuid, p_template uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_org uuid := p_auto.organization_id;
  v_phone text;
  v_contact uuid;
  v_deleted timestamptz;
  v_refusal text;
  v_type text;
  v_zone text;
  v_day_start timestamptz;
  v_record_key text;
  v_presser uuid := auth.uid();
begin
  -- AUT-08 final review: a run with a session takes the person's two send locks up front, always record_email then record_sms,
  -- so two button rules with their email and SMS steps in opposite orders never wait on each other (40P01); the later
  -- per-person locks of this function are then re-entrant
  if v_presser is not null then
    perform pg_advisory_xact_lock(hashtextextended('record_email:' || v_presser::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('record_sms:' || v_presser::text, 0));
  end if;
  if p_entity not in ('lead', 'contact', 'deal') then
    raise exception 'an SMS goes to a lead, a contact or a deal''s contact';
  end if;
  -- review F1: the plan's sms flag
  if not app.org_has_feature(v_org, 'sms') then
    raise exception 'SMS is not in the plan';
  end if;
  if p_template is null then
    raise exception 'the SMS template no longer exists';
  end if;
  if p_entity = 'lead' then
    select l.phone_e164, l.deleted_at into v_phone, v_deleted from public.leads l where l.organization_id = v_org and l.id = p_id;
  elsif p_entity = 'contact' then
    select c.phone_e164, c.deleted_at into v_phone, v_deleted from public.contacts c where c.organization_id = v_org and c.id = p_id;
    v_contact := p_id;
  else
    select d.contact_id, d.deleted_at into v_contact, v_deleted from public.deals d where d.organization_id = v_org and d.id = p_id;
  end if;
  if not found then
    raise exception 'the record no longer exists';
  end if;
  if v_deleted is not null then
    raise exception 'the record is in the recycle bin';
  end if;
  if p_entity = 'deal' then
    select c.phone_e164 into v_phone from public.contacts c
     where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null;
    if v_contact is null or not found then
      raise exception 'the deal has no contact';
    end if;
  end if;
  if nullif(btrim(v_phone), '') is null then
    raise exception 'the record has no phone';
  end if;
  -- p_person: a run with a session (a button press, an admin's test run) judges collection by that person's right
  v_refusal := app.record_sms_template_refusal(v_org, p_template, auth.uid() is not null);
  if v_refusal = 'template' then
    raise exception 'the SMS template no longer exists';
  elsif v_refusal = 'channel' then
    raise exception 'the template is not an SMS template';
  elsif v_refusal = 'feature:sms' then
    raise exception 'SMS is not in the plan';
  elsif v_refusal = 'type' then
    raise exception 'this message type is not sent by an automation';
  elsif v_refusal = 'notice_template' then
    -- SGN-03 review M1
    raise exception 'the system sends this template itself, not an automation';
  elsif v_refusal = 'collection' then
    raise exception 'collection messages need the payments right of the person who pressed';
  elsif v_refusal like 'feature:%' then
    raise exception 'collection messages are not in the plan';
  elsif v_refusal = 'not_sendable:inactive' then
    raise exception 'the SMS template is off';
  elsif v_refusal is not null then
    raise exception 'the SMS template cannot be sent';
  end if;
  select t.message_type into v_type from public.message_templates t where t.organization_id = v_org and t.id = p_template;

  -- review F4: one SMS per rule and record a business day (the business's zone), under a lock of the rule and record
  v_record_key := case when p_entity = 'lead' then 'lead_id' when p_entity = 'contact' then 'contact_id' else 'deal_id' end;
  perform pg_advisory_xact_lock(hashtextextended('automation_sms:' || p_auto.id::text || ':' || p_id::text, 0));
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
  v_day_start := ((now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date)::timestamp at time zone coalesce(v_zone, 'Asia/Jerusalem');
  if exists (
    select 1 from app.jobs j
     where j.organization_id = v_org and j.kind = 'message.send' and j.payload ? 'automation_id' and j.created_at >= v_day_start
       and (j.payload ->> 'automation_id') = p_auto.id::text
       -- AUT-08: only this rule's SMS (its email of the same record is counted by app.automation_send_email)
       and (j.payload ->> 'channel') = 'sms'
       and (j.payload ->> v_record_key) = p_id::text) then
    return 'an SMS was already sent today by this rule';
  end if;
  -- review (7): a run with a session (a button press, an admin's test run) counts in that person's 30 an hour
  if v_presser is not null then
    perform pg_advisory_xact_lock(hashtextextended('record_sms:' || v_presser::text, 0));
    if app.record_sms_sent_last_hour(v_presser) >= app.record_sms_hourly_limit() then
      return 'too many SMS this hour by the person who pressed';
    end if;
  end if;

  perform app.enqueue_job(v_org, 'message.send',
    jsonb_build_object('channel', 'sms', 'message_type', v_type, 'template_id', p_template, 'automation_id', p_auto.id)
      || case when v_presser is not null then jsonb_build_object('pressed_by_user_id', v_presser) else '{}'::jsonb end
      || case when p_entity = 'lead' then jsonb_build_object('lead_id', p_id) else jsonb_build_object('contact_id', v_contact) end
      || case when p_entity = 'deal' then jsonb_build_object('deal_id', p_id) else '{}'::jsonb end,
    null);
  return case when coalesce(app.customer_sending_paused(v_org), false) then 'customer sending is paused' end;
end;
$$;
revoke all on function app.automation_send_sms(public.automations, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Why a template cannot go out as an automation's email of this business now (null = it can): 'template' (not the
-- business's), 'channel' (not email), 'notice_template' (the system sends it itself), 'type' (a service type a card does not
-- send), 'collection' (with a session, a person who does not record payments), 'feature:collection|documents|payments', or
-- 'not_sendable:<code>' (app.message_template_sendable). = app.record_sms_template_refusal (021218) for email; email needs
-- no plan flag (EML-02).
-- ----------------------------------------------------------------------------
create or replace function app.record_email_template_refusal(p_org uuid, p_template uuid, p_person boolean) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_tpl public.message_templates%rowtype;
  v_problem text;
begin
  select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    return 'template';
  end if;
  if v_tpl.channel <> 'email' then
    return 'channel';
  end if;
  if v_tpl.notice_kind is not null then
    return 'notice_template';
  end if;
  if v_tpl.message_type = any (app.service_message_types()) and not v_tpl.message_type = any (app.record_email_service_types()) then
    return 'type';
  end if;
  if v_tpl.message_type = 'collection' then
    if p_person and not app.can_record_payments(p_org) then
      return 'collection';
    end if;
    if not app.org_has_feature(p_org, 'collection') then
      return 'feature:collection';
    end if;
    if not app.org_has_feature(p_org, 'documents') then
      return 'feature:documents';
    end if;
    if not app.org_has_feature(p_org, 'payments') then
      return 'feature:payments';
    end if;
  end if;
  v_problem := app.message_template_sendable(p_org, p_template);
  if v_problem is not null then
    return 'not_sendable:' || v_problem;
  end if;
  return null;
end;
$$;
revoke all on function app.record_email_template_refusal(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- the emails a person queued in the last hour, across every business: from a card (reply_to_user_id) and from a button rule
-- they pressed (pressed_by_user_id on an email)
create or replace function app.automation_email_sent_last_hour(p_user uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select ((select count(*) from app.jobs j
            where j.kind = 'message.send' and j.payload ? 'reply_to_user_id'
              and (j.payload ->> 'reply_to_user_id') = p_user::text and j.created_at > now() - interval '1 hour')
        + (select count(*) from app.jobs j
            where j.kind = 'message.send' and j.payload ? 'pressed_by_user_id'
              and (j.payload ->> 'pressed_by_user_id') = p_user::text and j.created_at > now() - interval '1 hour'
              and (j.payload ->> 'channel') = 'email'))::integer
$$;
revoke all on function app.automation_email_sent_last_hour(uuid) from public, anon, authenticated, service_role;

create index if not exists jobs_automation_email_idx on app.jobs (organization_id, created_at)
  where kind = 'message.send' and payload ? 'automation_id' and (payload ->> 'channel') = 'email';

-- ----------------------------------------------------------------------------
-- app.record_email_enqueue: 021218's body (the latest); AUT-08 review 5: the 30 an hour also count the person's button presses
-- of email rules (pressed_by_user_id on an email job), symmetric with SMS's app.record_sms_sent_last_hour
-- ----------------------------------------------------------------------------
create or replace function app.record_email_enqueue(p_org uuid, p_kind text, p_record uuid, p_template uuid,
                                                    p_files uuid[], p_library_files uuid[])
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
  v_team uuid;
  v_deleted timestamptz;
  v_contact uuid;
  v_c_owner uuid;
  v_c_team uuid;
  v_c_deleted timestamptz;
  v_email text;
  v_tpl public.message_templates%rowtype;
  v_problem text;
  v_files uuid[];
  v_library uuid[];
  v_found integer;
  v_bytes bigint := 0;
  v_more bigint;
  v_today date;
  v_payload jsonb;
  v_job uuid;
begin
  if v_user is null or p_org is null or p_record is null or p_template is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'contact', 'deal') then
    raise exception 'unknown record type' using errcode = 'P0001', hint = 'record_email:kind';
  end if;
  -- (193) ב: the activities_insert rule: a member who may write (never a viewer or a support session) in a writable
  -- business, who reads the record
  if not app.can_write(p_org) then
    raise exception 'not permitted' using errcode = '42501', hint = 'record_email:not_permitted';
  end if;

  if p_kind = 'lead' then
    select l.owner_id, l.team_id, l.deleted_at, l.email into v_owner, v_team, v_deleted, v_email
      from public.leads l where l.organization_id = p_org and l.id = p_record;
  elsif p_kind = 'contact' then
    select c.owner_id, c.team_id, c.deleted_at, c.email into v_owner, v_team, v_deleted, v_email
      from public.contacts c where c.organization_id = p_org and c.id = p_record;
    v_contact := p_record;
  else
    select d.owner_id, d.team_id, d.deleted_at, d.contact_id into v_owner, v_team, v_deleted, v_contact
      from public.deals d where d.organization_id = p_org and d.id = p_record;
  end if;
  if not found or v_deleted is not null or not app.record_email_readable(p_org, p_kind, p_record, v_owner, v_team) then
    raise exception 'record not found' using errcode = 'P0001', hint = 'record_email:not_found';
  end if;
  if p_kind = 'deal' then
    -- the deal's message goes to its contact, who must be live and readable by the sender
    if v_contact is null then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_email:no_contact';
    end if;
    select c.owner_id, c.team_id, c.deleted_at, c.email into v_c_owner, v_c_team, v_c_deleted, v_email
      from public.contacts c where c.organization_id = p_org and c.id = v_contact;
    if not found or v_c_deleted is not null
       or not app.record_email_readable(p_org, 'contact', v_contact, v_c_owner, v_c_team) then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_email:no_contact';
    end if;
  end if;
  if v_email is null or btrim(v_email) !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'the record has no email' using errcode = 'P0001', hint = 'record_email:no_address';
  end if;

  select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    raise exception 'template not found' using errcode = 'P0001', hint = 'record_email:template';
  end if;
  if v_tpl.channel <> 'email' then
    raise exception 'not an email template' using errcode = 'P0001', hint = 'record_email:channel';
  end if;
  -- SGN-03 review M1: a template the system sends itself (notice_kind) is never sent from a card
  if v_tpl.notice_kind is not null then
    raise exception 'the system sends this template itself' using errcode = 'P0001', hint = 'record_message:notice_template';
  end if;
  -- (194) א: marketing, a requested document, or collection for whoever records payments; no other service type
  if v_tpl.message_type = any (app.service_message_types()) and not v_tpl.message_type = any (app.record_email_service_types()) then
    raise exception 'this type is not sent from a card' using errcode = 'P0001', hint = 'record_email:type';
  end if;
  if v_tpl.message_type = 'collection' then
    if not app.can_record_payments(p_org) then
      raise exception 'collection needs the payments right' using errcode = 'P0001', hint = 'record_email:collection';
    end if;
    -- lead's interim choice: the plan keys of every collection feature
    if not app.org_has_feature(p_org, 'collection') then
      raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:collection';
    end if;
    if not app.org_has_feature(p_org, 'documents') then
      raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:documents';
    end if;
    if not app.org_has_feature(p_org, 'payments') then
      raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:payments';
    end if;
  end if;
  -- MSG-02: every sender asks right before it sends (inactive included); a refusal names the reason code only
  v_problem := app.message_template_sendable(p_org, p_template);
  if v_problem is not null then
    raise exception 'the template cannot be sent' using errcode = 'P0001', hint = 'record_email:not_sendable', detail = v_problem;
  end if;

  select coalesce(array_agg(distinct f order by f), '{}') into v_files from unnest(coalesce(p_files, '{}'::uuid[])) f where f is not null;
  select coalesce(array_agg(distinct f order by f), '{}') into v_library
    from unnest(coalesce(p_library_files, '{}'::uuid[])) f where f is not null;
  if cardinality(v_files) + cardinality(v_library) > app.record_email_max_files() then
    raise exception 'too many files' using errcode = 'P0001', hint = 'record_email:files_max';
  end if;
  if cardinality(v_files) > 0 then
    select count(*), coalesce(sum(f.size_bytes), 0) into v_found, v_bytes
      from public.files f
     where f.organization_id = p_org and f.id = any (v_files)
       and f.unconfirmed_since is null
       and case p_kind when 'lead' then f.lead_id = p_record when 'contact' then f.contact_id = p_record else f.deal_id = p_record end
       -- a file on a private note is its author's and the admins' (REC-07); the wrapper also read each file under RLS
       and (f.activity_id is null or exists (
             select 1 from public.activities a
              where a.organization_id = f.organization_id and a.id = f.activity_id
                and (not a.is_private or a.created_by = v_user or app.is_admin(p_org))));
    if v_found <> cardinality(v_files) then
      raise exception 'a file is not a file of this record' using errcode = 'P0001', hint = 'record_email:file';
    end if;
  end if;
  -- owner (198) ב: library files go on a marketing template and on a card's service template alike, but only in a
  -- person's manual send from the card, never while an automation runs (no automation step sends email today; this keeps
  -- a future one, or a manual-button rule, from passing them)
  if cardinality(v_library) > 0 and current_setting('app.automation_running', true) = 'on' then
    raise exception 'library files are sent from the card only' using errcode = 'P0001', hint = 'record_email:library_automation';
  end if;
  if cardinality(v_library) > 0 then
    -- (197) ב: the current file (newest confirmed) of an active file item valid today in the business's zone, one per item
    v_today := app.org_zone_today(p_org);
    select count(*), coalesce(sum(f.size_bytes), 0) into v_found, v_more
      from public.files f
      join public.library_items i on i.organization_id = f.organization_id and i.id = f.library_item_id
     where f.organization_id = p_org and f.id = any (v_library)
       and f.unconfirmed_since is null
       and i.kind = 'file' and i.is_active
       and (i.valid_from is null or i.valid_from <= v_today)
       and (i.valid_until is null or i.valid_until >= v_today)
       and not exists (
             select 1 from public.files n
              where n.organization_id = f.organization_id and n.library_item_id = f.library_item_id
                and n.unconfirmed_since is null and (n.created_at, n.id) > (f.created_at, f.id));
    if v_found <> cardinality(v_library) then
      raise exception 'a library file cannot be sent' using errcode = 'P0001', hint = 'record_email:library';
    end if;
    v_bytes := v_bytes + v_more;
  end if;
  if v_bytes > app.record_email_max_bytes() then
    raise exception 'the files are too large' using errcode = 'P0001', hint = 'record_email:files_size';
  end if;

  -- (196) א: at most 30 a person an hour across every business, counted under a lock of the person so two tabs cannot
  -- pass it together
  perform pg_advisory_xact_lock(hashtextextended('record_email:' || v_user::text, 0));
  -- AUT-08 review 5: the person's button presses of email rules count too (app.automation_email_sent_last_hour), as SMS
  v_found := app.automation_email_sent_last_hour(v_user);
  if v_found >= app.record_email_hourly_limit() then
    raise exception 'too many emails this hour' using errcode = 'P0001', hint = 'record_email:rate';
  end if;

  v_payload := jsonb_build_object('channel', 'email', 'message_type', v_tpl.message_type, 'template_id', v_tpl.id,
                                  'reply_to_user_id', v_user)
               || case when p_kind = 'lead' then jsonb_build_object('lead_id', p_record)
                       else jsonb_build_object('contact_id', v_contact) end
               || case when p_kind = 'deal' then jsonb_build_object('deal_id', p_record) else '{}'::jsonb end
               || case when cardinality(v_files) > 0 then jsonb_build_object('file_ids', to_jsonb(v_files)) else '{}'::jsonb end
               || case when cardinality(v_library) > 0 then jsonb_build_object('library_file_ids', to_jsonb(v_library))
                       else '{}'::jsonb end;
  v_job := app.enqueue_job(p_org, 'message.send', v_payload, null);

  -- owner (198) ב: the audit log records which files went with the email, ids and names only (no content, no address),
  -- on the record the message is for (the lead, else the contact: a deal's email is recorded on its contact, with the
  -- deal's id), so a privacy erasure of that person erases the entry with the rest of their audit history
  if cardinality(v_files) + cardinality(v_library) > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, v_user, 'email_attachments',
            case when p_kind = 'lead' then 'leads' else 'contacts' end,
            case when p_kind = 'lead' then p_record else v_contact end,
            jsonb_build_object('job_id', v_job, 'template_id', v_tpl.id, 'message_type', v_tpl.message_type)
            || case when p_kind = 'deal' then jsonb_build_object('deal_id', p_record) else '{}'::jsonb end
            || jsonb_build_object(
                 'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by f.id)
                                      from public.files f
                                     where f.organization_id = p_org and f.id = any (v_files)), '[]'::jsonb),
                 'library_files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name,
                                                                                'library_item_id', f.library_item_id) order by f.id)
                                              from public.files f
                                             where f.organization_id = p_org and f.id = any (v_library)), '[]'::jsonb)));
  end if;
  return jsonb_build_object('job_id', v_job, 'paused', coalesce(app.customer_sending_paused(p_org), false));
end;
$$;
revoke all on function app.record_email_enqueue(uuid, text, uuid, uuid, uuid[], uuid[]) from public, anon, authenticated;
-- only for public.record_email_send (invoker); schema app is not exposed by the API
grant execute on function app.record_email_enqueue(uuid, text, uuid, uuid, uuid[], uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- The step send_email (AUT-08): see the header
-- ----------------------------------------------------------------------------
create or replace function app.automation_send_email(p_auto public.automations, p_entity text, p_id uuid, p_template uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_org uuid := p_auto.organization_id;
  v_email text;
  v_contact uuid;
  v_deleted timestamptz;
  v_c_owner uuid;
  v_c_team uuid;
  v_refusal text;
  v_type text;
  v_zone text;
  v_day_start timestamptz;
  v_record_key text;
  v_presser uuid := auth.uid();
begin
  -- AUT-08 final review: a run with a session takes the person's two send locks up front, always record_email then record_sms,
  -- so two button rules with their email and SMS steps in opposite orders never wait on each other (40P01); the later
  -- per-person locks of this function are then re-entrant
  if v_presser is not null then
    perform pg_advisory_xact_lock(hashtextextended('record_email:' || v_presser::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('record_sms:' || v_presser::text, 0));
  end if;
  if p_entity not in ('lead', 'contact', 'deal') then
    raise exception 'an email goes to a lead, a contact or a deal''s contact';
  end if;
  if p_template is null then
    raise exception 'the email template no longer exists';
  end if;
  if p_entity = 'lead' then
    select l.email, l.deleted_at into v_email, v_deleted from public.leads l where l.organization_id = v_org and l.id = p_id;
  elsif p_entity = 'contact' then
    select c.email, c.deleted_at into v_email, v_deleted from public.contacts c where c.organization_id = v_org and c.id = p_id;
    v_contact := p_id;
  else
    select d.contact_id, d.deleted_at into v_contact, v_deleted from public.deals d where d.organization_id = v_org and d.id = p_id;
  end if;
  if not found then
    raise exception 'the record no longer exists';
  end if;
  if v_deleted is not null then
    raise exception 'the record is in the recycle bin';
  end if;
  if p_entity = 'deal' then
    select c.email, c.owner_id, c.team_id into v_email, v_c_owner, v_c_team from public.contacts c
     where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null;
    if v_contact is null or not found then
      raise exception 'the deal has no contact';
    end if;
    -- EML-02: with a session the deal's contact must be readable by that person
    if v_presser is not null and not app.record_email_readable(v_org, 'contact', v_contact, v_c_owner, v_c_team) then
      raise exception 'the deal has no contact';
    end if;
  end if;
  if v_email is null or btrim(v_email) !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'the record has no email';
  end if;
  -- p_person: a run with a session (a button press, an admin's test run) judges collection by that person's right
  v_refusal := app.record_email_template_refusal(v_org, p_template, v_presser is not null);
  if v_refusal = 'template' then
    raise exception 'the email template no longer exists';
  elsif v_refusal = 'channel' then
    raise exception 'the template is not an email template';
  elsif v_refusal = 'type' then
    raise exception 'this message type is not sent by an automation';
  elsif v_refusal = 'notice_template' then
    raise exception 'the system sends this template itself, not an automation';
  elsif v_refusal = 'collection' then
    raise exception 'collection messages need the payments right of the person who pressed';
  elsif v_refusal like 'feature:%' then
    raise exception 'collection messages are not in the plan';
  elsif v_refusal = 'not_sendable:inactive' then
    raise exception 'the email template is off';
  elsif v_refusal is not null then
    raise exception 'the email template cannot be sent';
  end if;
  select t.message_type into v_type from public.message_templates t where t.organization_id = v_org and t.id = p_template;

  -- one email per rule and record a business day (the business's zone), under a lock of the rule and record
  v_record_key := case when p_entity = 'lead' then 'lead_id' when p_entity = 'contact' then 'contact_id' else 'deal_id' end;
  perform pg_advisory_xact_lock(hashtextextended('automation_email:' || p_auto.id::text || ':' || p_id::text, 0));
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
  v_day_start := ((now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date)::timestamp at time zone coalesce(v_zone, 'Asia/Jerusalem');
  if exists (
    select 1 from app.jobs j
     where j.organization_id = v_org and j.kind = 'message.send' and j.payload ? 'automation_id' and j.created_at >= v_day_start
       and (j.payload ->> 'channel') = 'email'
       and (j.payload ->> 'automation_id') = p_auto.id::text
       and (j.payload ->> v_record_key) = p_id::text) then
    return 'an email was already sent today by this rule';
  end if;
  -- a run with a session counts in that person's 30 emails an hour (the card's lock, so the two cannot pass it together)
  if v_presser is not null then
    perform pg_advisory_xact_lock(hashtextextended('record_email:' || v_presser::text, 0));
    if app.automation_email_sent_last_hour(v_presser) >= app.record_email_hourly_limit() then
      return 'too many emails this hour by the person who pressed';
    end if;
  end if;

  perform app.enqueue_job(v_org, 'message.send',
    jsonb_build_object('channel', 'email', 'message_type', v_type, 'template_id', p_template, 'automation_id', p_auto.id)
      || case when v_presser is not null then jsonb_build_object('pressed_by_user_id', v_presser) else '{}'::jsonb end
      || case when p_entity = 'lead' then jsonb_build_object('lead_id', p_id) else jsonb_build_object('contact_id', v_contact) end
      || case when p_entity = 'deal' then jsonb_build_object('deal_id', p_id) else '{}'::jsonb end,
    null);
  return case when coalesce(app.customer_sending_paused(v_org), false) then 'customer sending is paused' end;
end;
$$;
revoke all on function app.automation_send_email(public.automations, text, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.run_automation_actions: the body of 20261006021202_sms_b_send.sql (the latest) with one change: the step send_email
-- (AUT-08) through app.automation_send_email, and its warning
-- ----------------------------------------------------------------------------
create or replace function app.run_automation_actions(p_auto public.automations, p_entity text, p_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := p_auto.organization_id;
  v_table text := app.automation_table(p_entity);
  v_record jsonb;
  v_action jsonb;
  v_type text;
  v_steps jsonb := '[]'::jsonb;
  v_name text;
  v_title text;
  v_user uuid;
  v_id uuid;
  v_due timestamptz;
  v_task_type text;
  v_count integer;
  v_kind public.lead_status_kind;
  v_reason text;
  v_warning text;
  v_warning_name text;
  v_kept uuid;
  v_zone text;
  v_local timestamp;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
  -- CAP-08 review: the team the route chose (a rule's team or the step's) and the owner before the step
  v_route_team uuid;
  v_prev_owner uuid;
  v_set_owner uuid;
  -- AUT-01: the field a set_field step writes
  v_field text;
  v_key text;
  v_value jsonb;
  v_def uuid;
  v_field_type text;
  v_options jsonb;
  v_read_only boolean;
  v_unique boolean;
  -- AUT-01 part B: a relative date
  v_relative boolean;
  v_date date;
  -- AUT-02: a create_deal step
  v_pipeline uuid;
  v_stage uuid;
  v_amount bigint;
  v_contact uuid;
  v_company uuid;
  v_hint text;
  v_note_lead uuid;
  v_note_deal uuid;
  -- DEAL-08 follow-up: a create_deal step that follows its source deal
  v_source public.deals;
  v_line public.deal_lines;
  v_skipped integer;
  v_claims text;
  v_claim_sub text;
  -- AUT-02 (rest): a create_quote step
  v_template public.quote_templates;
  v_tline public.quote_template_lines;
  v_day date;
  v_mode boolean;
  v_rate integer;
  v_list uuid;
  v_contact_list uuid;
  v_contact_co uuid;
  v_price bigint;
  v_p_price bigint;
  v_p_incl boolean;
  v_p_kind text;
  v_tier_price bigint;
  v_tier_bp integer;
  v_tier_incl boolean;
  v_source_kind text;
  v_list_used uuid;
  v_pos integer;
  -- AUT-02 follow-up: every warning of a create_quote step (the first is also 'warning')
  v_warnings text[];
begin
  for v_action in select * from jsonb_array_elements(p_auto.actions) loop
    v_type := v_action ->> 'type';
    v_record := app.automation_record(p_entity, v_org, p_id);
    v_name := app.automation_display_name(v_record);
    v_warning_name := null;
    begin
      if v_record is null then
        raise exception 'the record no longer exists';
      end if;

      if v_type = 'create_task' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'משימה'), '{{name}}', v_name), 300);
        v_due := null;
        v_warning := null;
        -- HEB-03: due in N business days (0..60), at the current local time of day
        if v_action ? 'due_in_business_days' then
          if jsonb_typeof(v_action -> 'due_in_business_days') = 'number'
             and (v_action ->> 'due_in_business_days')::numeric between 0 and 60
             and (v_action ->> 'due_in_business_days')::numeric = trunc((v_action ->> 'due_in_business_days')::numeric) then
            select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
            v_zone := coalesce(v_zone, 'Asia/Jerusalem');
            v_local := now() at time zone v_zone;
            v_due := (app.add_business_days(v_org, v_local::date, (v_action ->> 'due_in_business_days')::numeric::int) + v_local::time)
                     at time zone v_zone;
          else
            v_warning := 'the business-day offset is invalid';
          end if;
        end if;
        if v_due is null and (v_action ? 'due_in_minutes' or v_action ? 'due_in_days') then
          v_due := now()
            + make_interval(mins => coalesce((v_action ->> 'due_in_minutes')::int, 0))
            + make_interval(days => coalesce((v_action ->> 'due_in_days')::int, 0));
        end if;
        v_user := case when v_action ->> 'assign' = 'user'
                       then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                       else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
        v_task_type := case when v_action ->> 'task_type' in ('todo', 'call', 'meeting', 'follow_up')
                            then v_action ->> 'task_type' else 'todo' end;
        insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id, contact_id, company_id, deal_id)
        values (
          v_org, v_title, v_task_type, v_due, v_user,
          case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end,
          case when p_entity = 'contact' then p_id when p_entity in ('task', 'deal') then (v_record ->> 'contact_id')::uuid end,
          case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end,
          case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end);

      elsif v_type = 'notify' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'עדכון מאוטומציה'), '{{name}}', v_name), 200);
        if v_action ->> 'to' = 'admins' then
          insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
          select v_org, m.user_id, 'automation', v_title, p_entity, p_id
            from public.memberships m
           where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'admin');
          get diagnostics v_count = row_count;
        else
          v_user := case when v_action ->> 'to' = 'user'
                         then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                         else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
          v_count := 0;
          if v_user is not null then
            insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
            values (v_org, v_user, 'automation', v_title, p_entity, p_id);
            v_count := 1;
          end if;
        end if;
        if v_count = 0 then
          raise exception 'nobody to notify';
        end if;

      elsif v_type = 'assign_owner' then
        v_warning := null;
        if v_action ->> 'mode' = 'round_robin' then
          if (v_action ->> 'team_id') is not null and not exists (
            select 1 from public.teams t where t.organization_id = v_org and t.id = (v_action ->> 'team_id')::uuid) then
            raise exception 'the team no longer exists';
          end if;
          v_rule_user := null;
          if p_entity = 'lead' then
            -- CAP-08: the rules (source, requested product, language, list field; a team or one
            -- person), then the pick
            select p.owner_id, p.rule_user, p.team_id into v_user, v_rule_user, v_route_team
              from app.lead_distribution_route(v_org, (v_action ->> 'team_id')::uuid, now(),
                                               app.lead_routing_context(v_org, p_id), '{}'::uuid[]) p;
          else
            v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          end if;
          if v_rule_user is not null then
            -- a rule's person: the HEB-08 rule of a fixed person, as the "assign to a person" step
            -- the lead's team: the rule's person's by app.default_team()'s rule, else as it is
            v_id := app.member_default_team(v_org, v_rule_user);
            v_prev_owner := (v_record ->> 'owner_id')::uuid;
            v_set_owner := app.assign_lead_owner_auto(v_org, p_id, v_rule_user, coalesce(v_id, (v_record ->> 'team_id')::uuid));
            if v_set_owner is null then
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            -- set after the owner change (which applies default_team to the new owner, a deputy too),
            -- so the team is the person's whoever took the lead; only when the owner changed to the
            -- person or their deputy, or the lead had no owner before (review: a lead that stays with
            -- the owner it has keeps its team too)
            if v_id is not null
               and (v_prev_owner is null or (v_set_owner is not null and v_set_owner is distinct from v_prev_owner)) then
              update public.leads set team_id = v_id
               where organization_id = v_org and id = p_id and team_id is distinct from v_id;
            end if;
            v_user := null;
          elsif v_user is null then
            raise exception 'nobody is available';
          elsif p_entity = 'lead' then
            -- CAP-08 review: as intake does, the lead takes the team the route chose (a rule's team,
            -- else the step's), in the same statement as the owner, so default_team leaves it; no team
            -- chosen (the step names the whole business): the owner's default team, as before
            update public.leads
               set owner_id = v_user, team_id = coalesce(v_route_team, team_id)
             where organization_id = v_org and id = p_id;
            v_user := null;
          end if;
        else
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
          -- HEB-08: a lead goes through the one rule for automatic assignment of a fixed
          -- person (present: them; away: their deputy; away with none: no owner, and back to
          -- them on their return)
          if p_entity = 'lead' then
            v_warning := null;
            if app.assign_lead_owner_auto(v_org, p_id, v_user, (v_record ->> 'team_id')::uuid) is null then
              -- the lead keeps the owner it has (owner, 14 October 2026): say who it stays with
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            -- assigned (or left unowned) above
            v_user := null;
          end if;
        end if;
        if v_user is not null then
          execute format('update public.%I set owner_id = $1 where organization_id = $2 and id = $3', v_table)
            using v_user, v_org, p_id;
        end if;

      elsif v_type = 'add_tag' then
        if p_entity = 'task' then
          raise exception 'tasks have no tags';
        end if;
        select t.id into v_id from public.tags t where t.organization_id = v_org and t.id = (v_action ->> 'tag_id')::uuid;
        if v_id is null then
          raise exception 'the tag no longer exists';
        end if;
        execute format(
          'update public.%I set tag_ids = case when $1 = any (tag_ids) then tag_ids else array_append(tag_ids, $1) end
            where organization_id = $2 and id = $3', v_table)
          using v_id, v_org, p_id;

      elsif v_type = 'set_lead_status' then
        if p_entity <> 'lead' then
          raise exception 'only for leads';
        end if;
        select s.id, s.kind into v_id, v_kind from public.lead_statuses s
         where s.organization_id = v_org and s.id = (v_action ->> 'status_id')::uuid and s.kind <> 'converted';
        if v_id is null then
          raise exception 'the status no longer exists';
        end if;
        v_warning := null;
        if v_kind = 'disqualified' then
          -- the reason is kept by id and read by name now, so a renamed reason still works;
          -- only an active reason of this organization counts (a hidden, deleted or foreign id does not)
          v_reason := null;
          -- absent, null, empty or blank: no reason was set (an old rule); anything else is looked up
          if nullif(btrim(v_action ->> 'reason_id'), '') is null then
            v_warning := 'no reason is set';
          else
            select r.name into v_reason from public.disqualify_reasons r
             where r.organization_id = v_org and r.is_active
               and r.id::text = (v_action ->> 'reason_id');
            if v_reason is null then
              v_warning := 'the reason no longer exists';
            end if;
          end if;
          -- status and reason in one update: leads_disqualify_reason keeps a reason a server write sets
          -- together with the move, and clears the old one when none is given
          if v_reason is not null then
            update public.leads set status_id = v_id, disqualify_reason = v_reason where organization_id = v_org and id = p_id;
          else
            update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
          end if;
        else
          update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
        end if;

      elsif v_type = 'move_deal_stage' then
        if p_entity <> 'deal' then
          raise exception 'only for deals';
        end if;
        select s.id into v_id from public.stages s
         where s.organization_id = v_org and s.id = (v_action ->> 'stage_id')::uuid
           and s.pipeline_id = (v_record ->> 'pipeline_id')::uuid;
        if v_id is null then
          raise exception 'the stage is not in this deal''s pipeline';
        end if;
        update public.deals set stage_id = v_id where organization_id = v_org and id = p_id;

      elsif v_type = 'set_field' then
        -- AUT-01: one field of the record: a custom field ("cf:<key>", any type, checked as a person's
        -- write is) or a built-in field (source_id on leads, contacts and deals; task_type on tasks; part B, owner
        -- 18 October 2026: preferred_channel and preferred_locale on leads and contacts, expected_close_date on deals;
        -- never a name or a phone: an automation does not rewrite identity).
        -- An absent or null value clears the field (task_type cannot be empty).
        -- Part B: a date field (expected_close_date, a date or datetime custom field) may take a relative date
        -- {"relative": {"days": 0..365, "unit": "calendar" | "business"}}, worked out when the step runs (an AUT-06 retry
        -- works it out again at its own time) from today in the business's zone (business days by app.add_business_days;
        -- 0 = today, or the next working day). An invalid one leaves the field as it is: the step is ok with a warning.
        v_warning := null;
        v_field := v_action ->> 'field';
        v_value := case when jsonb_typeof(v_action -> 'value') is distinct from 'null' then v_action -> 'value' end;
        v_relative := jsonb_typeof(v_value) = 'object' and v_value ? 'relative';
        if v_field like 'cf:%' then
          if p_entity not in ('lead', 'contact', 'company', 'deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_key := substr(v_field, 4);
          v_def := null;
          select f.id, f.field_type, f.options, f.is_read_only, f.is_unique
            into v_def, v_field_type, v_options, v_read_only, v_unique
            from public.field_definitions f
           where f.organization_id = v_org and f.object_type = p_entity and f.key = v_key and f.is_active;
          if v_def is null then
            raise exception 'the field no longer exists';
          end if;
          -- part B: a relative date becomes the field's own value (a datetime keeps the current local time, to the minute)
          if v_relative then
            if v_field_type not in ('date', 'datetime') then
              raise exception 'the value does not fit the field';
            end if;
            v_date := app.automation_relative_date(v_org, v_value -> 'relative');
            if v_date is null then
              v_warning := 'the relative date is invalid';
            elsif v_field_type = 'date' then
              v_value := to_jsonb(to_char(v_date, 'YYYY-MM-DD'));
            else
              select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
              v_zone := coalesce(v_zone, 'Asia/Jerusalem');
              v_local := date_trunc('minute', now() at time zone v_zone);
              v_value := to_jsonb(to_char(((v_date + v_local::time) at time zone v_zone) at time zone 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
            end if;
          end if;
          if v_warning is null then
          if not app.custom_value_ok(v_field_type, v_options, v_value) then
            raise exception 'the value does not fit the field';
          end if;
          -- a "user" field holds a member of the record's organization (as app.check_custom_fields)
          if v_field_type = 'user' and v_value is not null and not exists (
            select 1 from public.memberships m
             where m.organization_id = v_org and m.user_id = (v_value #>> '{}')::uuid) then
            raise exception 'the value does not fit the field';
          end if;
          -- FLD-07: a filled read-only value stays (an empty one may be filled once)
          if v_read_only and not app.custom_value_empty(v_record -> 'custom_fields' -> v_key)
             and (v_record -> 'custom_fields' -> v_key) is distinct from v_value then
            raise exception 'the field is read-only';
          end if;
          -- FLD-07: a unique field is judged now, inside this step, as intake_submit does, so a taken
          -- value fails the step instead of the whole run at commit
          begin
            if v_unique then
              set constraints app.custom_unique_values_value immediate;
            end if;
            execute format(
              'update public.%I
                  set custom_fields = case when $1 is null then coalesce(custom_fields, ''{}''::jsonb) - $2
                                           else coalesce(custom_fields, ''{}''::jsonb) || jsonb_build_object($2, $1) end
                where organization_id = $3 and id = $4', v_table)
              using v_value, v_key, v_org, p_id;
            if v_unique then
              set constraints app.custom_unique_values_value deferred;
            end if;
          exception when unique_violation then
            -- (the rollback of this block restores the mode too; said again for clarity)
            set constraints app.custom_unique_values_value deferred;
            raise exception 'the value is already on another record';
          end;
          end if;
        elsif v_field = 'source_id' then
          if p_entity not in ('lead', 'contact', 'deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_id := null;
          if v_value is not null then
            select s.id into v_id from public.lead_sources s
             where s.organization_id = v_org and s.id::text = (v_value #>> '{}') and s.is_active;
            if v_id is null then
              raise exception 'the source no longer exists';
            end if;
          end if;
          -- SEG-02 / DQL-04 (owner, 26 October 2026, answer 3): on a lead or a contact an automation only fills an empty
          -- first source (source, campaign and UTM all empty); otherwise the step is ok with a warning and nothing changes
          if (p_entity = 'lead' and exists (
                select 1 from public.leads l
                 where l.organization_id = v_org and l.id = p_id and not app.first_source_empty(l.source_id, l.campaign, l.utm)))
             or (p_entity = 'contact' and exists (
                select 1 from public.contacts c
                 where c.organization_id = v_org and c.id = p_id and not app.first_source_empty(c.source_id, c.campaign, c.utm))) then
            v_warning := 'the first source is already set';
          else
            execute format('update public.%I set source_id = $1 where organization_id = $2 and id = $3', v_table)
              using v_id, v_org, p_id;
          end if;
        elsif v_field = 'task_type' then
          if p_entity not in ('task') then
            raise exception 'the field does not fit this record';
          end if;
          if v_value is null or (v_value #>> '{}') not in ('todo', 'call', 'meeting', 'follow_up') then
            raise exception 'the value does not fit the field';
          end if;
          update public.tasks set task_type = (v_value #>> '{}') where organization_id = v_org and id = p_id;
        elsif v_field = 'preferred_channel' then
          if p_entity not in ('lead', 'contact') then
            raise exception 'the field does not fit this record';
          end if;
          -- the CON-10 list (contacts_preferred_channel_check, leads_preferred_channel_check; CONTACT_CHANNELS)
          if v_value is not null and (jsonb_typeof(v_value) <> 'string'
             or (v_value #>> '{}') <> all (array['phone', 'whatsapp', 'email', 'sms'])) then
            raise exception 'the value does not fit the field';
          end if;
          -- the source (owner, 26 October 2026): a record that has one keeps it (option ג: form stays form, manual stays
          -- manual); a new channel on a record with no source makes it 'form' (answer ב), so a later public form may replace
          -- it; writing the channel the record already has changes nothing; clearing clears it (app.preferred_channel_source
          -- leaves a server write's source as given, empties it with the channel). The right-hand side reads the old row.
          execute format(
            'update public.%I set preferred_channel = $1,'
            ' preferred_channel_source = case when $1 is not null and preferred_channel_source is null'
            ' and preferred_channel is distinct from $1 then ''form'' else preferred_channel_source end'
            ' where organization_id = $2 and id = $3', v_table)
            using v_value #>> '{}', v_org, p_id;
        elsif v_field = 'preferred_locale' then
          if p_entity not in ('lead', 'contact') then
            raise exception 'the field does not fit this record';
          end if;
          -- the CON-10 list (contacts_preferred_locale_check, leads_preferred_locale_check; CONTACT_LOCALES)
          if v_value is not null and (jsonb_typeof(v_value) <> 'string'
             or (v_value #>> '{}') <> all (array['he', 'ar', 'en', 'ru', 'am', 'fr', 'es'])) then
            raise exception 'the value does not fit the field';
          end if;
          execute format('update public.%I set preferred_locale = $1 where organization_id = $2 and id = $3', v_table)
            using v_value #>> '{}', v_org, p_id;
        elsif v_field = 'expected_close_date' then
          if p_entity not in ('deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_date := null;
          if v_relative then
            v_date := app.automation_relative_date(v_org, v_value -> 'relative');
            if v_date is null then
              v_warning := 'the relative date is invalid';
            end if;
          elsif v_value is not null then
            if jsonb_typeof(v_value) <> 'string' or not app.custom_value_ok('date', '[]'::jsonb, v_value) then
              raise exception 'the value does not fit the field';
            end if;
            v_date := (v_value #>> '{}')::date;
          end if;
          if v_warning is null then
            update public.deals set expected_close_date = v_date where organization_id = v_org and id = p_id;
          end if;
        else
          raise exception 'the field does not fit this record';
        end if;

      elsif v_type = 'create_deal' then
        -- AUT-02: a new deal for the record's customer. A contact gives itself and its company, a company itself, a
        -- deal or a task its contact and company (a link to a record in the recycle bin is left out). A lead becomes
        -- a deal by conversion, not here. A deal made from a deal names it as the previous deal (DEAL-11).
        v_warning := null;
        if p_entity not in ('contact', 'company', 'deal', 'task') then
          raise exception 'a lead becomes a deal by conversion';
        end if;
        v_pipeline := null;
        v_stage := null;
        v_source := null;
        if p_entity = 'deal' then
          select d.* into v_source from public.deals d where d.organization_id = v_org and d.id = p_id;
        end if;
        -- DEAL-08 follow-up: "pipeline": "source" = the triggering deal's sales process, in its first open stage; when the
        -- trigger is not a deal, or that process is gone or has no open stage, the step's own pipeline_id rule below
        if v_action ->> 'pipeline' = 'source' and v_source.id is not null then
          select s.pipeline_id, s.id into v_pipeline, v_stage
            from public.stages s
            join public.pipelines p on p.organization_id = s.organization_id and p.id = s.pipeline_id
           where s.organization_id = v_org and s.pipeline_id = v_source.pipeline_id and s.kind = 'open' and p.deleted_at is null
           order by s.position, s.created_at, s.id
           limit 1;
        end if;
        if v_pipeline is null then
        select p.id into v_pipeline from public.pipelines p
         where p.organization_id = v_org and p.id::text = (v_action ->> 'pipeline_id') and p.deleted_at is null;
        if v_pipeline is null then
          raise exception 'the pipeline no longer exists';
        end if;
        v_stage := null;
        if nullif(btrim(v_action ->> 'stage_id'), '') is not null then
          select s.id into v_stage from public.stages s
           where s.organization_id = v_org and s.pipeline_id = v_pipeline and s.id::text = (v_action ->> 'stage_id')
             and s.kind = 'open';
          if v_stage is null then
            raise exception 'the stage is not an open stage of the pipeline';
          end if;
        else
          -- no stage chosen: the pipeline's first open stage
          select s.id into v_stage from public.stages s
           where s.organization_id = v_org and s.pipeline_id = v_pipeline and s.kind = 'open'
           order by s.position, s.created_at, s.id
           limit 1;
          if v_stage is null then
            raise exception 'the pipeline has no open stage';
          end if;
        end if;
        end if;
        -- the value in agorot: a whole number from 0 to 100,000,000,000 (a billion shekels); absent or null = empty
        v_amount := 0;
        if jsonb_typeof(v_action -> 'amount_agorot') is not null and jsonb_typeof(v_action -> 'amount_agorot') <> 'null' then
          if jsonb_typeof(v_action -> 'amount_agorot') <> 'number'
             or (v_action ->> 'amount_agorot')::numeric < 0
             or (v_action ->> 'amount_agorot')::numeric > 100000000000
             or (v_action ->> 'amount_agorot')::numeric <> trunc((v_action ->> 'amount_agorot')::numeric) then
            raise exception 'the amount is invalid';
          end if;
          v_amount := (v_action ->> 'amount_agorot')::numeric::bigint;
        end if;
        v_title := left(btrim(replace(coalesce(nullif(btrim(v_action ->> 'name'), ''), 'עסקה: {{name}}'), '{{name}}', v_name)), 200);
        if v_title = '' then
          v_title := 'עסקה';
        end if;
        if v_action ->> 'assign' = 'user' then
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
        else
          v_user := app.automation_member(v_org, (v_record ->> 'owner_id')::uuid);
        end if;
        v_contact := case when p_entity = 'contact' then p_id
                          when p_entity in ('deal', 'task') then (v_record ->> 'contact_id')::uuid end;
        v_company := case when p_entity = 'company' then p_id else (v_record ->> 'company_id')::uuid end;
        if v_contact is not null and not exists (
          select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null) then
          v_contact := null;
        end if;
        if v_company is not null and not exists (
          select 1 from public.companies c where c.organization_id = v_org and c.id = v_company and c.deleted_at is null) then
          v_company := null;
        end if;
        -- DEAL-08 follow-up: "copy_from_source": true (deal triggers only) copies the source deal's recurring revenue. A
        -- recurring amount that followed the source's lines is left empty, so the copied lines fill it again (DLI-03);
        -- a typed one is copied as typed. The value follows the lines unless the step names an amount.
        if not (coalesce(v_action -> 'copy_from_source', 'false'::jsonb) = 'true'::jsonb and v_source.id is not null) then
          v_source := null;
        end if;
        begin
          insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot, owner_id, contact_id, company_id,
                                    previous_deal_id, billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date)
          values (v_org, v_title, v_pipeline, v_stage, v_amount, v_user, v_contact, v_company,
                  case when p_entity = 'deal' then p_id end,
                  v_source.billing_kind,
                  case when v_source.billing_kind is not null and v_source.recurring_amount_auto is not true then v_source.recurring_amount_agorot end,
                  -- the next period: it starts on the source's renewal date and renews after the same term; never
                  -- the source's own renewal date, or a date rule on it would renew the copy again
                  case when v_source.billing_kind is not null then coalesce(v_source.renewal_date, v_source.recurring_start_date) end,
                  -- the term in whole months: the source's term rounded to the nearest month (15 days or more count as a
                  -- month), at least one, so a month end stays a month end (Postgres clamps the day)
                  case when v_source.billing_kind is not null and v_source.renewal_date > v_source.recurring_start_date
                       then (v_source.renewal_date + make_interval(months => greatest(1, (
                              extract(year from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp)) * 12
                              + extract(month from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp))
                              + case when extract(day from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp)) >= 15
                                     then 1 else 0 end)::integer)))::date end)
          returning id into v_id;
        exception when sqlstate 'P0001' then
          get stacked diagnostics v_hint = pg_exception_hint;
          if v_hint = 'limit:max_records' then
            raise exception 'the plan record limit is reached';
          end if;
          raise;
        end;
        -- the source deal's lines, as they are (the deal_lines triggers judge each one; the run already marks its writes
        -- as an automation's, so nothing re-fires). A line the rules no longer let in (a product a person may not offer
        -- any more, a plan without products or discounts) is left out and the step says so; a line whose price list was
        -- removed keeps its price as a manual one.
        if v_source.id is not null then
          v_skipped := 0;
          -- the lines are copied as the server, the same whether the rule runs on its own or a person runs it now:
          -- with the person's session, deal_lines_check would skip every rule for a deal that person may not edit.
          -- The session is put back after the loop and on any error that leaves it.
          v_claims := current_setting('request.jwt.claims', true);
          v_claim_sub := current_setting('request.jwt.claim.sub', true);
          if v_claims is not null then
            perform set_config('request.jwt.claims', '', true);
          end if;
          if v_claim_sub is not null then
            perform set_config('request.jwt.claim.sub', '', true);
          end if;
          begin
          for v_line in
            select l.* from public.deal_lines l
             where l.organization_id = v_org and l.deal_id = v_source.id
             order by l.position, l.created_at, l.id
          loop
            begin
              insert into public.deal_lines (organization_id, deal_id, position, product_id, description, quantity, unit_price_agorot,
                                             discount_bp, discount_agorot, price_includes_vat, vat_exempt, price_source, price_list_id,
                                             billing, currency)
              values (v_org, v_id, v_line.position, v_line.product_id, v_line.description, v_line.quantity, v_line.unit_price_agorot,
                      v_line.discount_bp, v_line.discount_agorot, v_line.price_includes_vat, v_line.vat_exempt,
                      case when v_line.price_source = 'price_list' and v_line.price_list_id is null then 'manual' else v_line.price_source end,
                      v_line.price_list_id, v_line.billing, v_line.currency);
            exception when raise_exception or integrity_constraint_violation or insufficient_privilege then
              v_skipped := v_skipped + 1;
            end;
          end loop;
          exception when others then
            if v_claims is not null then
              perform set_config('request.jwt.claims', v_claims, true);
            end if;
            if v_claim_sub is not null then
              perform set_config('request.jwt.claim.sub', v_claim_sub, true);
            end if;
            raise;
          end;
          if v_claims is not null then
            perform set_config('request.jwt.claims', v_claims, true);
          end if;
          if v_claim_sub is not null then
            perform set_config('request.jwt.claim.sub', v_claim_sub, true);
          end if;
          if v_skipped > 0 then
            v_warning := 'some lines were not copied';
          end if;
        end if;

      elsif v_type = 'create_note' then
        -- AUT-02: a note on the record's timeline (a task's note goes on the records the task is linked to). It is
        -- an 'automation_note', not a person's 'note': it is not contact with the customer (last contact, response
        -- time, activation, lead score) and does not count as activity for a "no activity" rule.
        v_title := left(btrim(replace(coalesce(v_action ->> 'body', ''), '{{name}}', v_name)), 2000);
        if v_title = '' then
          raise exception 'the note is empty';
        end if;
        -- the records the note goes on: the record itself, or a task's links that are not in the recycle bin
        v_note_lead := case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end;
        v_contact := case when p_entity = 'contact' then p_id when p_entity = 'task' then (v_record ->> 'contact_id')::uuid end;
        v_company := case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end;
        v_note_deal := case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end;
        if p_entity = 'task' then
          if v_note_lead is not null and not exists (
            select 1 from public.leads l where l.organization_id = v_org and l.id = v_note_lead and l.deleted_at is null) then
            v_note_lead := null;
          end if;
          if v_contact is not null and not exists (
            select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null) then
            v_contact := null;
          end if;
          if v_company is not null and not exists (
            select 1 from public.companies c where c.organization_id = v_org and c.id = v_company and c.deleted_at is null) then
            v_company := null;
          end if;
          if v_note_deal is not null and not exists (
            select 1 from public.deals d where d.organization_id = v_org and d.id = v_note_deal and d.deleted_at is null) then
            v_note_deal := null;
          end if;
          if num_nonnulls(v_note_lead, v_contact, v_company, v_note_deal) = 0 then
            raise exception 'the task is not linked to a record';
          end if;
        end if;
        -- written by the automation, not by a person: no author (the trigger activities_zz_automation_note clears it
        -- after touch_row, which would set the person who ran the rule by hand)
        insert into public.activities (organization_id, type, body, metadata, lead_id, contact_id, company_id, deal_id, created_by)
        values (
          v_org, 'automation_note', v_title,
          jsonb_build_object('automation_id', p_auto.id, 'automation_name', left(p_auto.name, 80)),
          v_note_lead, v_contact, v_company, v_note_deal, null);

      elsif v_type = 'create_quote' then
        -- AUT-02 (rest): a draft quote from a quote template (QUO-04), on the deal or the contact the rule runs on. The
        -- template is read by its id within the rule's business only. The quote is a draft: never sent, no number.
        -- It is written as the server (the session is put aside, as for a create_deal step's copied lines), so a person
        -- who runs the rule by hand gets the same quote as the rule on its own; the VAT mode is the template's (else the
        -- business's). The owner (owner's answer of 26 October 2026, (ב)): the record's owner while an active member who
        -- is not a viewer; else the step's optional owner_id while usable (a fallback); else no owner and the warning
        -- 'the record owner is not usable, the quote has no owner'.
        v_warning := null;
        v_warnings := '{}'::text[];
        if p_entity not in ('deal', 'contact') then
          raise exception 'a quote is made on a deal or a contact';
        end if;
        if (v_record ->> 'deleted_at') is not null then
          raise exception 'the record is in the recycle bin';
        end if;
        if not app.org_has_feature(v_org, 'quotes') then
          raise exception 'quotes are not in the plan';
        end if;
        select t.* into v_template from public.quote_templates t
         where t.organization_id = v_org and t.id::text = (v_action ->> 'template_id');
        if not found then
          raise exception 'the quote template no longer exists';
        end if;
        -- the record's owner first (they know the customer)
        v_user := app.automation_member(v_org, (v_record ->> 'owner_id')::uuid);
        -- the step's chosen owner only when the record's owner is not usable
        if v_user is null and (v_action ->> 'owner_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_user := app.automation_member(v_org, (v_action ->> 'owner_id')::uuid);
        end if;
        -- neither is usable (a chosen owner who is not usable is noted only then, by this same warning)
        if v_user is null then
          v_warnings := v_warnings || 'the record owner is not usable, the quote has no owner'::text;
        end if;
        -- the quote's date as quotes_check sets it (the business's today), valid for 30 days (DEFAULT_VALID_DAYS)
        select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_day
          from public.organizations o where o.id = v_org;
        -- a template with item lines brings its VAT mode (its typed prices are written in it), as applyTemplateToQuote
        v_mode := case when exists (select 1 from public.quote_template_lines tl
                                     where tl.organization_id = v_org and tl.template_id = v_template.id and tl.kind = 'item')
                       then v_template.prices_include_vat
                       else coalesce((select s.prices_include_vat from public.org_document_settings s where s.organization_id = v_org), false) end;
        v_title := btrim(v_name);
        v_title := case when v_title = '' then 'הצעת מחיר' else rtrim(left('הצעת מחיר: ' || v_title, 200)) end;
        v_skipped := 0;
        v_claims := current_setting('request.jwt.claims', true);
        v_claim_sub := current_setting('request.jwt.claim.sub', true);
        if v_claims is not null then
          perform set_config('request.jwt.claims', '', true);
        end if;
        if v_claim_sub is not null then
          perform set_config('request.jwt.claim.sub', '', true);
        end if;
        begin
          -- quotes_check fills a deal's contact and company, or a contact's company
          insert into public.quotes (organization_id, title, deal_id, contact_id, owner_id, valid_until, prices_include_vat, notes, terms)
          values (v_org, v_title,
                  case when p_entity = 'deal' then p_id end,
                  case when p_entity = 'contact' then p_id end,
                  v_user, v_day + 30, v_mode, v_template.notes, v_template.terms)
          returning id, contact_id, company_id into v_id, v_contact, v_company;

          -- PL-03, as the app prices a product line saved without a price (src/features/quotes/template-server.ts): the
          -- customer's price list (plan flag price_lists): the first that is active and valid today of the quote contact's
          -- own list, that contact's company's, the quote's company's; within it the product's tier with the largest
          -- min_quantity not above the line's quantity; then into the quote's VAT mode at the conversion rate
          -- (app.product_line_price, app.price_list_discounted: the SQL mirrors of RVW-27)
          v_list := null;
          if app.org_has_feature(v_org, 'price_lists') then
            v_contact_list := null;
            v_contact_co := null;
            if v_contact is not null then
              select c.price_list_id, c.company_id into v_contact_list, v_contact_co
                from public.contacts c where c.organization_id = v_org and c.id = v_contact;
            end if;
            select l.id into v_list
              from (values (1, v_contact_list),
                           (2, (select co.price_list_id from public.companies co where co.organization_id = v_org and co.id = v_contact_co)),
                           (3, (select co.price_list_id from public.companies co where co.organization_id = v_org and co.id = v_company)))
                   as o(n, list_id)
              join public.price_lists l on l.organization_id = v_org and l.id = o.list_id
             where l.is_active
               and (l.valid_from is null or l.valid_from <= v_day)
               and (l.valid_to is null or l.valid_to >= v_day)
             order by o.n
             limit 1;
          end if;
          v_rate := 0;
          if app.org_charges_vat(v_org) is distinct from false then
            v_rate := coalesce(app.vat_rate_at(v_day), 0);
          end if;

          v_pos := 0;
          for v_tline in
            select tl.* from public.quote_template_lines tl
             where tl.organization_id = v_org and tl.template_id = v_template.id
             order by tl.position, tl.created_at, tl.id
          loop
            v_price := v_tline.unit_price_agorot;
            v_source_kind := 'manual';
            v_list_used := null;
            if v_tline.kind = 'item' and v_tline.product_id is not null then
              -- only a product that may still be offered (quote_lines_check judges this for a person only)
              select p.price_agorot, p.vat_kind = 'taxable' and p.price_includes_vat, p.vat_kind
                into v_p_price, v_p_incl, v_p_kind
                from public.products p
               where p.organization_id = v_org and p.id = v_tline.product_id and p.is_active and p.archived_at is null;
              if not found then
                v_skipped := v_skipped + 1;
                continue;
              end if;
              if v_price is null then
                v_source_kind := 'product';
                v_tier_price := null;
                v_tier_bp := null;
                v_tier_incl := null;
                if v_list is not null then
                  select t.price_agorot, t.discount_bp, t.price_includes_vat into v_tier_price, v_tier_bp, v_tier_incl
                    from public.price_list_lines t
                   where t.organization_id = v_org and t.price_list_id = v_list and t.product_id = v_tline.product_id
                     and t.min_quantity <= v_tline.quantity
                   order by t.min_quantity desc, t.id
                   limit 1;
                  if v_tier_price is not null then
                    v_p_price := v_tier_price;
                    v_p_incl := v_p_kind = 'taxable' and v_tier_incl;
                    v_source_kind := 'price_list';
                    v_list_used := v_list;
                  elsif v_tier_bp is not null then
                    v_p_price := app.price_list_discounted(v_p_price, v_tier_bp);
                    v_source_kind := 'price_list';
                    v_list_used := v_list;
                  end if;
                end if;
                v_price := app.product_line_price(v_p_price, v_p_incl, v_p_kind, v_mode, v_rate);
              end if;
            elsif v_tline.kind = 'group' then
              v_price := 0;
            end if;
            v_pos := v_pos + 1;
            begin
              insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                              unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                              optional_selected, price_source, price_list_id)
              values (v_org, v_id, v_pos, v_tline.kind, v_tline.product_id, v_tline.name, v_tline.description, v_tline.quantity,
                      v_price, v_tline.discount_bp, v_tline.discount_agorot, v_tline.vat_exempt, v_tline.billing, v_tline.is_optional,
                      v_tline.optional_selected, v_source_kind, v_list_used);
            exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
              -- the rules refuse this line today (a plan flag: products, discounts; a constraint): leave it out and count it,
              -- like quote_duplicate. Anything else fails the step, and the quote with it.
              v_skipped := v_skipped + 1;
              v_pos := v_pos - 1;
            end;
          end loop;
        exception when others then
          if v_claims is not null then
            perform set_config('request.jwt.claims', v_claims, true);
          end if;
          if v_claim_sub is not null then
            perform set_config('request.jwt.claim.sub', v_claim_sub, true);
          end if;
          raise;
        end;
        if v_claims is not null then
          perform set_config('request.jwt.claims', v_claims, true);
        end if;
        if v_claim_sub is not null then
          perform set_config('request.jwt.claim.sub', v_claim_sub, true);
        end if;
        if v_skipped > 0 then
          v_warnings := v_warnings || 'some template lines were skipped'::text;
        end if;
        -- COL-05 (owner's answer of 26 October 2026): a customer on hold still gets the quote, with a warning. The rule of
        -- the app's warning at quote creation (CustomerHoldWarning): only with the plan's 'collection' flag; the quote's
        -- contact and its company (quotes_check filled them: the deal's contact and company, else the contact's company);
        -- an active hold (not cleared) on either. The contact's own hold first.
        if app.org_has_feature(v_org, 'collection') then
          if v_contact is not null and exists (
            select 1 from public.customer_holds h
             where h.organization_id = v_org and h.contact_id = v_contact and h.cleared_at is null) then
            v_warnings := v_warnings || 'the customer is on hold'::text;
          end if;
          if v_company is not null and exists (
            select 1 from public.customer_holds h
             where h.organization_id = v_org and h.company_id = v_company and h.cleared_at is null) then
            v_warnings := v_warnings || 'the customer''s company is on hold'::text;
          end if;
        end if;
        v_warning := v_warnings[1];

      elsif v_type = 'send_sms' then
        -- SMS-02: one SMS of the business's template to the record (a deal: its live contact), an OPS-04 message.send job
        -- judged by the queue's own checks (consent for marketing, HEB-09, hours, caps); while the pause holds it waits
        -- null, or the warning: 'customer sending is paused' / 'an SMS was already sent today by this rule' (review F4)
        v_warning := app.automation_send_sms(p_auto, p_entity, p_id,
             case when (v_action ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (v_action ->> 'template_id')::uuid end);

      elsif v_type = 'send_email' then
        -- AUT-08: one email of the business's template to the record (a deal: its live contact), an OPS-04 message.send job
        -- judged by the queue's own checks; null, or the warning: 'customer sending is paused' / 'an email was already sent
        -- today by this rule' / 'too many emails this hour by the person who pressed'
        v_warning := app.automation_send_email(p_auto, p_entity, p_id,
             case when (v_action ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (v_action ->> 'template_id')::uuid end);

      else
        raise exception 'unknown action %', coalesce(v_type, '(none)');
      end if;

      v_steps := v_steps || jsonb_build_array(
        jsonb_build_object('action', v_type, 'status', 'ok')
        || case when v_type in ('set_lead_status', 'create_task', 'assign_owner', 'create_deal', 'set_field', 'create_quote', 'send_sms', 'send_email') and v_warning is not null
                then jsonb_build_object('warning', v_warning) else '{}'::jsonb end
        || case when v_type = 'create_quote' and v_skipped > 0
                then jsonb_build_object('warning_count', v_skipped) else '{}'::jsonb end
        || case when v_type = 'create_quote' and v_warning is not null
                then jsonb_build_object('warnings', to_jsonb(v_warnings)) else '{}'::jsonb end
        || case when v_type = 'assign_owner' and v_warning is not null and v_warning_name is not null
                then jsonb_build_object('warning_name', v_warning_name) else '{}'::jsonb end);
    exception when others then
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('action', v_type, 'status', 'error', 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return v_steps;
end;
$$;
revoke all on function app.run_automation_actions(public.automations, text, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- A collection SMS or email step is saved only by a payment recorder (021202's body; AUT-08 adds send_email)
-- ----------------------------------------------------------------------------
-- A rule that runs without a session sends on the plan keys alone, so the person who saves a send_sms or send_email step of
-- a COLLECTION template must hold app.can_record_payments (hints automation:sms_collection / automation:email_collection).
-- Invoker: a person's insert or update of `actions` only (current_user = 'authenticated'); outsiders go to RLS first; the
-- template is read under the writer's RLS. An update is judged only on collection steps it adds. A button run is still judged
-- by the presser at run time (app.automation_send_sms / app.automation_send_email).
create or replace function app.automations_sms_collection_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_kind text;
  v_new uuid[];
  v_old uuid[];
begin
  if current_user <> 'authenticated' or not coalesce(app.is_member(new.organization_id), false) then
    return new;
  end if;
  foreach v_kind in array array['send_sms', 'send_email'] loop
    v_old := '{}';
    select array_agg((a ->> 'template_id')::uuid) into v_new
      from jsonb_array_elements(case when jsonb_typeof(new.actions) = 'array' then new.actions else '[]'::jsonb end) a
     where a ->> 'type' = v_kind
       and (a ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    continue when v_new is null;
    if tg_op = 'UPDATE' then
      select coalesce(array_agg((a ->> 'template_id')::uuid), '{}') into v_old
        from jsonb_array_elements(case when jsonb_typeof(old.actions) = 'array' then old.actions else '[]'::jsonb end) a
       where a ->> 'type' = v_kind
         and (a ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    end if;
    if exists (select 1 from public.message_templates t
                where t.organization_id = new.organization_id and t.id = any (v_new) and not (t.id = any (v_old))
                  and t.message_type = 'collection')
       and not coalesce(app.can_record_payments(new.organization_id), false) then
      if v_kind = 'send_sms' then
        raise exception 'a collection SMS step needs the payments right' using errcode = 'P0001', hint = 'automation:sms_collection';
      end if;
      raise exception 'a collection email step needs the payments right' using errcode = 'P0001', hint = 'automation:email_collection';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function app.automations_sms_collection_check() from public, anon, authenticated;
grant execute on function app.automations_sms_collection_check() to authenticated;
