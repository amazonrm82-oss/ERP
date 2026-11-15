-- EML-02, the owner's first live send (15 November 2026, docs/DECISIONS.md "בדיקת השליחה הראשונה"): two emails sent from a
-- contact's card both ended 'unfilled_field' at the composer, because their templates (MSG-02's defaults) hold fields a card
-- send never fills ({קישור להצעה} and {תוקף} belong to a send from the quote screen, {תוכן העדכון} is typed by a person). The
-- failure was recorded (timeline line, the owners' bell notice) but the card's send dialog said only "ממתין לשליחה". The
-- lead's decisions, until the owner says otherwise:
--
-- * One closed list of the fields a card's or an automation's message fills: app.card_message_fields() (= CARD_MESSAGE_FIELDS
--   in src/features/message-templates/card-fields.ts; tests/unit/card-fields.test.ts reads this file, and both run the shared
--   fixture tests/unit/fixtures/card-unfillable-fields.json): first name, full name, the rep's name, the business's name,
--   phone and address. A marketing template's {קישור הסרה} is filled too (the composer mints it). app.card_unfillable_fields
--   (type, subject, body) names, in order and once each, every merge field outside that list; a field inside an optional part
--   ("{, ב-{מיקום}}") is not counted, because the composer leaves out such a part when it has no value.
-- * Such a template is refused before it is queued: app.record_email_enqueue (021224's body) and app.record_sms_enqueue
--   (021218's body) raise P0001 hint 'record_message:unfillable_field' with the missing fields as the detail; the two refusal
--   helpers app.record_email_template_refusal (021224's body) and app.record_sms_template_refusal (021218's body) answer
--   'unfillable_field' last, so an automation's send_email / send_sms step refuses it at run time too (the builder refuses it
--   at save, src/features/automations/send-email.ts / send-sms.ts). Nothing is typed in the dialog: the queue holds ids only
--   (owner (55) א).
-- * {שם הנציג}: app.email_compose_core (021278's body) and app.sms_compose_core (021247's body) take, for a card send, the
--   person who sent it (unchanged: their profile name while an active member), and for an automation's message (button runs
--   too) the record's owner, a deal's message the deal's owner (021278's reply-to rule, owner (8) ב), while an active member
--   who is not a viewer; else no value, and the message refuses as before. Every other line of both bodies is unchanged
--   (tests 367 and 352 pin them by md5).
-- * The failure is visible: public.record_email_queue (021198's body) and public.record_sms_queue (021202's body) answer reason
--   'unfilled' for a message the composer refused for a field without a value; and the person who sent it (a card send, or a
--   button press) gets a 'system' notice too when they are not an owner or an admin (who are told by app.message_send_refused),
--   through an AFTER trigger on public.messages, outside the pinned app.jobs_record_message.
-- The owner's feedback on the same day:
-- * A marketing message carries the envelope's business line "{שם העסק} · {טלפון העסק} · {כתובת העסק}"; without the document
--   settings' address (address line or city) or a phone (the documents' phone, else the business phone) the composer refuses
--   it 'unfilled_field' (RVW-89's rule, src/features/message-sending/marketing-details.ts). app.marketing_details_missing(org)
--   answers what is missing ('address', 'phone'); both enqueues raise P0001 hint 'record_message:business_details' (detail:
--   the missing parts) and the two refusal helpers answer 'business_details' for a marketing template meanwhile.
-- * Changing the business's sending hours (org_message_settings window_from, window_until, skip_rest_days) judges again the
--   message jobs now waiting for the window: public.job_message_may_send (pinned, unchanged) marks exactly such a job
--   status 'queued' with last_error 'waiting:sending_hours' and next_run_at = the opening, and app.message_move_waiting 'hours'
--   marks the business's other jobs the same way. Trigger org_message_settings_rejudge_hours sets next_run_at = now() on the
--   business's own such jobs whose time is still ahead, at most 5,000 a change, rows a worker holds skipped (skip locked), so
--   the send check judges them again by the new hours on the next claim (a job beyond the bound keeps its old opening, where
--   it is judged anyway). A cap, rate or pause waiter carries another mark and is never touched.
-- Every statement is safe to run twice; no row is removed here.

-- ----------------------------------------------------------------------------
-- The fields a card's or an automation's message fills
-- ----------------------------------------------------------------------------
create or replace function app.card_message_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק']::text[]
$$;
revoke all on function app.card_message_fields() from public, anon, authenticated, service_role;

-- the merge fields of a template that a card's or an automation's message leaves without a value, in order, once each
create or replace function app.card_unfillable_fields(p_type text, p_subject text, p_body text) returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(f.name order by f.first), '{}'::text[])
    from (select m.m[1] as name, min(m.ord) as first
            from regexp_matches(
                   -- an optional part without a value disappears (app.sms_fill's first pass), so its field is not counted
                   regexp_replace(coalesce(p_subject, '') || chr(10) || coalesce(p_body, ''),
                                  '\{[^{}:|\n]{0,20}\{[^{}:|\n]{1,30}\}[^{}:|\n]{0,20}\}', '', 'g'),
                   '\{([^{}:|\n]{1,30})\}', 'g') with ordinality as m(m, ord)
           where m.m[1] = any (app.message_merge_fields())
             and not m.m[1] = any (app.card_message_fields())
             -- a marketing message's unsubscribe link is minted by the composer
             and not (m.m[1] = 'קישור הסרה' and not coalesce(p_type, 'marketing') = any (app.service_message_types()))
           group by m.m[1]) f
$$;
revoke all on function app.card_unfillable_fields(text, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- What a marketing message's envelope still needs from the business's details (the composers' rule)
-- ----------------------------------------------------------------------------
create or replace function app.marketing_details_missing(p_org uuid) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select array_remove(array[
           case when nullif(concat_ws(', ', nullif(btrim(coalesce(s.address_line, '')), ''), nullif(btrim(coalesce(s.city, '')), '')), '') is null
                then 'address' end,
           case when coalesce(nullif(btrim(coalesce(s.phone, '')), ''), nullif(btrim(coalesce(o.phone, '')), '')) is null
                then 'phone' end], null)
    from public.organizations o
    left join public.org_document_settings s on s.organization_id = o.id
   where o.id = p_org
$$;
revoke all on function app.marketing_details_missing(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- New sending hours: the jobs waiting for the window are judged again
-- ----------------------------------------------------------------------------
create or replace function app.org_message_settings_rejudge_hours() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.window_from is not distinct from new.window_from
     and old.window_until is not distinct from new.window_until
     and old.skip_rest_days is not distinct from new.skip_rest_days then
    return null;
  end if;
  update app.jobs j
     set next_run_at = now()
   where j.id in (select w.id from app.jobs w
                   where w.organization_id = new.organization_id and w.kind = 'message.send' and w.status = 'queued'
                     and w.last_error = 'waiting:sending_hours' and w.next_run_at > now()
                   order by w.id
                   limit 5000
                     for update skip locked);
  return null;
end;
$$;
revoke all on function app.org_message_settings_rejudge_hours() from public, anon, authenticated, service_role;

create or replace trigger org_message_settings_rejudge_hours
  after insert or update of window_from, window_until, skip_rest_days on public.org_message_settings
  for each row execute function app.org_message_settings_rejudge_hours();

-- ----------------------------------------------------------------------------
-- The person who sent a message that the business's setup kept from going out is told too
-- ----------------------------------------------------------------------------
create or replace function app.messages_refused_sender_notice() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_user uuid;
  v_reason text;
  v_name text;
  v_what text;
  v_entity text;
  v_entity_id uuid;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  -- the codes app.jobs_record_message tells the owners about: a job that ended failed with no provider
  if new.status <> 'failed' or new.provider is not null or new.job_id is null
     or coalesce(new.provider_error_code, '') not in ('too_long', 'unfilled_field', 'feature_off', 'link_blocked', 'link_invalid')
     or (tg_op = 'UPDATE' and old.status is not distinct from new.status
         and old.provider_error_code is not distinct from new.provider_error_code) then
    return null;
  end if;
  begin
    select j.payload into v_payload from app.jobs j where j.id = new.job_id and j.organization_id = new.organization_id;
    -- the person: a card's email (reply_to_user_id), a card's SMS (sent_by_user_id), a rule's button press (pressed_by_user_id)
    v_user := case when (v_payload ->> 'reply_to_user_id') ~ v_uuid then (v_payload ->> 'reply_to_user_id')::uuid
                   when (v_payload ->> 'sent_by_user_id') ~ v_uuid then (v_payload ->> 'sent_by_user_id')::uuid
                   when (v_payload ->> 'pressed_by_user_id') ~ v_uuid then (v_payload ->> 'pressed_by_user_id')::uuid end;
    -- owners and admins are told by app.message_send_refused; a viewer sends nothing
    if v_user is null or not exists (select 1 from public.memberships ms
                                      where ms.organization_id = new.organization_id and ms.user_id = v_user
                                        and ms.status = 'active' and ms.role not in ('owner', 'admin', 'viewer')) then
      return null;
    end if;
    v_reason := app.message_send_refusal_text(new.provider_error_code);
    if v_reason is null then
      return null;
    end if;
    if (v_payload ->> 'template_id') ~ v_uuid then
      select t.name into v_name from public.message_templates t
       where t.organization_id = new.organization_id and t.id = (v_payload ->> 'template_id')::uuid;
    end if;
    v_what := case new.channel when 'email' then 'האימייל' when 'sms' then 'ה-SMS' else 'השליחה' end;
    if (v_payload ->> 'deal_id') ~ v_uuid then
      v_entity := 'deal';
      v_entity_id := (v_payload ->> 'deal_id')::uuid;
    elsif new.lead_id is not null then
      v_entity := 'lead';
      v_entity_id := new.lead_id;
    else
      v_entity := 'contact';
      v_entity_id := new.contact_id;
    end if;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (new.organization_id, v_user, 'system', 'הודעה ללקוח לא נשלחה',
            case when v_name is not null
                 then format('%s מהתבנית "%s" ששלחתם ללקוח לא נשלח. %s. אפשר לבחור תבנית אחרת, או לבקש מבעלי העסק או ממנהלי המערכת לתקן אותה.',
                             v_what, v_name, v_reason)
                 else format('%s ששלחתם ללקוח לא נשלח. %s.', v_what, v_reason) end,
            v_entity, v_entity_id);
  exception when others then
    -- never fails the message's record (app.jobs_record_message would lose it)
    raise warning 'messages_refused_sender_notice: job % (%)', new.job_id, sqlstate;
  end;
  return null;
end;
$$;
revoke all on function app.messages_refused_sender_notice() from public, anon, authenticated, service_role;

create or replace trigger messages_refused_sender_notice
  after insert or update of status, provider_error_code on public.messages
  for each row execute function app.messages_refused_sender_notice();

-- ----------------------------------------------------------------------------
-- app.record_email_template_refusal: 021224's body, two more codes last ('unfillable_field', 'business_details')
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
  -- EML-02 (15 November 2026): a card's or a rule's message fills only app.card_message_fields(); a template holding
  -- any other field would end 'unfilled_field' at the composer, so it is not queued at all
  if cardinality(app.card_unfillable_fields(v_tpl.message_type, v_tpl.subject, v_tpl.body)) > 0 then
    return 'unfillable_field';
  end if;
  -- EML-02 (owner, 15 November 2026): a marketing message carries the envelope's business line, which needs the document
  -- settings' address and phone (else it ends 'unfilled_field'); it is not queued while they are missing
  if not coalesce(v_tpl.message_type, 'marketing') = any (app.service_message_types())
     and cardinality(app.marketing_details_missing(p_org)) > 0 then
    return 'business_details';
  end if;
  return null;
end;
$$;
revoke all on function app.record_email_template_refusal(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.record_sms_template_refusal: 021218's body, two more codes last ('unfillable_field', 'business_details')
-- ----------------------------------------------------------------------------
create or replace function app.record_sms_template_refusal(p_org uuid, p_template uuid, p_person boolean) returns text
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
  if v_tpl.channel <> 'sms' then
    return 'channel';
  end if;
  -- SGN-03 review M1: a template the system sends itself (notice_kind) is never sent by a person or a rule
  if v_tpl.notice_kind is not null then
    return 'notice_template';
  end if;
  -- review F1: SMS only with the plan's sms flag (every path: the card and the automation step)
  if not app.org_has_feature(p_org, 'sms') then
    return 'feature:sms';
  end if;
  if v_tpl.message_type = any (app.service_message_types()) and not v_tpl.message_type = any (app.record_sms_service_types()) then
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
  -- EML-02 (15 November 2026): a card's or a rule's message fills only app.card_message_fields(); a template holding
  -- any other field would end 'unfilled_field' at the composer, so it is not queued at all
  if cardinality(app.card_unfillable_fields(v_tpl.message_type, v_tpl.subject, v_tpl.body)) > 0 then
    return 'unfillable_field';
  end if;
  -- EML-02 (owner, 15 November 2026): a marketing message carries the envelope's business line, which needs the document
  -- settings' address and phone (else it ends 'unfilled_field'); it is not queued while they are missing
  if not coalesce(v_tpl.message_type, 'marketing') = any (app.service_message_types())
     and cardinality(app.marketing_details_missing(p_org)) > 0 then
    return 'business_details';
  end if;
  return null;
end;
$$;
revoke all on function app.record_sms_template_refusal(uuid, uuid, boolean) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- app.record_email_enqueue: 021224's body, the card's fields and the envelope's details checked after the sendable check
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
  -- EML-02 (15 November 2026): only a template whose every field a card fills (app.card_message_fields()); the hint's
  -- detail names the missing fields
  if cardinality(app.card_unfillable_fields(v_tpl.message_type, v_tpl.subject, v_tpl.body)) > 0 then
    raise exception 'the template holds a field a card cannot fill' using errcode = 'P0001', hint = 'record_message:unfillable_field',
      detail = array_to_string(app.card_unfillable_fields(v_tpl.message_type, v_tpl.subject, v_tpl.body), ', ');
  end if;
  -- EML-02 (owner, 15 November 2026): a marketing email's envelope needs the business's address and phone
  if not v_tpl.message_type = any (app.service_message_types()) and cardinality(app.marketing_details_missing(p_org)) > 0 then
    raise exception 'the business details of the marketing envelope are missing' using errcode = 'P0001',
      hint = 'record_message:business_details', detail = array_to_string(app.marketing_details_missing(p_org), ',');
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
grant execute on function app.record_email_enqueue(uuid, text, uuid, uuid, uuid[], uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- app.record_sms_enqueue: 021218's body, two more refusal branches
-- ----------------------------------------------------------------------------
create or replace function app.record_sms_enqueue(p_org uuid, p_kind text, p_record uuid, p_template uuid)
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
  v_phone text;
  v_type text;
  v_refusal text;
  v_found integer;
  v_payload jsonb;
  v_job uuid;
begin
  if v_user is null or p_org is null or p_record is null or p_template is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'contact', 'deal') then
    raise exception 'unknown record type' using errcode = 'P0001', hint = 'record_sms:kind';
  end if;
  -- the activities_insert rule: a member who may write (never a viewer or a support session) in a writable business, who
  -- reads the record
  if not app.can_write(p_org) then
    raise exception 'not permitted' using errcode = '42501', hint = 'record_sms:not_permitted';
  end if;
  -- review F1: the plan's sms flag (owner question 210; off in every plan for now)
  if not app.org_has_feature(p_org, 'sms') then
    raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:sms';
  end if;

  if p_kind = 'lead' then
    select l.owner_id, l.team_id, l.deleted_at, l.phone_e164 into v_owner, v_team, v_deleted, v_phone
      from public.leads l where l.organization_id = p_org and l.id = p_record;
  elsif p_kind = 'contact' then
    select c.owner_id, c.team_id, c.deleted_at, c.phone_e164 into v_owner, v_team, v_deleted, v_phone
      from public.contacts c where c.organization_id = p_org and c.id = p_record;
    v_contact := p_record;
  else
    select d.owner_id, d.team_id, d.deleted_at, d.contact_id into v_owner, v_team, v_deleted, v_contact
      from public.deals d where d.organization_id = p_org and d.id = p_record;
  end if;
  if not found or v_deleted is not null or not app.record_email_readable(p_org, p_kind, p_record, v_owner, v_team) then
    raise exception 'record not found' using errcode = 'P0001', hint = 'record_sms:not_found';
  end if;
  if p_kind = 'deal' then
    -- the deal's message goes to its contact, who must be live and readable by the sender
    if v_contact is null then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_sms:no_contact';
    end if;
    select c.owner_id, c.team_id, c.deleted_at, c.phone_e164 into v_c_owner, v_c_team, v_c_deleted, v_phone
      from public.contacts c where c.organization_id = p_org and c.id = v_contact;
    if not found or v_c_deleted is not null
       or not app.record_email_readable(p_org, 'contact', v_contact, v_c_owner, v_c_team) then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_sms:no_contact';
    end if;
  end if;
  if nullif(btrim(v_phone), '') is null then
    raise exception 'the record has no phone' using errcode = 'P0001', hint = 'record_sms:no_phone';
  end if;

  v_refusal := app.record_sms_template_refusal(p_org, p_template, true);
  if v_refusal like 'feature:%' then
    raise exception 'feature not in plan' using errcode = 'P0001', hint = v_refusal;
  elsif v_refusal like 'not_sendable:%' then
    raise exception 'the template cannot be sent' using errcode = 'P0001', hint = 'record_sms:not_sendable',
      detail = substr(v_refusal, length('not_sendable:') + 1);
  elsif v_refusal = 'template' then
    raise exception 'template not found' using errcode = 'P0001', hint = 'record_sms:template';
  elsif v_refusal = 'channel' then
    raise exception 'not an SMS template' using errcode = 'P0001', hint = 'record_sms:channel';
  elsif v_refusal = 'type' then
    raise exception 'this type is not sent from a card' using errcode = 'P0001', hint = 'record_sms:type';
  elsif v_refusal = 'notice_template' then
    -- SGN-03 review M1
    raise exception 'the system sends this template itself' using errcode = 'P0001', hint = 'record_message:notice_template';
  elsif v_refusal = 'collection' then
    raise exception 'collection needs the payments right' using errcode = 'P0001', hint = 'record_sms:collection';
  elsif v_refusal = 'business_details' then
    -- EML-02 (owner, 15 November 2026): a marketing SMS's envelope needs the business's address and phone
    raise exception 'the business details of the marketing envelope are missing' using errcode = 'P0001',
      hint = 'record_message:business_details', detail = array_to_string(app.marketing_details_missing(p_org), ',');
  elsif v_refusal = 'unfillable_field' then
    -- EML-02 (15 November 2026): a field a card does not fill; the detail names the missing fields
    raise exception 'the template holds a field a card cannot fill' using errcode = 'P0001', hint = 'record_message:unfillable_field',
      detail = (select array_to_string(app.card_unfillable_fields(t.message_type, t.subject, t.body), ', ')
                  from public.message_templates t where t.organization_id = p_org and t.id = p_template);
  elsif v_refusal is not null then
    raise exception 'the template cannot be sent' using errcode = 'P0001', hint = 'record_sms:not_sendable';
  end if;
  select t.message_type into v_type from public.message_templates t where t.organization_id = p_org and t.id = p_template;

  -- at most 30 a person an hour across every business, counted under a lock of the person so two tabs cannot pass it together
  perform pg_advisory_xact_lock(hashtextextended('record_sms:' || v_user::text, 0));
  -- review (7): a button rule's SMS the person pressed counts too
  v_found := app.record_sms_sent_last_hour(v_user);
  if v_found >= app.record_sms_hourly_limit() then
    raise exception 'too many SMS this hour' using errcode = 'P0001', hint = 'record_sms:rate';
  end if;

  v_payload := jsonb_build_object('channel', 'sms', 'message_type', v_type, 'template_id', p_template, 'sent_by_user_id', v_user)
               || case when p_kind = 'lead' then jsonb_build_object('lead_id', p_record)
                       else jsonb_build_object('contact_id', v_contact) end
               || case when p_kind = 'deal' then jsonb_build_object('deal_id', p_record) else '{}'::jsonb end;
  v_job := app.enqueue_job(p_org, 'message.send', v_payload, null);
  return jsonb_build_object('job_id', v_job, 'paused', coalesce(app.customer_sending_paused(p_org), false));
end;
$$;
revoke all on function app.record_sms_enqueue(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function app.record_sms_enqueue(uuid, text, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- app.email_compose_core: 021278's body, the rep of {שם הנציג} only
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
      -- EML-02 (15 November 2026): an automation's rep is an active member who is not a viewer
      where p.id = v_rep and (not (v_job.payload ? 'automation_id') or ms.role <> 'viewer')));

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
-- app.sms_compose_core: 021247's body, the rep of {שם הנציג} only
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
      -- EML-02 (15 November 2026): an automation's rep is an active member who is not a viewer
      where p.id = v_rep and (not (v_job.payload ? 'automation_id') or ms.role <> 'viewer')));

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
-- public.record_email_queue: 021198's body, reason 'unfilled'
-- ----------------------------------------------------------------------------
create or replace function public.record_email_queue(p_org uuid, p_kind text, p_record uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_team uuid;
begin
  -- members who may send from a card (never a viewer; a support session has no membership role)
  if auth.uid() is null or p_org is null or p_record is null
     or coalesce(app.membership_role(p_org)::text, 'viewer') = 'viewer' then
    return '[]'::jsonb;
  end if;
  if p_kind = 'lead' then
    select l.owner_id, l.team_id into v_owner, v_team from public.leads l where l.organization_id = p_org and l.id = p_record;
  elsif p_kind = 'contact' then
    select c.owner_id, c.team_id into v_owner, v_team from public.contacts c where c.organization_id = p_org and c.id = p_record;
  elsif p_kind = 'deal' then
    select d.owner_id, d.team_id into v_owner, v_team from public.deals d where d.organization_id = p_org and d.id = p_record;
  else
    return '[]'::jsonb;
  end if;
  if not found or not app.record_email_readable(p_org, p_kind, p_record, v_owner, v_team) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'job_id', j.id,
             'created_at', j.created_at,
             'template_name', t.name,
             'sender_id', (j.payload ->> 'reply_to_user_id'),
             'files', coalesce(jsonb_array_length(j.payload -> 'file_ids'), 0)
                      + coalesce(jsonb_array_length(j.payload -> 'library_file_ids'), 0),
             'state', case when j.status = 'done' then 'sent'
                           when j.status in ('queued', 'running', 'failed') then 'waiting'
                           else 'not_sent' end,
             'reason', case when j.status in ('refused', 'dead') then
                              case when j.last_error like 'refused:consent%' then 'consent'
                                   -- EML-02 (15 November 2026): the composer found a field without a value
                                   when j.provider is null and j.provider_error_code = 'unfilled_field' then 'unfilled'
                                   when j.last_error = 'refused:pause_expired' then 'paused'
                                   else 'other' end
                       end)
           order by j.created_at desc, j.id)
      from (select * from app.jobs j
             where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'reply_to_user_id'
               and j.created_at > now() - interval '30 days'
               -- only emails sent from this record's own card: a deal's email shows on the deal, not on its contact
               and case p_kind when 'lead' then j.payload ->> 'lead_id' = p_record::text
                               when 'contact' then j.payload ->> 'contact_id' = p_record::text and not (j.payload ? 'deal_id')
                               else j.payload ->> 'deal_id' = p_record::text end
             order by j.created_at desc, j.id
             limit 20) j
      left join public.message_templates t
        on t.organization_id = j.organization_id and t.id::text = j.payload ->> 'template_id'), '[]'::jsonb);
