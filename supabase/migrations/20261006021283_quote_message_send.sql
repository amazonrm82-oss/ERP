-- QUO-18, first part (owner's answer (89) א, 3 November 2026, docs/DECISIONS.md; QUOTE_SERVICE_CONDITIONS in
-- src/features/message-templates/templates.ts): a person who may send a quote (the rule of its link, QUO-08:
-- app.quote_editable, the `quotes` key, a member who may write in a writable business) sends a SENT or VIEWED quote that is
-- still on offer (not past its validity in the business's zone, its customer not deleted) and is its chain's newest sent
-- version (app.quote_shown_version), to the quote's own customer, by email or SMS, from an active message template of type
-- requested_document of that channel. A quote is a SERVICE message: it is never sent to a group or a segment, only to the
-- customer address on the quote (the contact the quote names, never a deal's current one; its CURRENT email / phone_e164),
-- and the blocklist and a privacy erasure stop it (app.consent_service_blocked, the queue's and the composer's rule).
--
-- * public.quote_message_send(org, quote, channel, template) (invoker: the quote read under the caller's RLS) hands over to
--   app.quote_message_enqueue (definer, granted to authenticated for that wrapper; it re-checks everything itself, the card
--   pattern of app.record_email_enqueue / app.record_sms_enqueue): the same hourly cap per person as a card send (30 emails,
--   30 SMS, counted through reply_to_user_id / sent_by_user_id), the `sms` key for SMS, and a template whose every merge field
--   a quote send fills: the card's fields (app.card_message_fields()) plus app.quote_message_fields() ({מסמך}, {קישור להצעה},
--   {תוקף}); a template holding {תוקף} needs the quote's valid_until (hint quote_message:no_validity). The card's own rule is
--   unchanged: a card still never offers or queues such a template (record_message:unfillable_field).
-- * The job is an OPS-04 message.send with ids only: channel, message_type 'requested_document', template_id, quote_id,
--   contact_id and the person (reply_to_user_id on email, sent_by_user_id on SMS). app.job_payload_ok (021281's body) takes
--   `quote_id` only on a requested_document to a contact, by email or SMS, without files, rule, button or other subject. No
--   deal_id is carried: the composer judges the customer through the quote, not through the deal.
-- * The composers app.email_compose_core and app.sms_compose_core (021279's bodies) gain one branch: a requested_document
--   with quote_id re-reads the quote (scoped to the job's business, FOR KEY SHARE) and asks app.quote_message_refusal (the one
--   rule; it answers feature_off | quote_changed | customer_changed | pages_closed | unsupported); {מסמך} is "הצעת מחיר
--   <number>", {תוקף} the last day in Hebrew, and {קישור להצעה} is minted LAST by app.quote_message_link_issue. A message without
--   a person (no reply_to_user_id / sent_by_user_id) is not sent by this part (unsupported); the reminders that follow judge
--   it in app.quote_message_refusal. {שם הנציג} is the sending person (the card's rule); on a message no person sent, the
--   quote's owner while an active member who is not a viewer, else the business's name.
-- * The link: a token cannot be recovered from its hash, so a message carries a NEW link to the quote. Here it is issued on the
--   QUO-08 row as it stood (one link per quote); 20261006021285_quote_links_many.sql (owner (385) ב) supersedes that: the new
--   link is ADDED, and the quote's earlier links keep working. Links made for earlier versions keep leading to this version
--   (QUO-12's rule). Audited 'quote_link' with {link: 'created', via: 'message', job_id}.
-- * public.quote_message_queue(org, quote) (definer, a person who may send it) lists the quote's messages of the last 30 days
--   and their state, the card's shape.
-- Every statement is safe to run twice; no row is removed here.

-- ----------------------------------------------------------------------------
-- The fields a quote send fills beyond the card's
-- ----------------------------------------------------------------------------
create or replace function app.quote_message_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['מסמך', 'קישור להצעה', 'תוקף']::text[]
$$;
revoke all on function app.quote_message_fields() from public, anon, authenticated, service_role;

-- the merge fields of a template that a quote send leaves without a value, in order, once each
create or replace function app.quote_unfillable_fields(p_type text, p_subject text, p_body text) returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(f order by o), '{}'::text[])
    from unnest(app.card_unfillable_fields(p_type, p_subject, p_body)) with ordinality as u(f, o)
   where not f = any (app.quote_message_fields())
$$;
revoke all on function app.quote_unfillable_fields(text, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The quote's customer: the contact the quote names (quotes.contact_id, which app.quotes_check fills from the deal's contact
-- when the quote is made, and quote_send names the customer by), live; null when the quote names none. A deal's CURRENT
-- contact is never used: a quote made on a deal without a contact has no customer to send to (review F3).
-- ----------------------------------------------------------------------------
create or replace function app.quote_message_customer(p_quote public.quotes) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select c.id from public.contacts c
   where c.organization_id = p_quote.organization_id and c.id = p_quote.contact_id and c.deleted_at is null
$$;
revoke all on function app.quote_message_customer(public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The one rule the composers ask about a quote message, right before it goes (no grants)
-- ----------------------------------------------------------------------------
create or replace function app.quote_message_refusal(p_job app.jobs, p_quote public.quotes, p_contact uuid,
                                                     p_template public.message_templates)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_shown public.quotes;
begin
  if p_quote.id is null or p_quote.organization_id is distinct from p_job.organization_id then
    return 'quote_changed';
  end if;
  if not coalesce(app.org_has_feature(p_quote.organization_id, 'quotes'), false) then
    return 'feature_off';
  end if;
  -- sent or viewed, on offer today in the business's zone, the customer not deleted
  if not coalesce(app.quote_offer_open(p_quote), false) then
    return 'quote_changed';
  end if;
  -- the chain's newest sent version only (a newer sent version supersedes it)
  v_shown := app.quote_shown_version(p_quote);
  if v_shown.id is distinct from p_quote.id then
    return 'quote_changed';
  end if;
  -- the link must open: public pages open (app.quote_link_usable's rule)
  if not coalesce(app.quote_link_usable(p_quote), false) then
    return 'pages_closed';
  end if;
  -- still the quote's customer
  if p_contact is null or app.quote_message_customer(p_quote) is distinct from p_contact then
    return 'customer_changed';
  end if;
  if (p_job.payload ? 'reply_to_user_id') or (p_job.payload ? 'sent_by_user_id') then
    -- a person's send: never from a template the system sends itself
    if p_template.notice_kind is not null then
      return 'template_changed';
    end if;
    return null;
  end if;
  -- a message without a person is not sent by this part (QUO-18's reminders judge it here)
  return 'unsupported';
end;
$$;
revoke all on function app.quote_message_refusal(app.jobs, public.quotes, uuid, public.message_templates)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A new customer link for a message (QUO-08's link, replaced; the token answered once, only its SHA-256 kept)
-- ----------------------------------------------------------------------------
create or replace function app.quote_message_link_issue(p_quote public.quotes, p_user uuid, p_job uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if p_quote.id is null or not coalesce(app.quote_link_open(p_quote), false) then
    return null;
  end if;
  -- 48 random bytes from three UUIDs, base64url: 64 characters (public.quote_link_create's token)
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  insert into app.quote_links as l (quote_id, organization_id, token_hash, created_by, created_at, window_started_at, window_count)
  values (p_quote.id, p_quote.organization_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_user, now(), null, 0)
  on conflict (quote_id) do update
    set token_hash = excluded.token_hash,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        window_started_at = null,
        window_count = 0;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_quote.organization_id, p_user, 'quote_link', 'quotes', p_quote.id,
          jsonb_build_object('link', 'created', 'via', 'message', 'job_id', p_job));
  return v_token;
end;
$$;
revoke all on function app.quote_message_link_issue(public.quotes, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The definer half: judges and queues
-- ----------------------------------------------------------------------------
create or replace function app.quote_message_enqueue(p_org uuid, p_quote uuid, p_channel text, p_template uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_quote public.quotes;
  v_contact uuid;
  v_c_owner uuid;
  v_c_team uuid;
  v_email text;
  v_phone text;
  v_tpl public.message_templates%rowtype;
  v_problem text;
  v_missing text[];
  v_found integer;
  v_payload jsonb;
  v_job uuid;
begin
  if v_user is null or p_org is null or p_quote is null or p_template is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('email', 'sms') then
    raise exception 'unknown channel' using errcode = 'P0001', hint = 'quote_message:channel';
  end if;
  -- a member who may write (never a viewer or a support session) in a writable business
  if not app.can_write(p_org) then
    raise exception 'not permitted' using errcode = '42501', hint = 'quote_message:not_permitted';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found then
    raise exception 'quote not found' using errcode = 'P0001', hint = 'quote_message:not_found';
  end if;
  -- the rule of the quote's link (QUO-08): whoever may edit its deal, else its contact
  if not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501', hint = 'quote_message:not_permitted';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if p_channel = 'sms' and not app.org_has_feature(p_org, 'sms') then
    raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:sms';
  end if;
  if v_quote.status = 'draft' then
    raise exception 'only a sent quote is sent to the customer' using errcode = 'P0001', hint = 'quote:not_sent';
  end if;
  if not app.quote_offer_open(v_quote) then
    raise exception 'the quote is no longer open' using errcode = 'P0001', hint = 'quote:closed';
  end if;
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    raise exception 'a newer version was sent' using errcode = 'P0001', hint = 'quote:superseded';
  end if;
  if not app.quote_link_usable(v_quote) then
    raise exception 'the customer link cannot open now' using errcode = 'P0001', hint = 'quote_message:link_closed';
  end if;

  -- the customer on the quote, live and readable by the sender
  v_contact := app.quote_message_customer(v_quote);
  if v_contact is not null then
    select c.owner_id, c.team_id, c.email, c.phone_e164 into v_c_owner, v_c_team, v_email, v_phone
      from public.contacts c where c.organization_id = p_org and c.id = v_contact;
  end if;
  if v_contact is null or not app.record_email_readable(p_org, 'contact', v_contact, v_c_owner, v_c_team) then
    raise exception 'the quote has no customer to send to' using errcode = 'P0001', hint = 'quote_message:no_contact';
  end if;
  if p_channel = 'email' and (v_email is null or btrim(v_email) !~ '^[^@[:space:]]+@[^@[:space:]]+$') then
    raise exception 'the customer has no email' using errcode = 'P0001', hint = 'record_email:no_address';
  end if;
  if p_channel = 'sms' and nullif(btrim(coalesce(v_phone, '')), '') is null then
    raise exception 'the customer has no phone' using errcode = 'P0001', hint = 'record_sms:no_phone';
  end if;

  -- the template: a requested_document of the channel, not one the system sends itself, sendable now
  select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    raise exception 'template not found' using errcode = 'P0001', hint = 'quote_message:template';
  end if;
  if v_tpl.channel <> p_channel then
    raise exception 'not a template of this channel' using errcode = 'P0001', hint = 'quote_message:channel';
  end if;
  if v_tpl.notice_kind is not null then
    raise exception 'the system sends this template itself' using errcode = 'P0001', hint = 'record_message:notice_template';
  end if;
  if v_tpl.message_type is distinct from 'requested_document' then
    raise exception 'a quote is sent as a requested document' using errcode = 'P0001', hint = 'quote_message:type';
  end if;
  v_problem := app.message_template_sendable(p_org, p_template);
  if v_problem is not null then
    raise exception 'the template cannot be sent' using errcode = 'P0001', hint = 'record_email:not_sendable', detail = v_problem;
  end if;
  v_missing := app.quote_unfillable_fields(v_tpl.message_type, v_tpl.subject, v_tpl.body);
  if cardinality(v_missing) > 0 then
    raise exception 'the template holds a field a quote send cannot fill' using errcode = 'P0001',
      hint = 'record_message:unfillable_field', detail = array_to_string(v_missing, ', ');
  end if;
  -- an optional part ("{ בתוקף עד {תוקף}}") disappears without a value (app.sms_fill's first pass), so only a bare {תוקף} counts
  if v_quote.valid_until is null
     and strpos(regexp_replace(coalesce(v_tpl.subject, '') || chr(10) || coalesce(v_tpl.body, ''),
                               '\{[^{}:|\n]{0,20}\{[^{}:|\n]{1,30}\}[^{}:|\n]{0,20}\}', '', 'g'), '{תוקף}') > 0 then
    raise exception 'the quote has no validity date' using errcode = 'P0001', hint = 'quote_message:no_validity';
  end if;

  -- the card's cap: 30 a person an hour across every business, counted under a lock of the person
  if p_channel = 'email' then
    perform pg_advisory_xact_lock(hashtextextended('record_email:' || v_user::text, 0));
    v_found := app.automation_email_sent_last_hour(v_user);
    if v_found >= app.record_email_hourly_limit() then
      raise exception 'too many emails this hour' using errcode = 'P0001', hint = 'record_email:rate';
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('record_sms:' || v_user::text, 0));
    v_found := app.record_sms_sent_last_hour(v_user);
    if v_found >= app.record_sms_hourly_limit() then
      raise exception 'too many SMS this hour' using errcode = 'P0001', hint = 'record_sms:rate';
    end if;
  end if;

  v_payload := jsonb_build_object('channel', p_channel, 'message_type', 'requested_document', 'template_id', v_tpl.id,
                                  'quote_id', v_quote.id, 'contact_id', v_contact)
               || case when p_channel = 'email' then jsonb_build_object('reply_to_user_id', v_user)
                       else jsonb_build_object('sent_by_user_id', v_user) end;
  v_job := app.enqueue_job(p_org, 'message.send', v_payload, null);
  return jsonb_build_object('job_id', v_job, 'paused', coalesce(app.customer_sending_paused(p_org), false));
end;
$$;
revoke all on function app.quote_message_enqueue(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function app.quote_message_enqueue(uuid, uuid, text, uuid) to authenticated;

-- The invoker half: the quote as the caller reads it (RLS), then the definer judges everything again
create or replace function public.quote_message_send(p_org uuid, p_quote uuid, p_channel text, p_template uuid)
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform 1 from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found then
    raise exception 'quote not found' using errcode = 'P0001', hint = 'quote_message:not_found';
  end if;
  return app.quote_message_enqueue(p_org, p_quote, p_channel, p_template);
end;
$$;
revoke all on function public.quote_message_send(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.quote_message_send(uuid, uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The quote's messages and their state (the card list's shape), for a person who may send it
-- ----------------------------------------------------------------------------
create or replace function public.quote_message_queue(p_org uuid, p_quote uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
begin
  if auth.uid() is null or p_org is null or p_quote is null
     or coalesce(app.membership_role(p_org)::text, 'viewer') = 'viewer' then
    return '[]'::jsonb;
  end if;
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'job_id', j.id,
             'created_at', j.created_at,
             'channel', j.payload ->> 'channel',
             'template_name', t.name,
             'sender_id', coalesce(j.payload ->> 'reply_to_user_id', j.payload ->> 'sent_by_user_id'),
             'state', case when j.status = 'done' then 'sent'
                           when j.status in ('queued', 'running', 'failed') then 'waiting'
                           else 'not_sent' end,
             'reason', case when j.status in ('refused', 'dead') then
                              case when j.last_error like 'refused:consent%' then 'consent'
                                   when j.provider is null and j.provider_error_code = 'unfilled_field' then 'unfilled'
                                   when j.provider is null and j.provider_error_code in ('quote_changed', 'customer_changed', 'record_gone') then 'quote_changed'
                                   when j.provider is null and j.provider_error_code = 'pages_closed' then 'pages_closed'
                                   when j.provider is null and j.provider_error_code in ('reminder_off', 'feature_off') then 'reminder_off'
                                   when j.last_error = 'refused:pause_expired' then 'paused'
                                   else 'other' end
                       end)
           order by j.created_at desc, j.id)
      from (select * from app.jobs j
             where j.organization_id = p_org and j.kind = 'message.send' and j.payload ->> 'quote_id' = p_quote::text
               and j.created_at > now() - interval '30 days'
             order by j.created_at desc, j.id
             limit 20) j
      left join public.message_templates t
        on t.organization_id = j.organization_id and t.id::text = j.payload ->> 'template_id'), '[]'::jsonb);
end;
$$;
revoke all on function public.quote_message_queue(uuid, uuid) from public, anon;
grant execute on function public.quote_message_queue(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- app.job_payload_ok: 021281's body, plus quote_id
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
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- app.email_compose_core: 021279's body, plus the quote branch and its link
-- ----------------------------------------------------------------------------
create or replace function app.email_compose_core(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_org public.organizations;
  v_settings public.org_document_settings;
  v_type text;
  v_zone text;
  v_site text;
  v_today date;
  v_lead uuid;
  v_contact uuid;
  v_deal uuid;
  v_email text;
  v_address text;
  v_first text;
  v_full text;
  v_gender text;
  v_owner uuid;
  v_rep uuid;
  v_sender uuid;
  v_sender_admin boolean := false;
  v_reply text;
  v_reply_owner uuid;
  v_template public.message_templates;
  v_problem text;
  v_values jsonb;
  v_subject text;
  v_body text;
  v_subject_out text;
  v_text text;
  v_links jsonb := '{}'::jsonb;
  v_link_token text;
  v_unsubscribe_url text;
  v_link_urls jsonb := '[]'::jsonb;
  v_answer jsonb;
  v_placeholder constant text := repeat('x', 64);
  v_meeting public.meetings;
  v_mrow app.meeting_customer_messages;
  v_doc public.signature_documents;
  v_doc_contact uuid;
  v_adoc public.accounting_documents;
  v_offset integer;
  v_card public.punch_cards;
  v_left integer;
  v_submission public.form_submissions;
  v_review app.review_requests;
  v_rsettings public.review_request_settings;
  v_deal_contact uuid;
  v_on boolean;
  v_files uuid[] := '{}';
  v_library uuid[] := '{}';
  v_found integer;
  v_bytes bigint := 0;
  v_more bigint := 0;
  v_attachments jsonb := '[]'::jsonb;
  v_quote public.quotes;
  v_quote_system boolean := false;
begin
  -- FOR UPDATE: the composer writes the row (composed_lease, email_counted_on)
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now()
     or v_job.send_checked_lease is distinct from p_lease
     -- only a job the send check counted, and once per lease
     or not v_job.usage_counted or v_job.composed_lease is not distinct from p_lease then
    return jsonb_build_object('refused', 'stale');
  end if;
  if (v_job.payload ->> 'channel') is distinct from 'email' then
    update app.jobs j set composed_lease = p_lease where j.id = p_job;
    return jsonb_build_object('refused', 'not_email');
  end if;
  update app.jobs j
     set composed_lease = p_lease,
         email_counted_on = coalesce(j.email_counted_on,
                                     (select (now() at time zone app.intake_zone(o.timezone))::date
                                        from public.organizations o where o.id = j.organization_id))
   where j.id = p_job;
  v_type := coalesce(v_job.payload ->> 'message_type', 'marketing');
  select * into v_org from public.organizations o where o.id = v_job.organization_id and o.deleted_at is null;
  if v_org.id is null or not coalesce(app.org_writable(v_org.id), false) then
    return jsonb_build_object('refused', 'not_writable');
  end if;
  if coalesce(app.customer_sending_paused(v_org.id), true) then
    return jsonb_build_object('refused', 'paused');
  end if;
  v_zone := app.intake_zone(v_org.timezone);
  v_today := (now() at time zone v_zone)::date;
  v_site := case when p_site_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
                   or p_site_url ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?$'
                 then p_site_url end;
  -- a verification code is an SMS of a sender check only (SMS-01b); no email carries one
  if v_type = 'verification_code' or v_job.payload ? 'sender_check_id' then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  -- the record the message is for, live, with its CURRENT email
  v_lead := case when (v_job.payload ->> 'lead_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_job.payload ->> 'lead_id')::uuid end;
  v_contact := case when (v_job.payload ->> 'contact_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (v_job.payload ->> 'contact_id')::uuid end;
  if num_nonnulls(v_lead, v_contact) <> 1 then
    return jsonb_build_object('refused', 'no_customer');
  end if;
  if v_lead is not null then
    select l.email, split_part(btrim(coalesce(l.full_name, '')), ' ', 1), l.full_name, l.gender, l.owner_id
      into v_email, v_first, v_full, v_gender, v_owner
      from public.leads l where l.organization_id = v_org.id and l.id = v_lead and l.deleted_at is null for key share;
  else
    select c.email, coalesce(nullif(btrim(coalesce(c.first_name, '')), ''), split_part(btrim(coalesce(c.full_name, '')), ' ', 1)),
           c.full_name, c.gender, c.owner_id
      into v_email, v_first, v_full, v_gender, v_owner
      from public.contacts c where c.organization_id = v_org.id and c.id = v_contact and c.deleted_at is null for key share;
  end if;
  if not found then
    return jsonb_build_object('refused', 'record_gone');
  end if;
  -- the address job_message_may_send judged (the same column, trimmed)
  v_address := nullif(btrim(coalesce(v_email, '')), '');
  if v_address is null then
    return jsonb_build_object('refused', 'no_address');
  end if;
  if not app.email_address_ok(v_address) then
    return jsonb_build_object('refused', 'bad_address');
  end if;
  -- the consent rule of the message's type, judged again on the address returned (cannot check = refused)
  if v_type = any (app.service_message_types()) then
    v_on := app.consent_service_blocked(v_org.id, 'email', v_address);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_blocked');
    end if;
  else
    v_on := app.consent_suppressed(v_org.id, 'email', v_address);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_suppressed');
    elsif app.consent_granted(v_org.id, 'email', v_address) is not true then
      return jsonb_build_object('refused', 'consent_missing');
    end if;
  end if;
  -- EML-02: an email sent from a deal goes to the deal's contact: still the deal's contact, the deal still live
  if v_job.payload ? 'deal_id' then
    select dl.id, dl.contact_id into v_deal, v_deal_contact from public.deals dl
     where dl.organization_id = v_org.id and dl.id::text = (v_job.payload ->> 'deal_id') and dl.deleted_at is null;
    if v_deal is null or v_deal_contact is null or v_deal_contact is distinct from v_contact then
      return jsonb_build_object('refused', 'customer_changed');
    end if;
  end if;

  -- the template: still there, an email template of the job's type, sendable now
  select * into v_template from public.message_templates t
   where t.organization_id = v_org.id and t.id::text = (v_job.payload ->> 'template_id');
  if v_template.id is null then
    return jsonb_build_object('refused', 'not_found');
  end if;
  if v_template.channel <> 'email' or v_template.message_type <> v_type then
    return jsonb_build_object('refused', 'template_changed');
  end if;
  v_problem := app.message_template_sendable(v_org.id, v_template.id);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;
  -- EML-02 / AUT-08: a card's or a rule's email never goes from a template the system sends itself, and collection needs the
  -- plan keys of every collection feature
  if v_job.payload ?| array['reply_to_user_id', 'automation_id'] then
    if v_template.notice_kind is not null then
      return jsonb_build_object('refused', 'template_changed');
    end if;
    if v_type = 'collection' and not (coalesce(app.org_has_feature(v_org.id, 'collection'), false)
                                      and coalesce(app.org_has_feature(v_org.id, 'documents'), false)
                                      and coalesce(app.org_has_feature(v_org.id, 'payments'), false)) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
  end if;

  -- the person who sent it from the card: the reply-to address while an active member, and the rep's name
  v_sender := case when (v_job.payload ->> 'reply_to_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then (v_job.payload ->> 'reply_to_user_id')::uuid end;
  if v_sender is not null then
    select true, ms.role in ('owner', 'admin') into v_on, v_sender_admin
      from public.memberships ms
     where ms.organization_id = v_org.id and ms.user_id = v_sender and ms.status = 'active';
    if coalesce(v_on, false) then
      select nullif(btrim(coalesce(u.email, '')), '') into v_reply from auth.users u where u.id = v_sender;
      if not coalesce(app.email_address_ok(v_reply), false) then
        v_reply := null;
      end if;
    end if;
    v_sender_admin := coalesce(v_sender_admin, false);
  end if;
  -- owner (8) ב (13 November 2026): an automation's email answers to the record's owner (a deal's email: the deal's owner)
  -- while that person is an active member who is not a viewer, with a plain address, else no reply-to; a card send keeps
  -- the sender's address
  if v_sender is null and v_job.payload ? 'automation_id' then
    if v_deal is not null then
      select dl.owner_id into v_reply_owner from public.deals dl where dl.organization_id = v_org.id and dl.id = v_deal;
    else
      v_reply_owner := v_owner;
    end if;
    if v_reply_owner is not null and exists (select 1 from public.memberships ms
                                              where ms.organization_id = v_org.id and ms.user_id = v_reply_owner
                                                and ms.status = 'active' and ms.role <> 'viewer') then
      select nullif(btrim(coalesce(u.email, '')), '') into v_reply from auth.users u where u.id = v_reply_owner;
      if not coalesce(app.email_address_ok(v_reply), false) then
        v_reply := null;
      end if;
    end if;
  end if;
  -- EML-02 (15 November 2026): {שם הנציג} is the person who sent it from the card; for an automation's email (button runs
  -- too) the reply-to's person of (8) ב, the record's owner (a deal's email: the deal's owner), not a viewer (below)
  v_rep := case when v_sender is not null then v_sender
                when v_job.payload ? 'automation_id' then v_reply_owner
                else v_owner end;

  -- owner (195) א: the files, judged again on the send day
  select coalesce(array_agg(distinct (f #>> '{}')::uuid), '{}') into v_files
    from jsonb_array_elements(case when jsonb_typeof(v_job.payload -> 'file_ids') = 'array' then v_job.payload -> 'file_ids'
                                   else '[]'::jsonb end) f;
  select coalesce(array_agg(distinct (f #>> '{}')::uuid), '{}') into v_library
    from jsonb_array_elements(case when jsonb_typeof(v_job.payload -> 'library_file_ids') = 'array'
                                   then v_job.payload -> 'library_file_ids' else '[]'::jsonb end) f;
  if cardinality(v_files) + cardinality(v_library) > 0 and v_sender is null then
    -- files go only with a person's card send (an automation's email carries none, owner (198) ב)
    return jsonb_build_object('refused', 'attachment_changed');
  end if;
  if cardinality(v_files) + cardinality(v_library) > app.record_email_max_files() then
    return jsonb_build_object('refused', 'attachment_changed');
  end if;
  if cardinality(v_files) > 0 then
    select count(*), coalesce(sum(f.size_bytes), 0),
           coalesce(jsonb_agg(jsonb_build_object('bucket', 'record-files', 'path', f.storage_path, 'name', f.name,
                                                 'type', f.mime_type) order by f.created_at, f.id), '[]'::jsonb)
      into v_found, v_bytes, v_attachments
      from public.files f
     where f.organization_id = v_org.id and f.id = any (v_files)
       and f.unconfirmed_since is null
       and case when v_deal is not null then f.deal_id = v_deal
                when v_lead is not null then f.lead_id = v_lead
                else f.contact_id = v_contact end
       -- a file on a private note is its author's and the admins' (REC-07), judged for the person who sent it
       and (f.activity_id is null or exists (
             select 1 from public.activities a
              where a.organization_id = f.organization_id and a.id = f.activity_id
                and (not a.is_private or a.created_by = v_sender or v_sender_admin)));
    if v_found <> cardinality(v_files) then
      return jsonb_build_object('refused', 'attachment_changed');
    end if;
  end if;
  if cardinality(v_library) > 0 then
    -- (197) ב: the current file (newest confirmed) of an active file item valid today in the business's zone
    select count(*), coalesce(sum(f.size_bytes), 0),
           v_attachments || coalesce(jsonb_agg(jsonb_build_object('bucket', 'record-files', 'path', f.storage_path,
                                                                  'name', f.name, 'type', f.mime_type)
                                               order by f.created_at, f.id), '[]'::jsonb)
      into v_found, v_more, v_attachments
      from public.files f
      join public.library_items i on i.organization_id = f.organization_id and i.id = f.library_item_id
     where f.organization_id = v_org.id and f.id = any (v_library)
       and f.unconfirmed_since is null
       and i.kind = 'file' and i.is_active
       and (i.valid_from is null or i.valid_from <= v_today)
       and (i.valid_until is null or i.valid_until >= v_today)
       and not exists (
             select 1 from public.files n
              where n.organization_id = f.organization_id and n.library_item_id = f.library_item_id
                and n.unconfirmed_since is null and (n.created_at, n.id) > (f.created_at, f.id));
    if v_found <> cardinality(v_library) then
      return jsonb_build_object('refused', 'attachment_changed');
    end if;
    v_bytes := v_bytes + v_more;
  end if;
  if v_bytes > app.record_email_max_bytes() then
    return jsonb_build_object('refused', 'attachments_too_large');
  end if;

  select * into v_settings from public.org_document_settings s where s.organization_id = v_org.id;
  -- every field is "given": a field without a value refuses below, an optional part without one disappears
  select jsonb_object_agg(f, null) into v_values from unnest(app.message_merge_fields()) f;
  v_values := v_values || jsonb_build_object(
    'שם פרטי', nullif(v_first, ''),
    'שם מלא', nullif(btrim(coalesce(v_full, '')), ''),
    'שם העסק', v_org.name,
    'טלפון העסק', coalesce(nullif(btrim(coalesce(v_settings.phone, '')), ''), nullif(btrim(coalesce(v_org.phone, '')), '')),
    'כתובת העסק', nullif(concat_ws(', ', nullif(btrim(coalesce(v_settings.address_line, '')), ''),
                                        nullif(btrim(coalesce(v_settings.city, '')), '')), ''));

  -- ---- each type's own conditions (app.sms_compose_core's, on the email address) ----
  if v_type = 'meeting_reminder' then
    -- CAL-12
    select * into v_mrow from app.meeting_customer_messages r
     where r.job_id = v_job.id and r.organization_id = v_org.id;
    if v_mrow.meeting_id is null or (v_job.payload ->> 'meeting_id') is distinct from v_mrow.meeting_id::text then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    select * into v_meeting from public.meetings m
     where m.organization_id = v_org.id and m.id = v_mrow.meeting_id for key share;
    -- the meeting's customer as CAL-12 picks it: its live contact, else its live lead
    select mt.contact_id, mt.lead_id into v_doc_contact, v_deal_contact
      from (select c.id as contact_id, null::uuid as lead_id from public.contacts c
             where c.organization_id = v_org.id and c.id = v_meeting.contact_id and c.deleted_at is null
            union all
            select null, l.id from public.leads l
             where l.organization_id = v_org.id and l.id = v_meeting.lead_id and l.deleted_at is null
               and not exists (select 1 from public.contacts c where c.organization_id = v_org.id
                                  and c.id = v_meeting.contact_id and c.deleted_at is null)) mt;
    if v_mrow.outcome <> 'queued' or v_meeting.id is null or v_meeting.status <> 'planned' or v_meeting.is_block
       or v_meeting.starts_at <> v_mrow.starts_at or v_meeting.starts_at <= now()
       or v_doc_contact is distinct from v_contact or v_deal_contact is distinct from v_lead then
      return jsonb_build_object('refused', 'meeting_changed');
    end if;
    select case v_mrow.kind when 'day' then s.meeting_remind_day when 'hour' then s.meeting_remind_hour else s.meeting_confirm end
      into v_on from public.org_message_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'meeting_reminders'), false) or not coalesce(v_on, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    v_rep := coalesce(v_meeting.owner_id, v_rep);
    v_values := v_values || jsonb_build_object(
      'תאריך', app.sms_hebrew_date((v_meeting.starts_at at time zone v_zone)::date, true),
      'שעה', to_char(v_meeting.starts_at at time zone v_zone, 'HH24:MI'),
      'מיקום', nullif(btrim(coalesce(v_meeting.location, '')), ''));
    v_links := jsonb_build_object('קישור', '/f/book/manage/');
  elsif v_type = 'requested_document' and v_job.payload ? 'quote_id' then
    -- QUO-18: the quote, re-read in the job's business; the one rule decides (app.quote_message_refusal)
    select * into v_quote from public.quotes q
     where q.organization_id = v_org.id and q.id::text = (v_job.payload ->> 'quote_id') for key share;
    v_problem := app.quote_message_refusal(v_job, v_quote, v_contact, v_template);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    -- a message no person sent answers to the quote's owner while an active member who is not a viewer
    if v_sender is null then
      v_quote_system := true;
      v_rep := v_quote.owner_id;
      if v_quote.owner_id is not null and exists (select 1 from public.memberships ms
                                                   where ms.organization_id = v_org.id and ms.user_id = v_quote.owner_id
                                                     and ms.status = 'active' and ms.role <> 'viewer') then
        select nullif(btrim(coalesce(u.email, '')), '') into v_reply from auth.users u where u.id = v_quote.owner_id;
        if not coalesce(app.email_address_ok(v_reply), false) then
          v_reply := null;
        end if;
      end if;
    end if;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim('הצעת מחיר ' || coalesce(v_quote.number_display, '')),
      'תוקף', app.sms_hebrew_date(v_quote.valid_until, false));
    v_links := jsonb_build_object('קישור להצעה', '/f/quote/');
  elsif v_type = 'requested_document' and v_job.payload ? 'signature_document_id' then
    -- SGN-03
    select * into v_doc from public.signature_documents d
     where d.organization_id = v_org.id and d.id::text = (v_job.payload ->> 'signature_document_id') for key share;
    if v_doc.id is not null and v_doc.deal_id is not null and v_doc.lead_id is null and v_doc.contact_id is null then
      select dl.contact_id into v_doc_contact from public.deals dl
       where dl.organization_id = v_org.id and dl.id = v_doc.deal_id and dl.deleted_at is null;
    else
      v_doc_contact := v_doc.contact_id;
    end if;
    if v_doc.id is null or v_doc.status not in ('sent', 'viewed') or v_doc.expired_at is not null or v_doc.erased_at is not null
       or v_doc.text_erased_at is not null or v_doc.expires_at is null or v_doc.expires_at <= now()
       or (v_lead is not null and v_doc.lead_id is distinct from v_lead)
       or (v_contact is not null and v_doc_contact is distinct from v_contact)
       or not exists (select 1 from app.signature_customer_reminders r
                       where r.organization_id = v_org.id and r.document_id = v_doc.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'signatures'), false)
       or not coalesce(v_settings.signature_customer_reminder, true) then
      return jsonb_build_object('refused', 'reminder_off');
    end if;
    v_values := v_values || jsonb_build_object(
      'שם המסמך', nullif(btrim(coalesce(v_doc.title, '')), ''),
      'תאריך', app.sms_hebrew_date((v_doc.expires_at at time zone v_zone)::date, false));
    v_links := jsonb_build_object('קישור', '/f/sign/');
  elsif v_type = 'collection' and v_job.payload ? 'collection_document_id' then
    -- COL-07
    select r.offset_days into v_offset from app.collection_reminders_sent r
     where r.organization_id = v_org.id and r.customer_job_id = v_job.id
       and r.document_id::text = (v_job.payload ->> 'collection_document_id');
    if not found then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    v_problem := app.collection_customer_refusal(v_org.id, (v_job.payload ->> 'collection_document_id')::uuid, v_contact, v_offset);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    select * into v_adoc from public.accounting_documents d
     where d.organization_id = v_org.id and d.id = (v_job.payload ->> 'collection_document_id')::uuid;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim(app.document_type_label(v_adoc.doc_type) || coalesce(' ' || v_adoc.number, '')),
      'סכום', app.sms_amount_text(app.document_balance(v_org.id, v_adoc.id)),
      'מועד תשלום', app.sms_hebrew_date(v_adoc.due_date, false));
  elsif v_type = 'punch_card_notice' then
    -- PKG-03 / PKG-06
    select * into v_card from public.punch_cards c
     where c.organization_id = v_org.id and c.id::text = (v_job.payload ->> 'punch_card_id');
    if v_card.id is null or v_card.status <> 'active' or v_contact is null
       or (v_card.contact_id is distinct from v_contact and v_card.payer_contact_id is distinct from v_contact) then
      return jsonb_build_object('refused', 'card_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'punch_cards'), false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if not coalesce((select s.customer_messages from public.punch_card_alert_settings s where s.organization_id = v_org.id), false) then
      return jsonb_build_object('refused', 'messages_off');
    end if;
    select v_card.entries_total - count(*)::integer into v_left from public.punch_card_uses u
     where u.organization_id = v_org.id and u.card_id = v_card.id and u.returned_at is null;
    v_values := v_values || jsonb_build_object(
      'שם הכרטיסייה', v_card.name,
      'כניסות', app.punch_card_entries_text(v_left),
      'תאריך', app.sms_hebrew_date(v_card.expires_on, false));
  elsif v_type = 'instant_reply' then
    -- SPD-04: the record's email still the one typed in the submission
    select * into v_submission from public.form_submissions s
     where s.organization_id = v_org.id and s.id::text = (v_job.payload ->> 'form_submission_id') and s.status <> 'spam';
    if v_submission.id is null
       or not exists (select 1 from app.instant_replies r
                       where r.organization_id = v_org.id and r.submission_id = v_submission.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'instant_reply'), false)
       or not exists (select 1 from public.forms f
                       where f.organization_id = v_org.id and f.id = v_submission.form_id and f.kind = 'form' and f.instant_reply) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if nullif(lower(btrim(coalesce(v_submission.payload ->> 'email', ''))), '') is distinct from lower(v_address) then
      return jsonb_build_object('refused', 'address_changed');
    end if;
    if not (v_job.payload ? 'event_at') then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    v_values := v_values || jsonb_build_object('שעה', to_char((v_job.payload ->> 'event_at')::timestamptz at time zone v_zone, 'HH24:MI'));
  elsif v_type = 'review_request' then
    -- RET-02: the person and the request from the request's own row
    select * into v_review from app.review_requests r
     where r.organization_id = v_org.id and r.id::text = (v_job.payload ->> 'review_request_id');
    if v_review.id is null or v_review.job_id is distinct from v_job.id
       or v_review.lead_id is distinct from v_lead or v_review.contact_id is distinct from v_contact then
      return jsonb_build_object('refused', 'request_changed');
    end if;
    select * into v_rsettings from public.review_request_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'review_requests'), false) or not coalesce(v_rsettings.enabled, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if coalesce(app.qr_external_off(v_org.id), true) then
      return jsonb_build_object('refused', 'link_blocked');
    end if;
    if not coalesce(app.review_url_ok(v_rsettings.review_url), false) then
      return jsonb_build_object('refused', 'link_invalid');
    end if;
    v_values := v_values || jsonb_build_object('קישור לביקורת', v_rsettings.review_url);
  elsif v_type not in ('marketing', 'requested_document', 'collection') then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  v_values := v_values || jsonb_build_object('שם הנציג',
    coalesce((select nullif(btrim(coalesce(p.full_name, '')), '') from public.profiles p
                join public.memberships ms on ms.user_id = p.id and ms.organization_id = v_org.id and ms.status = 'active'
               -- EML-02 (15 November 2026): an automation's rep is an active member who is not a viewer; QUO-18: so is the
               -- quote's owner on a message no person sent
               where p.id = v_rep and (not (v_job.payload ? 'automation_id' or v_quote_system) or ms.role <> 'viewer')),
             -- QUO-18: a message no person sent, whose owner is not such a member, is signed with the business's name
             case when v_quote_system then v_org.name end));

  -- marketing types: the envelope and the unsubscribe link (CNS-07: no type = marketing)
  v_subject := coalesce(v_template.subject, '');
  v_body := v_template.body;
  if not (v_type = any (app.service_message_types())) then
    v_subject := app.email_marketing_subject(v_subject);
    v_body := app.email_marketing_body(v_body);
    v_links := v_links || jsonb_build_object('קישור הסרה', '/f/unsub/');
  end if;
  -- only the links the subject or the body holds
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_links
    from jsonb_each_text(v_links) as e(k, v) where strpos(v_body || v_subject, '{' || k || '}') > 0;
  if v_links <> '{}'::jsonb and v_site is null then
    return jsonb_build_object('refused', 'site_url');
  end if;

  -- judged with placeholders of the tokens' exact length before anything is minted
  v_text := app.sms_fill(v_body, v_values || (select coalesce(jsonb_object_agg(k, v_site || v || v_placeholder), '{}'::jsonb)
                                                 from jsonb_each_text(v_links) as e(k, v)), v_gender);
  v_subject_out := app.sms_fill(v_subject, v_values || (select coalesce(jsonb_object_agg(k, v_site || v || v_placeholder), '{}'::jsonb)
                                                          from jsonb_each_text(v_links) as e(k, v)), v_gender);
  if app.sms_unfilled_in(v_body, v_values || (select coalesce(jsonb_object_agg(k, 'x'), '{}'::jsonb)
                                                from jsonb_each_text(v_links) as e(k, v)), v_gender)
     or app.sms_unfilled_in(v_subject, v_values || (select coalesce(jsonb_object_agg(k, 'x'), '{}'::jsonb)
                                                      from jsonb_each_text(v_links) as e(k, v)), v_gender) then
    return jsonb_build_object('refused', 'unfilled_field');
  end if;
  v_problem := app.message_filled_problem('email', v_type, v_subject_out, v_text);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;
  if v_subject_out ~ '[[:cntrl:]]' or btrim(v_subject_out) = '' then
    return jsonb_build_object('refused', 'bad_subject');
  end if;
  if char_length(v_subject_out) > 255 then
    return jsonb_build_object('refused', 'subject_too_long');
  end if;

  -- the links, last
  if v_links ? 'קישור' then
    if v_type = 'meeting_reminder' then
      v_answer := public.meeting_reminder_link(v_job.id, p_lease);
      if v_answer ? 'refused' then
        return jsonb_build_object('refused', v_answer ->> 'refused');
      end if;
      v_link_token := v_answer ->> 'token';
    else
      v_link_token := app.signature_link_issue(v_doc);
    end if;
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור', v_site || (v_links ->> 'קישור') || v_link_token);
    v_link_urls := v_link_urls || to_jsonb(v_site || (v_links ->> 'קישור') || v_link_token);
  end if;
  if v_links ? 'קישור להצעה' then
    -- QUO-18: a new customer link for this message (since 021285 added beside the quote's earlier links)
    v_link_token := app.quote_message_link_issue(v_quote, v_sender, v_job.id);
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור להצעה', v_site || (v_links ->> 'קישור להצעה') || v_link_token);
    v_link_urls := v_link_urls || to_jsonb(v_site || (v_links ->> 'קישור להצעה') || v_link_token);
  end if;
  if v_links ? 'קישור הסרה' then
    v_answer := public.consent_preference_link_for_job(v_job.id, p_lease);
    if v_answer ? 'refused' then
      return jsonb_build_object('refused', v_answer ->> 'refused');
    end if;
    v_link_token := v_answer ->> 'token';
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור הסרה', v_site || (v_links ->> 'קישור הסרה') || v_link_token);
    -- RFC 8058: the one-click POST address for the List-Unsubscribe headers (the same token)
    v_unsubscribe_url := v_site || '/api/forms/unsub/' || v_link_token;
    v_link_urls := v_link_urls || to_jsonb(v_site || (v_links ->> 'קישור הסרה') || v_link_token);
  end if;
  -- RET-02: the stored review link, when the text holds it
  if v_type = 'review_request' and strpos(v_body || v_subject, '{קישור לביקורת}') > 0
     and v_rsettings.review_url like 'https://%' then
    v_link_urls := v_link_urls || to_jsonb(v_rsettings.review_url);
  end if;
  v_text := app.sms_fill(v_body, v_values, v_gender);
  v_subject_out := app.sms_fill(v_subject, v_values, v_gender);
  if app.sms_unfilled_in(v_body, v_values, v_gender) or app.sms_unfilled_in(v_subject, v_values, v_gender)
     or app.message_filled_problem('email', v_type, v_subject_out, v_text) is not null
     or v_subject_out ~ '[[:cntrl:]]' or char_length(v_subject_out) > 255 then
    return jsonb_build_object('refused', 'changed');
  end if;

  return jsonb_build_object('to', v_address, 'from_name', v_org.name, 'subject', v_subject_out, 'text', v_text,
                            'reply_to', v_reply, 'list_unsubscribe', v_unsubscribe_url,
                            'links', (select coalesce(jsonb_agg(distinct u), '[]'::jsonb)
                                        from jsonb_array_elements_text(v_link_urls) u
                                       -- delta review (2): only a plain https URL (no space, quote or angle bracket)
                                       where u ~ '^https://[^[:space:]<>"'']+$'),
                            'attachments', v_attachments);
end;
$$;
revoke all on function app.email_compose_core(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.sms_compose_core: 021279's body, plus the quote branch and its link
-- ----------------------------------------------------------------------------
create or replace function app.sms_compose_core(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_org public.organizations;
  v_settings public.org_document_settings;
  v_type text;
  v_zone text;
  v_site text;
  v_lead uuid;
  v_contact uuid;
  v_phone text;
  v_first text;
  v_full text;
  v_gender text;
  v_owner uuid;
  v_rep uuid;
  v_template public.message_templates;
  v_problem text;
  v_values jsonb;
  v_body text;
  v_text text;
  v_links jsonb := '{}'::jsonb;
  v_link_token text;
  v_answer jsonb;
  v_placeholder constant text := repeat('x', 64);
  v_meeting public.meetings;
  v_mrow app.meeting_customer_messages;
  v_doc public.signature_documents;
  v_doc_contact uuid;
  v_adoc public.accounting_documents;
  v_offset integer;
  v_card public.punch_cards;
  v_left integer;
  v_submission public.form_submissions;
  v_review app.review_requests;
  v_rsettings public.review_request_settings;
  v_deal_contact uuid;
  v_on boolean;
  v_raw_phone text;
  v_quote public.quotes;
  v_quote_system boolean := false;
begin
  -- final review (3): FOR UPDATE, since the composer writes the row (composed_lease, sms_counted_on)
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now()
     or v_job.send_checked_lease is distinct from p_lease
     -- delta review (4): only a job the send check counted, and once per lease
     or not v_job.usage_counted or v_job.composed_lease is not distinct from p_lease then
    return jsonb_build_object('refused', 'stale');
  end if;
  update app.jobs j
     set composed_lease = p_lease,
         sms_counted_on = coalesce(j.sms_counted_on,
                                   (select (now() at time zone app.intake_zone(o.timezone))::date
                                      from public.organizations o where o.id = j.organization_id))
   where j.id = p_job;
  if (v_job.payload ->> 'channel') is distinct from 'sms' then
    return jsonb_build_object('refused', 'not_sms');
  end if;
  v_type := coalesce(v_job.payload ->> 'message_type', 'marketing');
  select * into v_org from public.organizations o where o.id = v_job.organization_id and o.deleted_at is null;
  if v_org.id is null or not coalesce(app.org_writable(v_org.id), false) then
    return jsonb_build_object('refused', 'not_writable');
  end if;
  if coalesce(app.customer_sending_paused(v_org.id), true) then
    return jsonb_build_object('refused', 'paused');
  end if;
  v_zone := app.intake_zone(v_org.timezone);
  v_site := case when p_site_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
                   or p_site_url ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?$'
                 then p_site_url end;

  -- SMS-01b: the code that verifies the business's own sender number
  if v_job.payload ? 'sender_check_id' then
    if v_type <> 'verification_code' then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    v_answer := public.sms_sender_code_issue(v_job.id, p_lease);
    if v_answer ? 'refused' then
      return jsonb_build_object('refused', v_answer ->> 'refused');
    end if;
    v_phone := app.normalize_phone(v_answer ->> 'phone');
    if v_phone is null then
      return jsonb_build_object('refused', 'no_phone');
    end if;
    -- review (1): the number job_message_may_send judged (the check's phone), and the service rule on it again
    select k.phone into v_raw_phone from app.sms_sender_checks k
     where k.organization_id = v_org.id and k.id::text = (v_job.payload ->> 'sender_check_id');
    if app.normalize_phone(v_raw_phone) is distinct from v_phone then
      return jsonb_build_object('refused', 'address_changed');
    end if;
    v_on := app.consent_service_blocked(v_org.id, 'sms', v_phone);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_blocked');
    end if;
    -- the number is not verified yet: the platform's default sender
    return jsonb_build_object('to', v_phone, 'sender', null, 'text', app.sms_sender_code_text(v_answer ->> 'code'));
  end if;
  if v_type = 'verification_code' then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  -- the record the message is for, live, with its CURRENT phone
  v_lead := case when (v_job.payload ->> 'lead_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_job.payload ->> 'lead_id')::uuid end;
  v_contact := case when (v_job.payload ->> 'contact_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (v_job.payload ->> 'contact_id')::uuid end;
  if num_nonnulls(v_lead, v_contact) <> 1 then
    return jsonb_build_object('refused', 'no_customer');
  end if;
  if v_lead is not null then
    select l.phone_e164, l.phone, split_part(btrim(coalesce(l.full_name, '')), ' ', 1), l.full_name, l.gender, l.owner_id
      into v_phone, v_raw_phone, v_first, v_full, v_gender, v_owner
      from public.leads l where l.organization_id = v_org.id and l.id = v_lead and l.deleted_at is null for key share;
  else
    select c.phone_e164, coalesce(nullif(btrim(coalesce(c.first_name, '')), ''), split_part(btrim(coalesce(c.full_name, '')), ' ', 1)),
           c.full_name, c.gender, c.owner_id, c.phone
      into v_phone, v_first, v_full, v_gender, v_owner, v_raw_phone
      from public.contacts c where c.organization_id = v_org.id and c.id = v_contact and c.deleted_at is null for key share;
  end if;
  if not found then
    return jsonb_build_object('refused', 'record_gone');
  end if;
  if nullif(btrim(coalesce(v_phone, '')), '') is null then
    return jsonb_build_object('refused', 'no_phone');
  end if;
  -- review (1): the number returned is the one job_message_may_send judged (the record's typed phone, normalized), and the
  -- consent rule of the message's type is judged again here on it (cannot check = refused, as the send check)
  if app.normalize_phone(v_raw_phone) is distinct from v_phone then
    return jsonb_build_object('refused', 'address_changed');
  end if;
  if v_type = any (app.service_message_types()) then
    v_on := app.consent_service_blocked(v_org.id, 'sms', v_phone);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_blocked');
    end if;
  else
    v_on := app.consent_suppressed(v_org.id, 'sms', v_phone);
    if v_on is null then
      return jsonb_build_object('refused', 'consent_unknown');
    elsif v_on then
      return jsonb_build_object('refused', 'consent_suppressed');
    elsif app.consent_granted(v_org.id, 'sms', v_phone) is not true then
      return jsonb_build_object('refused', 'consent_missing');
    end if;
  end if;
  -- a message sent from a deal goes to the deal's contact: still the deal's contact, the deal still live
  if v_job.payload ? 'deal_id' then
    select dl.contact_id into v_deal_contact from public.deals dl
     where dl.organization_id = v_org.id and dl.id::text = (v_job.payload ->> 'deal_id') and dl.deleted_at is null;
    if v_deal_contact is null or v_deal_contact is distinct from v_contact then
      return jsonb_build_object('refused', 'customer_changed');
    end if;
  end if;

  -- the template: still there, an SMS template of the job's type, sendable now
  select * into v_template from public.message_templates t
   where t.organization_id = v_org.id and t.id::text = (v_job.payload ->> 'template_id');
  if v_template.id is null then
    return jsonb_build_object('refused', 'not_found');
  end if;
  if v_template.channel <> 'sms' or v_template.message_type <> v_type then
    return jsonb_build_object('refused', 'template_changed');
  end if;
  v_problem := app.message_template_sendable(v_org.id, v_template.id);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;

  select * into v_settings from public.org_document_settings s where s.organization_id = v_org.id;
  -- EML-02 (15 November 2026): {שם הנציג} is the person who sent it from the card; for an automation's SMS (button runs too)
  -- the record's owner, a deal's SMS the deal's owner (the email's rule, owner (8) ב), not a viewer (below)
  v_rep := case when (v_job.payload ->> 'sent_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (v_job.payload ->> 'sent_by_user_id')::uuid
                when v_job.payload ? 'automation_id' and v_job.payload ? 'deal_id'
                then (select dl.owner_id from public.deals dl
                       where dl.organization_id = v_org.id and dl.id::text = (v_job.payload ->> 'deal_id'))
                else v_owner end;
  -- every field is "given": a field without a value refuses below, an optional part without one disappears
  select jsonb_object_agg(f, null) into v_values from unnest(app.message_merge_fields()) f;
  v_values := v_values || jsonb_build_object(
    'שם פרטי', nullif(v_first, ''),
    'שם מלא', nullif(btrim(coalesce(v_full, '')), ''),
    'שם העסק', v_org.name,
    'טלפון העסק', coalesce(nullif(btrim(coalesce(v_settings.phone, '')), ''), nullif(btrim(coalesce(v_org.phone, '')), '')),
    'כתובת העסק', nullif(concat_ws(', ', nullif(btrim(coalesce(v_settings.address_line, '')), ''),
                                        nullif(btrim(coalesce(v_settings.city, '')), '')), ''));

  -- ---- each type's own conditions ----
  if v_type = 'meeting_reminder' then
    -- CAL-12
    select * into v_mrow from app.meeting_customer_messages r
     where r.job_id = v_job.id and r.organization_id = v_org.id;
    if v_mrow.meeting_id is null or (v_job.payload ->> 'meeting_id') is distinct from v_mrow.meeting_id::text then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    select * into v_meeting from public.meetings m
     where m.organization_id = v_org.id and m.id = v_mrow.meeting_id for key share;
    -- the meeting's customer as CAL-12 picks it: its live contact, else its live lead (meeting_reminder_link's rule)
    select mt.contact_id, mt.lead_id into v_doc_contact, v_deal_contact
      from (select c.id as contact_id, null::uuid as lead_id from public.contacts c
             where c.organization_id = v_org.id and c.id = v_meeting.contact_id and c.deleted_at is null
            union all
            select null, l.id from public.leads l
             where l.organization_id = v_org.id and l.id = v_meeting.lead_id and l.deleted_at is null
               and not exists (select 1 from public.contacts c where c.organization_id = v_org.id
                                  and c.id = v_meeting.contact_id and c.deleted_at is null)) mt;
    if v_mrow.outcome <> 'queued' or v_meeting.id is null or v_meeting.status <> 'planned' or v_meeting.is_block
       or v_meeting.starts_at <> v_mrow.starts_at or v_meeting.starts_at <= now()
       or v_doc_contact is distinct from v_contact or v_deal_contact is distinct from v_lead then
      return jsonb_build_object('refused', 'meeting_changed');
    end if;
    select case v_mrow.kind when 'day' then s.meeting_remind_day when 'hour' then s.meeting_remind_hour else s.meeting_confirm end
      into v_on from public.org_message_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'meeting_reminders'), false) or not coalesce(v_on, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    v_rep := coalesce(v_meeting.owner_id, v_rep);
    v_values := v_values || jsonb_build_object(
      'תאריך', app.sms_hebrew_date((v_meeting.starts_at at time zone v_zone)::date, true),
      'שעה', to_char(v_meeting.starts_at at time zone v_zone, 'HH24:MI'),
      'מיקום', nullif(btrim(coalesce(v_meeting.location, '')), ''));
    v_links := jsonb_build_object('קישור', '/f/book/manage/');
  elsif v_type = 'requested_document' and v_job.payload ? 'quote_id' then
    -- QUO-18: the quote, re-read in the job's business; the one rule decides (app.quote_message_refusal)
    select * into v_quote from public.quotes q
     where q.organization_id = v_org.id and q.id::text = (v_job.payload ->> 'quote_id') for key share;
    v_problem := app.quote_message_refusal(v_job, v_quote, v_contact, v_template);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    -- a message no person sent: {שם הנציג} is the quote's owner
    if not (v_job.payload ? 'sent_by_user_id') then
      v_quote_system := true;
      v_rep := v_quote.owner_id;
    end if;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim('הצעת מחיר ' || coalesce(v_quote.number_display, '')),
      'תוקף', app.sms_hebrew_date(v_quote.valid_until, false));
    v_links := jsonb_build_object('קישור להצעה', '/f/quote/');
  elsif v_type = 'requested_document' and v_job.payload ? 'signature_document_id' then
    -- SGN-03
    select * into v_doc from public.signature_documents d
     where d.organization_id = v_org.id and d.id::text = (v_job.payload ->> 'signature_document_id') for key share;
    if v_doc.id is not null and v_doc.deal_id is not null and v_doc.lead_id is null and v_doc.contact_id is null then
      select dl.contact_id into v_doc_contact from public.deals dl
       where dl.organization_id = v_org.id and dl.id = v_doc.deal_id and dl.deleted_at is null;
    else
      v_doc_contact := v_doc.contact_id;
    end if;
    if v_doc.id is null or v_doc.status not in ('sent', 'viewed') or v_doc.expired_at is not null or v_doc.erased_at is not null
       or v_doc.text_erased_at is not null or v_doc.expires_at is null or v_doc.expires_at <= now()
       or (v_lead is not null and v_doc.lead_id is distinct from v_lead)
       or (v_contact is not null and v_doc_contact is distinct from v_contact)
       or not exists (select 1 from app.signature_customer_reminders r
                       where r.organization_id = v_org.id and r.document_id = v_doc.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'signatures'), false)
       or not coalesce(v_settings.signature_customer_reminder, true) then
      return jsonb_build_object('refused', 'reminder_off');
    end if;
    v_values := v_values || jsonb_build_object(
      'שם המסמך', nullif(btrim(coalesce(v_doc.title, '')), ''),
      'תאריך', app.sms_hebrew_date((v_doc.expires_at at time zone v_zone)::date, false));
    v_links := jsonb_build_object('קישור', '/f/sign/');
  elsif v_type = 'collection' and v_job.payload ? 'collection_document_id' then
    -- COL-07
    select r.offset_days into v_offset from app.collection_reminders_sent r
     where r.organization_id = v_org.id and r.customer_job_id = v_job.id
       and r.document_id::text = (v_job.payload ->> 'collection_document_id');
    if not found then
      return jsonb_build_object('refused', 'document_changed');
    end if;
    v_problem := app.collection_customer_refusal(v_org.id, (v_job.payload ->> 'collection_document_id')::uuid, v_contact, v_offset);
    if v_problem is not null then
      return jsonb_build_object('refused', v_problem);
    end if;
    select * into v_adoc from public.accounting_documents d
     where d.organization_id = v_org.id and d.id = (v_job.payload ->> 'collection_document_id')::uuid;
    v_values := v_values || jsonb_build_object(
      'מסמך', btrim(app.document_type_label(v_adoc.doc_type) || coalesce(' ' || v_adoc.number, '')),
      'סכום', app.sms_amount_text(app.document_balance(v_org.id, v_adoc.id)),
      'מועד תשלום', app.sms_hebrew_date(v_adoc.due_date, false));
  elsif v_type = 'punch_card_notice' then
    -- PKG-03 / PKG-06
    select * into v_card from public.punch_cards c
     where c.organization_id = v_org.id and c.id::text = (v_job.payload ->> 'punch_card_id');
    if v_card.id is null or v_card.status <> 'active' or v_contact is null
       or (v_card.contact_id is distinct from v_contact and v_card.payer_contact_id is distinct from v_contact) then
      return jsonb_build_object('refused', 'card_changed');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'punch_cards'), false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    -- review (9): the business's switch for customer messages (PKG-03) still on
    if not coalesce((select s.customer_messages from public.punch_card_alert_settings s where s.organization_id = v_org.id), false) then
      return jsonb_build_object('refused', 'messages_off');
    end if;
    select v_card.entries_total - count(*)::integer into v_left from public.punch_card_uses u
     where u.organization_id = v_org.id and u.card_id = v_card.id and u.returned_at is null;
    v_values := v_values || jsonb_build_object(
      'שם הכרטיסייה', v_card.name,
      'כניסות', app.punch_card_entries_text(v_left),
      'תאריך', app.sms_hebrew_date(v_card.expires_on, false));
  elsif v_type = 'instant_reply' then
    -- SPD-04
    select * into v_submission from public.form_submissions s
     where s.organization_id = v_org.id and s.id::text = (v_job.payload ->> 'form_submission_id') and s.status <> 'spam';
    if v_submission.id is null
       or not exists (select 1 from app.instant_replies r
                       where r.organization_id = v_org.id and r.submission_id = v_submission.id and r.job_id = v_job.id) then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    if not coalesce(app.org_has_feature(v_org.id, 'instant_reply'), false)
       or not exists (select 1 from public.forms f
                       where f.organization_id = v_org.id and f.id = v_submission.form_id and f.kind = 'form' and f.instant_reply) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if app.normalize_phone(nullif(btrim(coalesce(v_submission.payload ->> 'phone', '')), '')) is distinct from v_phone then
      return jsonb_build_object('refused', 'address_changed');
    end if;
    if not (v_job.payload ? 'event_at') then
      return jsonb_build_object('refused', 'unsupported');
    end if;
    v_values := v_values || jsonb_build_object('שעה', to_char((v_job.payload ->> 'event_at')::timestamptz at time zone v_zone, 'HH24:MI'));
  elsif v_type = 'review_request' then
    -- RET-02: the person and the request from the request's own row
    select * into v_review from app.review_requests r
     where r.organization_id = v_org.id and r.id::text = (v_job.payload ->> 'review_request_id');
    if v_review.id is null or v_review.job_id is distinct from v_job.id
       or v_review.lead_id is distinct from v_lead or v_review.contact_id is distinct from v_contact then
      return jsonb_build_object('refused', 'request_changed');
    end if;
    select * into v_rsettings from public.review_request_settings s where s.organization_id = v_org.id;
    if not coalesce(app.org_has_feature(v_org.id, 'review_requests'), false) or not coalesce(v_rsettings.enabled, false) then
      return jsonb_build_object('refused', 'feature_off');
    end if;
    if coalesce(app.qr_external_off(v_org.id), true) then
      return jsonb_build_object('refused', 'link_blocked');
    end if;
    if not coalesce(app.review_url_ok(v_rsettings.review_url), false) then
      return jsonb_build_object('refused', 'link_invalid');
    end if;
    v_values := v_values || jsonb_build_object('קישור לביקורת', v_rsettings.review_url);
  elsif v_type not in ('marketing', 'requested_document', 'collection') then
    return jsonb_build_object('refused', 'unsupported');
  end if;

  v_values := v_values || jsonb_build_object('שם הנציג',
    coalesce((select nullif(btrim(coalesce(p.full_name, '')), '') from public.profiles p
                join public.memberships ms on ms.user_id = p.id and ms.organization_id = v_org.id and ms.status = 'active'
               -- EML-02 (15 November 2026): an automation's rep is an active member who is not a viewer; QUO-18: so is the
               -- quote's owner on a message no person sent
               where p.id = v_rep and (not (v_job.payload ? 'automation_id' or v_quote_system) or ms.role <> 'viewer')),
             -- QUO-18: a message no person sent, whose owner is not such a member, is signed with the business's name
             case when v_quote_system then v_org.name end));

  -- marketing types: the envelope and the unsubscribe link (CNS-07: no type = marketing)
  v_body := v_template.body;
  if not (v_type = any (app.service_message_types())) then
    v_body := app.sms_marketing_envelope(v_body);
    v_links := v_links || jsonb_build_object('קישור הסרה', '/f/unsub/');
  end if;
  -- only the links the text holds
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_links
    from jsonb_each_text(v_links) as e(k, v) where strpos(v_body, '{' || k || '}') > 0;
  if v_links <> '{}'::jsonb and v_site is null then
    return jsonb_build_object('refused', 'site_url');
  end if;

  -- judged with placeholders of the tokens' exact length before anything is minted
  v_text := app.sms_fill(v_body, v_values || (select coalesce(jsonb_object_agg(k, v_site || v || v_placeholder), '{}'::jsonb)
                                                 from jsonb_each_text(v_links) as e(k, v)), v_gender);
  if app.sms_unfilled_in(v_body, v_values || (select coalesce(jsonb_object_agg(k, 'x'), '{}'::jsonb)
                                                from jsonb_each_text(v_links) as e(k, v)), v_gender) then
    return jsonb_build_object('refused', 'unfilled_field');
  end if;
  v_problem := app.message_filled_problem('sms', v_type, null, v_text);
  if v_problem is not null then
    return jsonb_build_object('refused', v_problem);
  end if;

  -- the links, last
  if v_links ? 'קישור' then
    if v_type = 'meeting_reminder' then
      v_answer := public.meeting_reminder_link(v_job.id, p_lease);
      if v_answer ? 'refused' then
        return jsonb_build_object('refused', v_answer ->> 'refused');
      end if;
      v_link_token := v_answer ->> 'token';
    else
      v_link_token := app.signature_link_issue(v_doc);
    end if;
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור', v_site || (v_links ->> 'קישור') || v_link_token);
  end if;
  if v_links ? 'קישור להצעה' then
    -- QUO-18: a new customer link for this message (since 021285 added beside the quote's earlier links)
    v_link_token := app.quote_message_link_issue(v_quote,
                      case when (v_job.payload ->> 'sent_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (v_job.payload ->> 'sent_by_user_id')::uuid end, v_job.id);
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור להצעה', v_site || (v_links ->> 'קישור להצעה') || v_link_token);
  end if;
  if v_links ? 'קישור הסרה' then
    v_answer := public.consent_preference_link_for_job(v_job.id, p_lease);
    if v_answer ? 'refused' then
      return jsonb_build_object('refused', v_answer ->> 'refused');
    end if;
    v_link_token := v_answer ->> 'token';
    if v_link_token is null or char_length(v_link_token) <> 64 then
      return jsonb_build_object('refused', 'link');
    end if;
    v_values := v_values || jsonb_build_object('קישור הסרה', v_site || (v_links ->> 'קישור הסרה') || v_link_token);
  end if;
  v_text := app.sms_fill(v_body, v_values, v_gender);
  if app.sms_unfilled_in(v_body, v_values, v_gender) or app.message_filled_problem('sms', v_type, null, v_text) is not null then
    return jsonb_build_object('refused', 'changed');
  end if;

  return jsonb_build_object('to', v_phone, 'sender', app.sms_effective_sender(v_org.id), 'text', v_text);
end;
$$;
revoke all on function app.sms_compose_core(uuid, uuid, text) from public, anon, authenticated, service_role;
