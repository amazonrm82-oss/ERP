-- =============================================================================
-- SMS-05 (owner's answer (318) א, 12 November 2026): the SMS composer, the database half of the InforU sender
-- =============================================================================
-- InforU is the SMS provider (one Mexuz platform account, answer (207) א). Its adapter (src/features/messaging/providers/
-- inforu.ts) needs, for one claimed message.send job, the number, the sender and the text. They come from ONE function,
-- service_role only, so the address and every check are the database's, never the app's:
--
--   public.sms_job_compose(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
--     {to: '+9725...', sender: text | null, text: text}   or   {refused: <code>}
--
-- * Only for the holder of the job's LIVE lease that public.job_message_may_send already passed (send_checked_lease =
--   the lease), of a message.send job on channel sms. Anything else answers {refused: 'stale'} and changes nothing.
-- * The worker calls it right after job_message_may_send answered may_send, and only for a provider that composes (InforU;
--   the fake does not). A refusal ends the job (finish_job, final, provider null, the code as provider_error_code), so the
--   timeline shows the message as not sent, and 'too_long' tells the owners and admins (app.jobs_record_message, as before).
--   No queue function changes (test 284's pins hold).
-- * It re-reads the record (lead or contact, live, its CURRENT phone_e164), the business (writable, HEB-09's pause again)
--   and the template (still there, still an SMS template of the job's type), asks app.message_template_sendable, and then
--   applies every "THE FUTURE SENDER" condition of the job's type (CLAUDE.md; each branch below names its source):
--     meeting_reminder   CAL-12: its app.meeting_customer_messages row, the meeting still planned, not a block, at the row's
--                        start and in the future, with the job's customer; the business writable with `meeting_reminders`
--                        and the kind's switch still on; {קישור} through public.meeting_reminder_link.
--     requested_document SGN-03 (with signature_document_id): the document still sent or viewed, not expired or erased,
--                        attached to the job's customer, the switch and `signatures` still on, this job its reminder's job;
--                        {קישור} minted with app.signature_link_issue (it replaces the document's earlier link, as 021218
--                        says). Without signature_document_id (a card or a rule): the plain fields only.
--     collection         COL-07 (with collection_document_id): app.collection_customer_refusal with the stage's offset from
--                        app.collection_reminders_sent by customer_job_id; {סכום} = the balance now, {מסמך}, {מועד תשלום}.
--     punch_card_notice  PKG-03 / PKG-06: the card still active, of the job's business, held or paid for by the job's contact.
--     instant_reply      SPD-04: `instant_reply` key, the form's switch, the submission re-read, the record's phone still the
--                        typed one, this job the submission's reply; {שעה} = event_at in the business zone.
--     review_request     RET-02: the request re-read by id (this job its job), the person from the request (equal to the
--                        payload's), `review_requests` key, the switch on, the stored link passing app.review_url_ok, the
--                        platform's outside-link switch (app.qr_external_off) off; {קישור לביקורת} = the stored link only;
--                        no rating step anywhere.
--     verification_code  SMS-01b: the code from public.sms_sender_code_issue, to the check's own phone, from the platform
--                        default sender (the number is not verified yet), the fixed text of owner (323) ב.
--     marketing (or none) the envelope (MSG-02 marketingEnvelope, mirrored by app.sms_marketing_envelope) and {קישור הסרה}
--                        through public.consent_preference_link_for_job (CNS-09).
--   review_request is a marketing type (CNS-07), so it also gets the envelope and the unsubscribe link (owner (321) א;
--   marketingEnvelope() does the same for every non-service type).
-- * The fill is the database's: app.sms_fill mirrors fillMessage() (optional parts, then the HEB-01 gender blocks through
--   app.document_pick_variants, then the merge fields), one pass each, so a value is never read again as a field; both run
--   tests/unit/fixtures/sms-fill.json. The customer's values go in only in the last pass (review (7)): a value holding
--   "{...}" is never read as a field or a gender block. A merge field left without a value refuses ('unfilled_field', judged
--   on the template by app.sms_unfilled_in), never a "{סכום}" to a customer. Then app.message_filled_problem on the text as it goes out.
-- * Links are minted LAST: the text is first filled with a placeholder of the token's exact length (every token is 64
--   characters) and judged; only a text that passes mints its links (a mint replaces the customer's earlier link), and the
--   text is filled again with them. p_site_url is the app's own origin (NEXT_PUBLIC_SITE_URL), https only (http only for
--   localhost); without one a text that needs a link refuses ('site_url').
-- * The sender: app.sms_effective_sender (an approved letter name, else the verified own number), else null = the platform
--   account's default (the adapter's INFORU_SENDER).
-- * Review (1): the record is taken FOR KEY SHARE, its typed phone normalized must be the phone_e164 returned (the one
--   job_message_may_send judged), and the type's consent rule is judged again on it: app.consent_service_blocked for a
--   service type, app.consent_suppressed + app.consent_granted otherwise; null = refused.
-- * Refusals 'stale', 'paused' and 'site_url' are not final (the worker tries the job again later); every other ends it.
-- * Owner (326) ב: a refused message (every refusal but 'stale') gives its count back to the business's month and day
--   (app.sms_usage_give_back, through the public wrapper below); public.sms_quota_return does the same for a message the
--   adapter never got to the provider. The checks themselves live in app.sms_compose_core (no grants).
-- No row is deleted here. No statement starts with drop. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Delta review (2), (4): two server-only columns on the queue (no grants; app.jobs holds ids, codes and dates only)
-- ----------------------------------------------------------------------------
-- sms_counted_on: the business day the send check counted the job on, stamped by the composer's first read of a counted
--   job (job_message_may_send counted it a moment before, in the same worker call; its body and app.jobs' triggers are
--   pinned by test 284, so neither changes). The give-back returns the count to that day and its month, and to nothing
--   when it is unknown. composed_lease: the lease a composer answered for, so the same lease is never composed twice.
alter table app.jobs add column if not exists sms_counted_on date;
alter table app.jobs add column if not exists composed_lease uuid;

-- ----------------------------------------------------------------------------
-- Dates and amounts as an SMS writes them
-- ----------------------------------------------------------------------------
create or replace function app.sms_hebrew_date(p_day date, p_weekday boolean) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_day is null then null else
    case when p_weekday
         then 'יום ' || (array['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'])[extract(dow from p_day)::integer + 1] || ', '
         else '' end
    || extract(day from p_day)::integer::text || ' ב'
    || (array['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר',
              'דצמבר'])[extract(month from p_day)::integer]
    || case when p_weekday then '' else ' ' || extract(year from p_day)::integer::text end
  end
$$;
revoke all on function app.sms_hebrew_date(date, boolean) from public, anon, authenticated, service_role;

create or replace function app.sms_amount_text(p_agorot bigint) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_agorot is null then null else
    to_char(abs(p_agorot) / 100, 'FM999,999,999,999,990')
    || case when abs(p_agorot) % 100 = 0 then '' else '.' || lpad((abs(p_agorot) % 100)::text, 2, '0') end
    || ' ₪'
  end
$$;
revoke all on function app.sms_amount_text(bigint) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The fill: = fillMessage() (src/features/message-templates/fields.ts)
-- ----------------------------------------------------------------------------
-- p_values: merge field name (without braces) -> text or null. A name present = "given" (an optional part with an empty
-- value disappears); absent = not given (the part stays as written), as fillOptionalParts.
create or replace function app.sms_fill(p_text text, p_values jsonb, p_gender text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_fields text[] := app.message_merge_fields();
  v_text text := coalesce(p_text, '');
  v_parts text[];
  v_out text;
  v_match record;
  v_value text;
begin
  -- 1. optional parts {before{field}after}
  v_parts := regexp_split_to_array(v_text, '\{[^{}:|\n]{0,20}\{[^{}:|\n]{1,30}\}[^{}:|\n]{0,20}\}');
  v_out := v_parts[1];
  for v_match in
    select t.m, t.ord
      from regexp_matches(v_text, '\{([^{}:|\n]{0,20})\{([^{}:|\n]{1,30})\}([^{}:|\n]{0,20})\}', 'g') with ordinality as t(m, ord)
     order by t.ord
  loop
    if v_match.m[2] = any (v_fields) and coalesce(p_values, '{}'::jsonb) ? v_match.m[2] then
      v_value := nullif(btrim(coalesce(p_values ->> v_match.m[2], ''), E' \t\n\r'), '');
      -- review (7): the token stays; the value goes in only in step 3, so a value is never read as a field or a block
      v_out := v_out || case when v_value is null then '' else v_match.m[1] || '{' || v_match.m[2] || '}' || v_match.m[3] end;
    else
      v_out := v_out || '{' || v_match.m[1] || '{' || v_match.m[2] || '}' || v_match.m[3] || '}';
    end if;
    v_out := v_out || coalesce(v_parts[v_match.ord + 1], '');
  end loop;
  -- 2. HEB-01 gender blocks (the SGN-02 mirror of pickVariants)
  v_text := app.document_pick_variants(v_out, p_gender);
  -- 3. the merge fields
  v_parts := regexp_split_to_array(v_text, '\{[^{}:|\n]{1,30}\}');
  v_out := v_parts[1];
  for v_match in
    select t.m, t.ord from regexp_matches(v_text, '\{([^{}:|\n]{1,30})\}', 'g') with ordinality as t(m, ord) order by t.ord
  loop
    v_value := case when v_match.m[1] = any (v_fields)
                    then nullif(btrim(coalesce(p_values ->> v_match.m[1], ''), E' \t\n\r'), '') end;
    v_out := v_out || coalesce(v_value, '{' || v_match.m[1] || '}') || coalesce(v_parts[v_match.ord + 1], '');
  end loop;
  return v_out;
end;
$$;
revoke all on function app.sms_fill(text, jsonb, text) from public, anon, authenticated, service_role;

-- Whether a filled text still holds a merge field (a field the sender had no value for). Judged on the template, never on
-- the customer's values (review (7)): app.sms_unfilled_in fills every given value with 'x' first.
create or replace function app.sms_unfilled(p_text text) returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (select 1 from regexp_matches(coalesce(p_text, ''), '\{([^{}:|\n]{1,30})\}', 'g') m
                  where m[1] = any (app.message_merge_fields()))
$$;
revoke all on function app.sms_unfilled(text) from public, anon, authenticated, service_role;

create or replace function app.sms_unfilled_in(p_text text, p_values jsonb, p_gender text) returns boolean
language sql immutable
set search_path = ''
as $$
  select app.sms_unfilled(app.sms_fill(p_text,
    (select coalesce(jsonb_object_agg(e.key, case when nullif(btrim(coalesce(e.value, ''), E' \t\n\r'), '') is null
                                                  then null else 'x' end), '{}'::jsonb)
       from jsonb_each_text(coalesce(p_values, '{}'::jsonb)) e), p_gender))
$$;
revoke all on function app.sms_unfilled_in(text, jsonb, text) from public, anon, authenticated, service_role;

-- = marketingEnvelope() for a channel without a subject (src/features/message-templates/envelope.ts): "פרסומת: " in front
-- unless the text starts with "פרסומת", the sender line unless a line is exactly it, the unsubscribe line unless the text
-- holds {קישור הסרה}
create or replace function app.sms_marketing_envelope(p_body text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_sender constant text := '{שם העסק} · {טלפון העסק} · {כתובת העסק}';
  v_unsubscribe constant text := '{קישור הסרה}';
  v_trimmed text := regexp_replace(coalesce(p_body, ''), '^[[:space:]]+', '');
  v_body text;
  v_tail text[] := '{}';
begin
  v_body := case when left(v_trimmed, char_length('פרסומת')) = 'פרסומת' then coalesce(p_body, '') else 'פרסומת: ' || v_trimmed end;
  if not exists (select 1 from regexp_split_to_table(v_body, E'\n') line where btrim(line, E' \t\r') = v_sender) then
    v_tail := v_tail || v_sender;
  end if;
  if strpos(v_body, v_unsubscribe) = 0 then
    v_tail := v_tail || ('להסרה מרשימת התפוצה: ' || v_unsubscribe);
  end if;
  if cardinality(v_tail) > 0 then
    v_body := regexp_replace(v_body, '[[:space:]]+$', '') || E'\n\n' || array_to_string(v_tail, E'\n');
  end if;
  return v_body;
end;
$$;
revoke all on function app.sms_marketing_envelope(text) from public, anon, authenticated, service_role;

-- The fixed text of a sender-number check's code (SMS-01b, owner (323) ב): nothing of a customer
create or replace function app.sms_sender_code_text(p_code text) returns text
language sql immutable
set search_path = ''
as $$
  select 'מקסוז: קוד האימות שלך הוא ' || p_code || '. בתוקף 10 דקות. לא ביקשת קוד? אפשר להתעלם.'
$$;
revoke all on function app.sms_sender_code_text(text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The composer
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
  v_rep := case when (v_job.payload ->> 'sent_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (v_job.payload ->> 'sent_by_user_id')::uuid else v_owner end;
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
    (select nullif(btrim(coalesce(p.full_name, '')), '') from public.profiles p
       join public.memberships ms on ms.user_id = p.id and ms.organization_id = v_org.id and ms.status = 'active'
      where p.id = v_rep));

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

-- ----------------------------------------------------------------------------
-- Owner (326) ב: a message that is not sent gives its count back
-- ----------------------------------------------------------------------------
-- job_message_may_send counted the job once (app.jobs.usage_counted): the business's day in app.message_usage_days and, for
-- every SMS but a verification code, the month in app.sms_quota_months. A message the composer refuses, or one that was
-- not sent (never reached InforU, or refused by it), gives both back, once, to the day the composer stamped
-- (sms_counted_on) and that day's month; an unknown day gives nothing back. usage_counted turns false, so a later try (a
-- job that waits) is counted again by the send check as a new one. Never below 0.
create or replace function app.sms_usage_give_back(p_job uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_type text;
  v_today date;
  v_marketing boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  -- delta review (2): the day the job was counted on; unknown = nothing is given back
  if v_job.id is null or v_job.kind <> 'message.send' or not v_job.usage_counted or v_job.sms_counted_on is null
     or (v_job.payload ->> 'channel') is distinct from 'sms' then
    return false;
  end if;
  v_type := v_job.payload ->> 'message_type';
  v_marketing := not coalesce(v_type = any (app.service_message_types()), false);
  v_today := v_job.sms_counted_on;
  update app.message_usage_days u
     set marketing = greatest(u.marketing - case when v_marketing then 1 else 0 end, 0),
         service = greatest(u.service - case when v_marketing then 0 else 1 end, 0)
   where u.organization_id = v_job.organization_id and u.channel = 'sms' and u.day = v_today;
  if v_type is distinct from 'verification_code' then
    update app.sms_quota_months m set used = greatest(m.used - 1, 0)
     where m.organization_id = v_job.organization_id and m.month = date_trunc('month', v_today)::date;
  end if;
  -- a later try is counted again by the send check, and stamped again by the composer
  update app.jobs j set usage_counted = false, sms_counted_on = null where j.id = p_job;
  return true;
end;
$$;
revoke all on function app.sms_usage_give_back(uuid) from public, anon, authenticated, service_role;

-- The composer the worker calls: the core's answer as it is, and on every refusal but 'stale' (another holder's lease, or
-- none) the count given back (owner (326) ב)
create or replace function public.sms_job_compose(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_answer jsonb;
begin
  v_answer := app.sms_compose_core(p_job, p_lease, p_site_url);
  if v_answer ? 'refused' and (v_answer ->> 'refused') is distinct from 'stale' then
    perform app.sms_usage_give_back(p_job);
  end if;
  return v_answer;
end;
$$;
revoke all on function public.sms_job_compose(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sms_job_compose(uuid, uuid, text) to service_role;

-- The adapter's path for a message that never reached the provider (no connection, a number or text it cannot send): the
-- holder of the live lease the send check passed only; answers {returned: true|false} or {refused: 'stale'}
create or replace function public.sms_quota_return(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
begin
  select * into v_job from app.jobs j where j.id = p_job;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now()
     or v_job.send_checked_lease is distinct from p_lease or (v_job.payload ->> 'channel') is distinct from 'sms' then
    return jsonb_build_object('refused', 'stale');
  end if;
  return jsonb_build_object('returned', app.sms_usage_give_back(p_job));
end;
$$;
revoke all on function public.sms_quota_return(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sms_quota_return(uuid, uuid) to service_role;