end;
$$;
revoke all on function public.record_email_queue(uuid, text, uuid) from public, anon;
grant execute on function public.record_email_queue(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- public.record_sms_queue: 021202's body, reason 'unfilled'
-- ----------------------------------------------------------------------------
create or replace function public.record_sms_queue(p_org uuid, p_kind text, p_record uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_team uuid;
begin
  -- members who may send from a card (never a viewer; a support session has no membership role)
  if auth.uid() is null or p_org is null or p_record is null
     or coalesce(app.membership_role(p_org)::text, 'viewer') = 'viewer' then
    return '[]'::jsonb;
  end if;
  if p_kind = 'lead' then
    select l.owner_id, l.team_id into v_owner, v_team from public.leads l where l.organization_id = p_org and l.id = p_record;
  elsif p_kind = 'contact' then
    select c.owner_id, c.team_id into v_owner, v_team from public.contacts c where c.organization_id = p_org and c.id = p_record;
  elsif p_kind = 'deal' then
    select d.owner_id, d.team_id into v_owner, v_team from public.deals d where d.organization_id = p_org and d.id = p_record;
  else
    return '[]'::jsonb;
  end if;
  if not found or not app.record_email_readable(p_org, p_kind, p_record, v_owner, v_team) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'job_id', j.id,
             'created_at', j.created_at,
             'template_name', t.name,
             'sender_id', (j.payload ->> 'sent_by_user_id'),
             'state', case when j.status = 'done' then 'sent'
                           when j.status in ('queued', 'running', 'failed') then 'waiting'
                           else 'not_sent' end,
             'reason', case when j.status in ('refused', 'dead') then
                              case when j.last_error like 'refused:consent%' then 'consent'
                                   -- EML-02 (15 November 2026): the composer found a field without a value
                                   when j.provider is null and j.provider_error_code = 'unfilled_field' then 'unfilled'
                                   when j.last_error = 'refused:pause_expired' then 'paused'
                                   else 'other' end
                       end)
           order by j.created_at desc, j.id)
      from (select * from app.jobs j
             where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'sent_by_user_id'
               and j.created_at > now() - interval '30 days'
               -- only SMS sent from this record's own card: a deal's SMS shows on the deal, not on its contact
               and case p_kind when 'lead' then j.payload ->> 'lead_id' = p_record::text
                               when 'contact' then j.payload ->> 'contact_id' = p_record::text and not (j.payload ? 'deal_id')
                               else j.payload ->> 'deal_id' = p_record::text end
             order by j.created_at desc, j.id
             limit 20) j
      left join public.message_templates t
        on t.organization_id = j.organization_id and t.id::text = j.payload ->> 'template_id'), '[]'::jsonb);
end;
$$;
revoke all on function public.record_sms_queue(uuid, text, uuid) from public, anon;
grant execute on function public.record_sms_queue(uuid, text, uuid) to authenticated;
