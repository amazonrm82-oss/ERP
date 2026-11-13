-- =============================================================================
-- EML-01 (owner's answer (268) א, Resend; wave 3 use (1); owner (195) א): the email composer, the database half of the
-- Resend sender
-- =============================================================================
-- Resend is the email provider (one Mexuz platform account; the owner sets its key in Vercel). Its adapter
-- (src/features/messaging/providers/resend.ts) needs, for one claimed message.send job on channel email, the address, the
-- subject, the text, the reply-to address and the Storage paths of the files to attach. They come from ONE function,
-- service_role only, so the address, the files and every check are the database's, never the app's:
--
--   public.email_job_compose(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
--     {to, from_name, subject, text, reply_to: text | null, list_unsubscribe: text | null,
--      links: [https URL], attachments: [{bucket, path, name, type}]}   or   {refused: <code>}
--
-- This is the function owner (195) א approved with EML-02 (the header of 021198, "Approved for later"), built on the SMS
-- composer's shape (021247, app.sms_compose_core):
-- * Only for the holder of the job's LIVE lease that public.job_message_may_send already passed (send_checked_lease = the
--   lease), of a counted message.send job, once per lease (app.jobs.composed_lease), the job row FOR UPDATE. Anything else
--   answers {refused: 'stale'} and changes nothing. A job of another channel answers 'not_email'.
-- * The worker calls it right after job_message_may_send answered may_send, and only for a provider that composes (Resend;
--   the fake does not). A refusal ends the job (finish_job, final, provider null, the code kept), as the SMS path; the
--   refusals 'stale', 'paused' and 'site_url' are not final. No queue function changes (test 284's pins hold).
-- * The record (lead or contact, live, FOR KEY SHARE) and its CURRENT primary email, the address job_message_may_send judged
--   (btrim of the same column); a deal's email: the deal still live and its contact still the job's contact (EML-02). The
--   address must have a plain shape (app.email_address_ok: one @, no space, control character, comma, angle bracket or
--   quote), else 'bad_address'. The type's consent rule is judged again on that address: app.consent_service_blocked for a
--   service type, app.consent_suppressed + app.consent_granted otherwise; null = refused.
-- * The business (writable, HEB-09's pause again), the template (still there, still an email template of the job's type,
--   app.message_template_sendable), and every "THE FUTURE SENDER" condition of the job's type, as app.sms_compose_core
--   applies them: CAL-12 (meeting re-read, {קישור} through public.meeting_reminder_link), SGN-03 (document re-read,
--   {קישור} from app.signature_link_issue), COL-07 (app.collection_customer_refusal with the stage's offset), PKG-03 / PKG-06
--   (card, customer_messages switch), SPD-04 (key, form switch, submission re-read, the typed email still the record's),
--   RET-02 (request re-read by id, key, switch, the outside-link switch, the stored link only).
-- * EML-02 / AUT-08 (a card's or a rule's email): a template the system sends itself (notice_kind) is never sent from a card
--   or a rule ('template_changed'); a collection email needs the plan keys collection, documents and payments again.
-- * Attachments (owner (195) א), judged on the send day: every record file (`file_ids`) still confirmed, still a file of
--   the record the email is for (the deal's for a deal's email), and not on a note that is now private unless the sending
--   person wrote it or is an active owner or admin; every library file (`library_file_ids`) still the current file (newest
--   confirmed) of its item, the item of kind file, active and valid today in the business's zone, and only on a person's
--   card send (never an automation's, owner (198) ב); together within app.record_email_max_bytes(). Any file that no longer
--   holds: the message is not sent ('attachment_changed' / 'attachments_too_large'). Only {bucket, path, name, type} go out;
--   the adapter reads Storage objects only at those paths (bucket record-files).
-- * Marketing types (every type not in app.service_message_types(), review_request included) get the envelope of
--   marketingEnvelope() for a channel with a subject: "פרסומת: " in front of the subject unless it starts with "פרסומת", the
--   sender line and the unsubscribe line appended to the body (app.email_marketing_subject / app.email_marketing_body), the
--   {קישור הסרה} link through public.consent_preference_link_for_job, and list_unsubscribe (RFC 8058's one-click address,
--   the POST route /api/forms/unsub/<token>) for the List-Unsubscribe headers. A service email gets neither.
-- * The fill is app.sms_fill (= fillMessage()), on the subject and on the body; a merge field left without a value refuses
--   ('unfilled_field', judged on the template, app.sms_unfilled_in); then app.message_filled_problem('email', ...) on the
--   body as it goes out; the filled subject must hold no control character ('bad_subject') and at most 255 characters
--   ('subject_too_long').
-- * Links are minted LAST, after every check passed with placeholders of the tokens' exact length (64 characters).
--   `links` lists the exact https URLs the composer itself put in the text (the minted meeting, signature and unsubscribe
--   links, the stored review link): the adapter makes only those clickable in the HTML part, so an address a customer typed
--   into a name or a form field stays plain text (review of EML-01, finding 1).
-- * reply_to: the email of the person who sent it from the card (`reply_to_user_id`) while they are an active member of
--   the business and their address has a plain shape, else null. from_name: the business's display name
--   (organizations.name); the address the email goes out from is the platform's (the adapter's RESEND_FROM).
-- * Usage: job_message_may_send counted the job once in app.message_usage_days (MSG-05's caps read it). A refused email (any
--   refusal but 'stale'), and one the adapter says never reached Resend (public.email_quota_return), gives the count back to
--   the day the composer stamped (app.jobs.email_counted_on), once (app.email_usage_give_back), as owner (326) ב for SMS.
-- The checks live in app.email_compose_core (no grants); public.email_job_compose is the wrapper. Every statement is safe
-- to run twice; no row is removed here.

-- ----------------------------------------------------------------------------
-- The business day the send check counted an email job on (stamped by the composer's first read; no grants: app.jobs
-- holds ids, codes and dates only)
-- ----------------------------------------------------------------------------
alter table app.jobs add column if not exists email_counted_on date;

-- ----------------------------------------------------------------------------
-- An email address the adapter may hand to the provider: one @, something on both sides, no space or control character,
-- no comma, semicolon, angle bracket, quote or backslash (nothing that changes a header's meaning), at most 254 characters
-- ----------------------------------------------------------------------------
create or replace function app.email_address_ok(p_address text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_address is not null
     and char_length(p_address) between 3 and 254
     and p_address ~ '^[^@[:space:][:cntrl:],;<>"''\\()]+@[^@[:space:][:cntrl:],;<>"''\\()]+[.][^@[:space:][:cntrl:],;<>"''\\().]+$'
$$;
revoke all on function app.email_address_ok(text) from public, anon, authenticated, service_role;

-- = marketingEnvelope() for an email (src/features/message-templates/envelope.ts): the subject with "פרסומת: " in front
-- unless it starts with "פרסומת"
create or replace function app.email_marketing_subject(p_subject text) returns text
language sql immutable
set search_path = ''
as $$
  select case when left(regexp_replace(coalesce(p_subject, ''), '^[[:space:]]+', ''), char_length('פרסומת')) = 'פרסומת'
              then coalesce(p_subject, '')
              else 'פרסומת: ' || regexp_replace(coalesce(p_subject, ''), '^[[:space:]]+', '') end
$$;
revoke all on function app.email_marketing_subject(text) from public, anon, authenticated, service_role;

-- = marketingEnvelope()'s body for a channel with a subject: the sender line unless a line is exactly it, the unsubscribe
-- line unless the body holds {קישור הסרה}; nothing in front
create or replace function app.email_marketing_body(p_body text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_sender constant text := '{שם העסק} · {טלפון העסק} · {כתובת העסק}';
  v_unsubscribe constant text := '{קישור הסרה}';
  v_body text := coalesce(p_body, '');
  v_tail text[] := '{}';
begin
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
revoke all on function app.email_marketing_body(text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The composer
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
  v_rep := coalesce(v_sender,
                    case when (v_job.payload ->> 'pressed_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         then (v_job.payload ->> 'pressed_by_user_id')::uuid end,
                    v_owner);

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
    (select nullif(btrim(coalesce(p.full_name, '')), '') from public.profiles p
       join public.memberships ms on ms.user_id = p.id and ms.organization_id = v_org.id and ms.status = 'active'
      where p.id = v_rep));

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
-- A message that is not sent gives its count back (owner (326) ב's rule, for email)
-- ----------------------------------------------------------------------------
-- job_message_may_send counted the job once in app.message_usage_days (MSG-05's caps read it). A refused email, or one that
-- never reached Resend, gives it back, once, to the day the composer stamped (email_counted_on); an unknown day gives
-- nothing back. usage_counted turns false, so a later try is counted again by the send check. Never below 0.
create or replace function app.email_usage_give_back(p_job uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_marketing boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'message.send' or not v_job.usage_counted or v_job.email_counted_on is null
     or (v_job.payload ->> 'channel') is distinct from 'email' then
    return false;
  end if;
  v_marketing := not coalesce((v_job.payload ->> 'message_type') = any (app.service_message_types()), false);
  update app.message_usage_days u
     set marketing = greatest(u.marketing - case when v_marketing then 1 else 0 end, 0),
         service = greatest(u.service - case when v_marketing then 0 else 1 end, 0)
   where u.organization_id = v_job.organization_id and u.channel = 'email' and u.day = v_job.email_counted_on;
  update app.jobs j set usage_counted = false, email_counted_on = null where j.id = p_job;
  return true;
end;
$$;
revoke all on function app.email_usage_give_back(uuid) from public, anon, authenticated, service_role;

-- The composer the worker calls: the core's answer as it is, and on every refusal but 'stale' the count given back
create or replace function public.email_job_compose(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_answer jsonb;
begin
  v_answer := app.email_compose_core(p_job, p_lease, p_site_url);
  if v_answer ? 'refused' and (v_answer ->> 'refused') is distinct from 'stale' then
    perform app.email_usage_give_back(p_job);
  end if;
  return v_answer;
end;
$$;
revoke all on function public.email_job_compose(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.email_job_compose(uuid, uuid, text) to service_role;

-- The adapter's path for an email that never reached Resend (no connection, a request it refused before sending): the
-- holder of the live lease the send check passed only; answers {returned: true|false} or {refused: 'stale'}
create or replace function public.email_quota_return(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
begin
  select * into v_job from app.jobs j where j.id = p_job;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now()
     or v_job.send_checked_lease is distinct from p_lease or (v_job.payload ->> 'channel') is distinct from 'email' then
    return jsonb_build_object('refused', 'stale');
  end if;
  return jsonb_build_object('returned', app.email_usage_give_back(p_job));
end;
$$;
revoke all on function public.email_quota_return(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_quota_return(uuid, uuid) to service_role;
