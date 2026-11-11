-- =============================================================================
-- SGN-03: a document's states (sent, viewed, signed, expired), reminders to staff and one to the customer
-- =============================================================================
-- SGN-02 (021212) already keeps sent_at, viewed_at (a view moves sent -> viewed), signed_at and cancelled_at, and an optional
-- expires_at set when sending (1..365 days, default none); an unsigned document past expires_at is shown as expired by
-- the customer's page (public.signature_public, unchanged here) and the staff card. What this file adds:
--
-- * Validity (owner (247) ב): a document sent with N days of validity is valid until the END of the business day of (the
--   sending day in the business zone + N): 23:59:59.999 there (app.signature_valid_until). public.signature_document_send
--   (021212's body, same signature) changes ONLY that expression; the page and the card show the day, never a time.
-- * Expiry (lead's choice, owner's answers kept it): pg_cron `crm-signature-expiry` (every 15 minutes) runs
--   app.expire_signature_documents(): a sent or viewed document whose expires_at has passed gets server-only
--   signature_documents.expired_at (state only: status stays sent | viewed, so public.signature_public,
--   public.signature_public_sign and app.signature_link_usable keep their 021212/021216 bodies; all already treat it as
--   expired). Businesses take turns: at most app.signature_expiry_per_org() (200) a business, app.signature_expiry_limit()
--   (2,000) a run, oldest expiry first, each document in its own exception block (a failure still stamps the state, without
--   the notice). One `system` notice to the sender (active, not a viewer), else the active owners and admins: "פג תוקף של
--   מסמך לחתימה", NOTHING personal in it (no title, no name: the erasure paths of 021212/021216 never need to know it), the
--   record as its entity. A detached or erased document is stamped without a notice.
-- * Staff reminders (owner (248) ב): org_document_settings.signature_reminder_days N (0 = off, 1..30, default 3; owners
--   and admins through column grants; audited by the table's audit trigger) is the interval: the first reminder N business
--   days (CAL-03, app.add_business_days) after the sending day in the business zone, then N business days after the day of
--   the previous reminder, at most 3 per document (app.signature_reminders), from 08:00 in the business zone; stopped when
--   the document is signed, cancelled, expires or is erased, its record is in the bin or detached, the business is not
--   writable or lost the `signatures` key. pg_cron `crm-signature-reminders` runs app.send_signature_reminders(). A first
--   reminder whose day passed more than 7 days ago is never made. Each reminder: while the previous reminder task is still
--   open it is re-dated to that day (lead's choice) and counted, else a NEW task: owner = the sender while an active full-seat
--   non-viewer who reads the record (app.user_can_read_record), else the business owner, else its oldest admin; due 10:00
--   that day (or now, when later); linked to the document's record. Title: "להזכיר ל<name> לחתום על <title>" for a lead or
--   contact (the task is purged with that record, so the copied name goes with it); for a company or a deal "להזכיר ללקוח
--   לחתום על המסמך שנשלח ב-<date>" (a company or deal document can name other people, whose erasure does not reach the task).
--   The assignee gets one notice of the new mutable kind `signature_reminder` (title and body name nothing; the task as its
--   entity; muting the kind mutes the notice, the task stays). The task insert sets app.intake_quiet_task for its owner, so
--   app.notify_assignment does not send an 'assigned' notice beside it. Businesses take turns (200 / 2,000); a failing
--   document is tried again after the fresh ones and skipped after 3 failures in a row (one warning line, id and SQLSTATE).
--   Lock order of a reminder: the document row (skip locked), then its open task row (skip locked; a task someone holds
--   waits for the next run, review L3). An open task whose owner is no longer an active full-seat non-viewer who reads the
--   record is closed ("נסגרה: הועברה לאחראי אחר", delta review D3) and a new task is made by the owner rule (review L5).
--   A reminder task closes itself (trigger signature_documents_reminder_close) when its document is signed, cancelled or
--   expires, while the task is still open: "נסגרה: המסמך נחתם" | "נסגרה: המסמך בוטל" | "נסגרה: פג תוקף המסמך".
-- * The customer's reminder (owner (249) א): ONE per document, 2 calendar days before the last day (the business zone), from
--   08:00, never on the sending day, while the document still waits, on a live lead, contact or deal (a deal's live contact;
--   a company's document has no person and gets none), in a writable business with the key and
--   org_document_settings.signature_customer_reminder on (default ON; owners/admins, column grants). pg_cron
--   `crm-signature-customer-reminders` runs app.send_signature_customer_reminders(). A SERVICE message of type
--   requested_document through the OPS-04 queue (app.enqueue_job; ids and codes only: channel, lead_id | contact_id (+ deal_id),
--   message_type, template_id, signature_document_id (a new optional key of app.job_payload_ok, requested_document only) and
--   event_at = the document's expires_at, so a message held past the last day is cancelled by the send check). The queue's own
--   checks judge it at send time (HEB-09's pause, the blocklist and erasure blocks for service types, MSG-06's sending hours,
--   rates). The channel: the customer's preferred channel when it is SMS or email, else SMS, else email, with an address and an
--   ACTIVE template marked notice_kind 'signature_reminder' on that channel (CAL-12's rule; WhatsApp waits as there).
--   app.message_template_sendable judges the template first; a code queues nothing and tells the owners and admins
--   (app.message_send_refused). Outcomes are kept in app.signature_customer_reminders; anything but 'queued' is tried again on
--   later runs while the window lasts (3 failures in a row skip it). Signing, cancelling or expiry cancels a job still waiting
--   in the queue (refused:document_closed, counted in app.job_cancel_counts).
--   Two DRAFT templates (SMS and email) with wording version 'signature-draft-1' are added to a business the first time the
--   job reaches it (app.seed_signature_reminder_templates; once per business and channel in app.signature_template_seeds, so a
--   deleted one is not brought back), mirrored by DEFAULT_SIGNATURE_REMINDER_TEMPLATES. Merge field {שם המסמך} joins the closed
--   list (app.message_merge_fields(), at the end), mirrored by MESSAGE_MERGE_FIELDS. Review M1: only a requested_document
--   marked 'signature_reminder' may hold {תאריך}, {קישור} and {שם המסמך} (app.message_notice_fields, read by
--   app.message_notice_template_problem through app.message_template_sendable; = NOTICE_KIND_FIELDS), and a template the
--   system sends itself (any notice_kind) is refused on every person's and rule's send path (hint
--   record_message:notice_template on the card's email and SMS; the automation step fails) and hidden from their pickers.
--   A seeding the 50-template cap refuses is recorded as done for that channel, with one warning, and not tried again.
--   Review L4: switching signature_customer_reminder off (or a first settings row saved with it off) cancels the business's reminders still waiting in the queue
--   (refused:reminder_off, counted in app.job_cancel_counts); switching it on again does not queue them again.
--   THE FUTURE SENDER of a requested_document that carries signature_document_id MUST re-read the document by that id, scoped
--   to the job's business, and send nothing unless it is still sent or viewed, not expired (expires_at in the future, no
--   expired_at), not erased, attached to the payload's record (the deal's contact for a deal's document), while the
--   business's org_document_settings.signature_customer_reminder is still on and it still holds the `signatures` key; it fills {שם המסמך}
--   from its title, {תאריך} from expires_at's day in the business zone and {קישור} from a link it mints itself: this file adds
--   NO link function and the queue never holds a token. Minting one replaces the document's earlier link
--   (app.signature_link_issue keeps one per document), so the reminder's link becomes the only one; that function needs its own
--   "In use" line in CLAUDE.md when the sender lands.
-- Every statement is safe to run twice. No statement starts with drop, no row removal. The three `alter table ... drop
-- constraint if exists` re-add notifications_kinds, notification_settings_kinds and message_templates_notice_kind_check
-- with one more value each.

-- ----------------------------------------------------------------------------
-- The expired state (server only, readable like the other columns)
-- ----------------------------------------------------------------------------
alter table public.signature_documents add column if not exists expired_at timestamptz;
grant select (expired_at) on public.signature_documents to authenticated;

-- the expiry job's candidates
create index if not exists signature_documents_expiry_idx on public.signature_documents (expires_at)
  where status in ('sent', 'viewed') and expires_at is not null and expired_at is null;
-- the reminder job's candidates
create index if not exists signature_documents_waiting_idx on public.signature_documents (sent_at)
  where status in ('sent', 'viewed') and expired_at is null and erased_at is null;

-- ----------------------------------------------------------------------------
-- The setting: business days after sending, 0 = off
-- ----------------------------------------------------------------------------
alter table public.org_document_settings add column if not exists signature_reminder_days smallint not null default 3;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_document_settings_signature_reminder_days_check'
                  and conrelid = 'public.org_document_settings'::regclass) then
    alter table public.org_document_settings add constraint org_document_settings_signature_reminder_days_check
      check (signature_reminder_days between 0 and 30);
  end if;
end;
$$;

grant select (signature_reminder_days) on public.org_document_settings to authenticated;
grant insert (signature_reminder_days) on public.org_document_settings to authenticated;
grant update (signature_reminder_days) on public.org_document_settings to authenticated;

-- owner (249) א: the customer's reminder 2 days before the last day; default on
alter table public.org_document_settings add column if not exists signature_customer_reminder boolean not null default true;
grant select (signature_customer_reminder) on public.org_document_settings to authenticated;
grant insert (signature_customer_reminder) on public.org_document_settings to authenticated;
grant update (signature_customer_reminder) on public.org_document_settings to authenticated;

-- ----------------------------------------------------------------------------
-- Validity: the end of the business day of (sending day in the business zone + N days) (owner (247) ב)
-- ----------------------------------------------------------------------------
create or replace function app.signature_valid_until(p_org uuid, p_days integer) returns timestamptz
language sql stable security definer
set search_path = ''
as $$
  select (((now() at time zone z.zone)::date + p_days + 1)::timestamp at time zone z.zone) - interval '1 millisecond'
    from (select app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)) as zone) z
$$;
revoke all on function app.signature_valid_until(uuid, integer) from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- Sending: 021212's body, only the validity's end changed (owner (247) ב)
-- ----------------------------------------------------------------------------
create or replace function public.signature_document_send(
  p_org uuid, p_template uuid, p_record_type text, p_record_id uuid, p_title text, p_body text,
  p_valid_days integer default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_record jsonb;
  v_template public.document_templates;
  v_title text := btrim(coalesce(p_title, ''));
  v_limit numeric;
  v_month date;
  v_sent integer;
  v_doc public.signature_documents;
  v_token text;
  v_field text;
  v_fill jsonb;
begin
  v_record := app.signature_record_row(p_org, p_record_type, p_record_id);
  if p_org is null or v_record is null or (v_record ->> 'deleted_at') is not null
     or not app.can_write(p_org)
     or not app.can_edit_record(p_org, (v_record ->> 'owner_id')::uuid, (v_record ->> 'team_id')::uuid) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the business is read only' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'signatures') then
    raise exception 'signatures are not in the plan' using errcode = 'P0001', hint = 'feature:signatures';
  end if;
  select * into v_template from public.document_templates t
   where t.organization_id = p_org and t.id = p_template and t.is_active and t.record_type = p_record_type;
  if not found then
    raise exception 'pick an active template of this record type' using errcode = 'P0001', hint = 'signature_document:template';
  end if;
  if v_title = '' then
    v_title := v_template.name;
  end if;
  if char_length(v_title) > 120 or v_title ~ '[[:cntrl:]]' then
    raise exception 'the title is too long' using errcode = 'P0001', hint = 'signature_document:title';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 30000 then
    raise exception 'the document is empty or too long' using errcode = 'P0001', hint = 'signature_document:body';
  end if;
  if p_valid_days is not null and p_valid_days not between 1 and 365 then
    raise exception 'the validity is 1 to 365 days' using errcode = 'P0001', hint = 'signature_document:valid_days';
  end if;
  -- delta review (10 November 2026): no bidi controls or invisible characters in what the customer signs, so a hidden
  -- direction mark cannot change how a locked section reads. The server's fill removes them from record values and template
  -- text (app.document_strip_invisible), so any left in the body or the title is what the sender typed: refused.
  if (p_body || v_title) ~ app.document_invisible_class() then
    raise exception 'the document holds invisible or direction characters' using errcode = 'P0001', hint = 'signature_document:invisible';
  end if;
  -- (224) ב: the server's own fill of the template for this record
  v_fill := app.signature_document_fill(p_org, v_template, p_record_id);
  -- every merge field of the record's type must be filled (a customer signs what they read, nothing still in braces), in
  -- the text sent and in the server's fill (deleting a field the record has no value for does not get around it)
  select m[1] into v_field
    from regexp_matches(p_body || E'\n' || (v_fill ->> 'body'), '\{([^{}:|\n]{1,30})\}', 'g') as m
   where m[1] = any (app.document_merge_fields(p_record_type))
   limit 1;
  if v_field is not null then
    raise exception 'a merge field is not filled' using errcode = 'P0001', hint = 'signature_document:unfilled';
  end if;
  -- (224) ב: the free text may be edited; every locked section and every value the server filled in stays, in order
  if not app.signature_anchors_kept(p_body, v_fill -> 'segments') then
    raise exception 'a locked section or a filled value was changed' using errcode = 'P0001', hint = 'signature_document:locked_changed';
  end if;

  -- the cap: documents sent this month in the business zone (one sender at a time per business)
  v_limit := app.org_limit(p_org, 'max_signatures_per_month');
  v_month := date_trunc('month', now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
  insert into app.signature_months (organization_id, month, sent) values (p_org, v_month, 0)
  on conflict (organization_id, month) do nothing;
  select m.sent into v_sent from app.signature_months m where m.organization_id = p_org and m.month = v_month for update;
  if v_limit is not null and v_sent >= v_limit then
    raise exception 'monthly signature limit reached' using errcode = 'P0001', hint = 'limit:max_signatures_per_month';
  end if;
  update app.signature_months m set sent = m.sent + 1 where m.organization_id = p_org and m.month = v_month;

  insert into public.signature_documents (organization_id, lead_id, contact_id, company_id, deal_id, template_id, title, body,
                                          sent_by, sent_at, expires_at, content_sha256)
  values (p_org,
          case when p_record_type = 'lead' then p_record_id end,
          case when p_record_type = 'contact' then p_record_id end,
          case when p_record_type = 'company' then p_record_id end,
          case when p_record_type = 'deal' then p_record_id end,
          v_template.id, v_title, p_body, auth.uid(), now(),
          -- SGN-03 (owner (247) ב): the end of the business day (sending day in the business zone + N days)
          case when p_valid_days is not null then app.signature_valid_until(p_org, p_valid_days) end,
          repeat('0', 64))
  returning * into v_doc;
  update public.signature_documents d set content_sha256 = app.signature_fingerprint(v_doc), people = app.signature_people(v_doc)
   where d.organization_id = p_org and d.id = v_doc.id
  returning * into v_doc;

  v_token := app.signature_link_issue(v_doc);
  perform app.signature_timeline(v_doc, 'signature_sent', 'נשלח מסמך לחתימה: ' || v_doc.title, auth.uid());
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'signature_document', 'signature_documents', v_doc.id,
          jsonb_build_object('status', 'sent', 'record_type', p_record_type, 'template_id', v_template.id));
  return jsonb_build_object('id', v_doc.id, 'token', v_token);
end;
$$;
revoke all on function public.signature_document_send(uuid, uuid, text, uuid, text, text, integer) from public, anon;
grant execute on function public.signature_document_send(uuid, uuid, text, uuid, text, text, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- The notification kind of a staff reminder (owner (248) ב): mutable, shown in the settings
-- ----------------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_kinds,
  add constraint notifications_kinds check (type in (
    'system', 'assigned', 'task_reminder', 'inquiry', 'automation',
    'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
    'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card', 'signature_reminder'));

alter table public.notification_settings
  drop constraint if exists notification_settings_kinds,
  add constraint notification_settings_kinds check (
    muted <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                   'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                   'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card', 'signature_reminder']
    and no_push <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                         'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                         'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card', 'signature_reminder']);

-- ----------------------------------------------------------------------------
-- The closed list: {שם המסמך} (owner (249) א); the type fields stay 021196's (review M1, below)
-- ----------------------------------------------------------------------------
create or replace function app.message_merge_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'תאריך', 'שעה', 'מסמך', 'סכום', 'מועד תשלום', 'קישור להצעה',
               'טלפון העסק', 'כתובת העסק', 'תוקף', 'תוכן העדכון', 'קישור הסרה', 'קוד אימות', 'שם הכרטיסייה', 'כניסות',
               'מיקום', 'קישור', 'שם המסמך']::text[]
$$;
revoke all on function app.message_merge_fields() from public, anon, authenticated;
-- the table's check trigger runs as the writer (a person)
grant execute on function app.message_merge_fields() to authenticated;

alter table public.message_templates
  drop constraint if exists message_templates_notice_kind_check,
  add constraint message_templates_notice_kind_check
    check (notice_kind is null or notice_kind in ('punch_card_low', 'punch_card_expiry',
                                                  'meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour',
                                                  'signature_reminder'));

-- ----------------------------------------------------------------------------
-- Review M1: the system's own templates (notice_kind set) are never sent by a person or a rule, and only the mark
-- 'signature_reminder' lets a requested_document hold {תאריך}, {קישור} and {שם המסמך}
-- ----------------------------------------------------------------------------
-- Redefined from their latest bodies, each with only the lines marked "SGN-03 review M1": app.record_sms_template_refusal,
-- app.record_sms_enqueue and app.automation_send_sms (021202), app.record_email_enqueue (021207),
-- app.message_template_sendable (021161) and app.message_template_problem (021162's 6-argument form, now a wrapper of
-- app.message_notice_template_problem, which holds its body). New: app.message_notice_fields.
-- The fields a template may hold only with the system's own mark (SGN-03 review M1): a requested_document marked
-- 'signature_reminder' carries the document's title, last day and link; no other template does. = NOTICE_KIND_FIELDS.
create or replace function app.message_notice_fields(p_type text, p_notice_kind text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case
    when p_type = 'requested_document' and p_notice_kind = 'signature_reminder' then array['תאריך', 'קישור', 'שם המסמך']::text[]
    else '{}'::text[]
  end
$$;
revoke all on function app.message_notice_fields(text, text) from public, anon, authenticated, service_role;

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
  if not (coalesce(p_message_type, '') = any (app.service_message_types())) then
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

-- 021162's rule, for a template without a mark (= app.message_notice_template_problem with none)
create or replace function app.message_template_problem(p_channel text, p_message_type text, p_subject text, p_body text,
                                                        p_own_domain text, p_business_email text)
returns text
language sql immutable
set search_path = ''
as $$
  select app.message_notice_template_problem(p_channel, p_message_type, null::text, p_subject, p_body, p_own_domain, p_business_email)
$$;
revoke all on function app.message_template_problem(text, text, text, text, text, text) from public, anon, authenticated;

create or replace function app.message_template_sendable(p_org uuid, p_template uuid) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row public.message_templates;
  v_own text;
  v_email text;
begin
  select * into v_row from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    return 'not_found';
  end if;
  if not v_row.is_active then
    return 'inactive';
  end if;
  select app.website_domain(o.website) into v_own from public.organizations o where o.id = p_org;
  -- owner (111) ב: the business's email from its business details
  select s.email into v_email from public.org_document_settings s where s.organization_id = p_org;
  -- SGN-03 review M1: the template's own mark decides the fields it may hold
  return app.message_notice_template_problem(v_row.channel, v_row.message_type, v_row.notice_kind, v_row.subject, v_row.body, v_own, v_email);
end;
$$;
revoke all on function app.message_template_sendable(uuid, uuid) from public, anon, authenticated;

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
  return null;
end;
$$;
revoke all on function app.record_sms_template_refusal(uuid, uuid, boolean) from public, anon, authenticated;

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
-- only for public.record_sms_send (invoker); schema app is not exposed by the API
grant execute on function app.record_sms_enqueue(uuid, text, uuid, uuid) to authenticated;

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
  select count(*) into v_found
    from app.jobs j
   where j.kind = 'message.send' and j.payload ? 'reply_to_user_id'
     and (j.payload ->> 'reply_to_user_id') = v_user::text
     and j.created_at > now() - interval '1 hour';
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
-- The queue payload: an optional signature_document_id (021204's rule plus the key)
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
      and ((not (p_payload ? 'sent_by_user_id') and not (p_payload ? 'automation_id')) or (p_payload ->> 'channel') = 'sms')
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
-- Server-only bookkeeping (schema app: RLS on, no grants)
-- ----------------------------------------------------------------------------
-- staff reminders: how many (at most 3), the day of the last one, its task
create table if not exists app.signature_reminders (
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  document_id       uuid not null,
  task_id           uuid,
  reminders         smallint not null default 0 check (reminders between 0 and 3),
  last_reminder_day date,
  failures          integer not null default 0 check (failures >= 0),
  last_attempt_at   timestamptz,
  done_at           timestamptz,
  created_at        timestamptz not null default now(),
  primary key (document_id),
  constraint signature_reminders_document_fk foreign key (organization_id, document_id)
    references public.signature_documents (organization_id, id) on delete cascade
);
create index if not exists signature_reminders_org_document_idx on app.signature_reminders (organization_id, document_id);
create index if not exists signature_reminders_task_idx on app.signature_reminders (task_id) where task_id is not null;
alter table app.signature_reminders enable row level security;
revoke all on app.signature_reminders from public, anon, authenticated, service_role;

-- the customer's one reminder: its outcome and job
create table if not exists app.signature_customer_reminders (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id     uuid not null,
  outcome         text not null default 'failed'
                  check (outcome in ('queued', 'failed', 'no_customer', 'no_template') or outcome ~ '^template:[a-z_]{1,40}$'),
  job_id          uuid,
  failures        integer not null default 0 check (failures >= 0),
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  primary key (document_id),
  constraint signature_customer_reminders_document_fk foreign key (organization_id, document_id)
    references public.signature_documents (organization_id, id) on delete cascade
);
create index if not exists signature_customer_reminders_org_document_idx on app.signature_customer_reminders (organization_id, document_id);
create index if not exists signature_customer_reminders_job_idx on app.signature_customer_reminders (job_id) where job_id is not null;
alter table app.signature_customer_reminders enable row level security;
revoke all on app.signature_customer_reminders from public, anon, authenticated, service_role;

-- the reminder templates added to a business, once per channel (a deleted one is not brought back)
create table if not exists app.signature_template_seeds (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel         text not null check (channel in ('sms', 'email')),
  seeded_at       timestamptz not null default now(),
  primary key (organization_id, channel)
);
alter table app.signature_template_seeds enable row level security;
revoke all on app.signature_template_seeds from public, anon, authenticated, service_role;

-- the per-run caps (tests lower them with a transaction setting)
create or replace function app.signature_expiry_per_org() returns integer
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.signature_job_per_org', true), '')::integer, 200)
$$;
revoke all on function app.signature_expiry_per_org() from public, anon, authenticated, service_role;

create or replace function app.signature_expiry_limit() returns integer
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.signature_job_limit', true), '')::integer, 2000)
$$;
revoke all on function app.signature_expiry_limit() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Expiry
-- ----------------------------------------------------------------------------
create or replace function app.expire_signature_documents() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_doc public.signature_documents;
  v_done integer := 0;
begin
  for v_row in
    select z.organization_id, z.id
      from (
        select d.organization_id, d.id, d.expires_at,
               row_number() over (partition by d.organization_id order by d.expires_at, d.id) as n
          from public.signature_documents d
         where d.status in ('sent', 'viewed') and d.expires_at is not null and d.expired_at is null
           and d.expires_at <= now()
      ) z
     where z.n <= app.signature_expiry_per_org()
     -- every business's first, then every business's second, ...
     order by z.n, z.expires_at, z.id
     limit app.signature_expiry_limit()
  loop
    begin
      -- a document being signed or cancelled right now is left for the next run
      select * into v_doc from public.signature_documents d
       where d.organization_id = v_row.organization_id and d.id = v_row.id
         and d.status in ('sent', 'viewed') and d.expired_at is null and d.expires_at <= now()
       for update skip locked;
      if found then
        update public.signature_documents d set expired_at = now()
         where d.organization_id = v_doc.organization_id and d.id = v_doc.id
        returning * into v_doc;
        -- nothing personal: no title, no name (the record is the notice's entity)
        if v_doc.erased_at is null and app.signature_record_id(v_doc) is not null then
          insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
          select v_doc.organization_id, m.user_id, 'system', 'פג תוקף של מסמך לחתימה',
                 'המסמך לא נחתם עד המועד שנקבע. אפשר לשלוח מסמך חדש מכרטיס הרשומה.',
                 app.signature_record_type(v_doc), app.signature_record_id(v_doc)
            from public.memberships m
           where m.organization_id = v_doc.organization_id and m.status = 'active'
             and (case when exists (select 1 from public.memberships s
                                     where s.organization_id = v_doc.organization_id and s.user_id = v_doc.sent_by
                                       and s.status = 'active' and s.role <> 'viewer')
                       then m.user_id = v_doc.sent_by
                       else m.role in ('owner', 'admin') end);
        end if;
        v_done := v_done + 1;
      end if;
    exception when others then
      -- the notice failed: the state is still stamped (without it), so a failing document never blocks the others
      raise warning 'crm-signature-expiry: document % failed (SQLSTATE %)', v_row.id, sqlstate;
      begin
        update public.signature_documents d set expired_at = now()
         where d.organization_id = v_row.organization_id and d.id = v_row.id
           and d.status in ('sent', 'viewed') and d.expired_at is null;
      exception when others then
        raise warning 'crm-signature-expiry: document % not stamped (SQLSTATE %)', v_row.id, sqlstate;
      end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.expire_signature_documents() from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- Staff reminders (owner (248) ב): every N business days, at most 3
-- ----------------------------------------------------------------------------
create or replace function app.send_signature_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_doc public.signature_documents;
  v_record jsonb;
  v_rep uuid;
  v_task uuid;
  v_title text;
  v_name text;
  v_due_at timestamptz;
  v_quiet text;
  v_open uuid;
  v_locked boolean;
  v_done integer := 0;
begin
  for v_row in
    with orgs as materialized (
      -- the businesses first: writable, with the key, the reminder on
      select o.id, app.intake_zone(o.timezone) as zone, coalesce(s.signature_reminder_days, 3) as days
        from public.organizations o
        left join public.org_document_settings s on s.organization_id = o.id
       where coalesce(s.signature_reminder_days, 3) > 0
         and exists (select 1 from public.signature_documents d
                      where d.organization_id = o.id and d.status in ('sent', 'viewed') and d.expired_at is null
                        and d.erased_at is null and d.sent_at >= now() - interval '370 days')
         and app.org_writable(o.id)
         and app.org_has_feature(o.id, 'signatures')
    ),
    cand as materialized (
      select d.organization_id, d.id, d.sent_at, og.zone, og.days,
             (now() at time zone og.zone)::date as today,
             (d.sent_at at time zone og.zone)::date as sent_day,
             r.last_attempt_at, r.last_reminder_day
        from orgs og
        join public.signature_documents d on d.organization_id = og.id
        left join app.signature_reminders r on r.document_id = d.id
       where d.status in ('sent', 'viewed') and d.expired_at is null and d.erased_at is null
         and (d.expires_at is null or d.expires_at > now())
         and num_nonnulls(d.lead_id, d.contact_id, d.company_id, d.deal_id) = 1
         -- a cheap bound: three reminders of 30 working days, or a validity of 365 days, are within a year
         and d.sent_at >= now() - interval '370 days'
         and (r.document_id is null or (r.reminders < 3 and r.failures < 3))
         -- a record in the recycle bin waits (nothing is recorded)
         and not exists (select 1 from public.leads l where l.organization_id = d.organization_id and l.id = d.lead_id and l.deleted_at is not null)
         and not exists (select 1 from public.contacts c where c.organization_id = d.organization_id and c.id = d.contact_id and c.deleted_at is not null)
         and not exists (select 1 from public.companies c where c.organization_id = d.organization_id and c.id = d.company_id and c.deleted_at is not null)
         and not exists (select 1 from public.deals dl where dl.organization_id = d.organization_id and dl.id = d.deal_id and dl.deleted_at is not null)
    )
    select z.* from (
      select c.organization_id, c.id, c.zone, c.today, rd.day as reminder_day, c.last_attempt_at,
             row_number() over (partition by c.organization_id order by c.last_attempt_at nulls first, c.sent_at, c.id) as n
        from cand c
        cross join lateral (
          -- N business days after the sending day, then after the day of the previous reminder; not before 08:00 in the
          -- business zone, and never on the day it was sent or reminded
          select app.add_business_days(c.organization_id, coalesce(c.last_reminder_day, c.sent_day), c.days) as day
           where (now() at time zone c.zone)::time >= time '08:00' and coalesce(c.last_reminder_day, c.sent_day) < c.today
        ) rd
       where rd.day <= c.today
         -- a first reminder whose day passed more than a week ago is never made
         and (c.last_reminder_day is not null or rd.day >= c.today - 7)
    ) z
     where z.n <= app.signature_expiry_per_org()
     order by z.n, z.last_attempt_at nulls first, z.organization_id, z.id
     limit app.signature_expiry_limit()
  loop
    begin
      v_rep := null;
      v_task := null;
      -- a document being signed or cancelled right now is left for the next run
      select * into v_doc from public.signature_documents d
       where d.organization_id = v_row.organization_id and d.id = v_row.id
         and d.status in ('sent', 'viewed') and d.expired_at is null and d.erased_at is null
         and (d.expires_at is null or d.expires_at > now())
       for update skip locked;
      if found then
        v_due_at := greatest(now(), (v_row.reminder_day + time '10:00') at time zone v_row.zone);
        v_record := app.signature_record_row(v_doc.organization_id, app.signature_record_type(v_doc), app.signature_record_id(v_doc));
        v_open := null;
        v_locked := false;
        -- lead's choice: the previous reminder task still open is re-dated (and counted) instead of a second one. Review L3:
        -- taken skip locked after the document; a task someone holds right now waits for the next run
        select r.task_id into v_open
          from app.signature_reminders r
          join public.tasks t on t.organization_id = v_doc.organization_id and t.id = r.task_id
         where r.document_id = v_doc.id and t.status = 'open' and t.deleted_at is null;
        if v_open is not null then
          select t.id, t.owner_id into v_task, v_rep
            from public.tasks t
           where t.organization_id = v_doc.organization_id and t.id = v_open and t.status = 'open' and t.deleted_at is null
           for update skip locked;
          if v_task is null then
            v_locked := true;
          -- review L5: only while its owner is still an active full-seat non-viewer who reads the record
          elsif not exists (select 1 from public.memberships m
                             where m.organization_id = v_doc.organization_id and m.user_id = v_rep
                               and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
                               and app.user_can_read_record(v_doc.organization_id, m.user_id, (v_record ->> 'owner_id')::uuid,
                                                            (v_record ->> 'team_id')::uuid)) then
            -- delta review D3: the old task is closed in the same step, the reminder goes on in a new one
            update public.tasks t set status = 'done', outcome = 'נסגרה: הועברה לאחראי אחר'
             where t.organization_id = v_doc.organization_id and t.id = v_task;
            v_task := null;
            v_rep := null;
          else
            update public.tasks t set due_at = v_due_at where t.organization_id = v_doc.organization_id and t.id = v_task;
          end if;
        end if;

        if v_locked then
          null;
        elsif v_task is null then
          -- the sender, while an active full-seat non-viewer who reads the record; else the owner, else the oldest admin
          select m.user_id into v_rep
            from public.memberships m
           where m.organization_id = v_doc.organization_id and m.user_id = v_doc.sent_by
             and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
             and app.user_can_read_record(v_doc.organization_id, m.user_id, (v_record ->> 'owner_id')::uuid, (v_record ->> 'team_id')::uuid);
          if v_rep is null then
            select m.user_id into v_rep
              from public.memberships m
             where m.organization_id = v_doc.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
             order by (m.role = 'owner') desc, m.created_at, m.user_id
             limit 1;
          end if;

          if v_doc.lead_id is not null then
            select nullif(btrim(l.full_name), '') into v_name from public.leads l where l.organization_id = v_doc.organization_id and l.id = v_doc.lead_id;
          elsif v_doc.contact_id is not null then
            select nullif(btrim(c.full_name), '') into v_name from public.contacts c where c.organization_id = v_doc.organization_id and c.id = v_doc.contact_id;
          else
            v_name := null;
          end if;
          v_title := case
                       when v_doc.lead_id is not null or v_doc.contact_id is not null
                         then left('להזכיר ל' || coalesce(v_name, 'לקוח') || ' לחתום על ' || v_doc.title, 200)
                       else 'להזכיר ללקוח לחתום על המסמך שנשלח ב-' || to_char((v_doc.sent_at at time zone v_row.zone)::date, 'DD.MM.YYYY')
                     end;

          if v_rep is not null then
            -- the assignee gets the reminder's own notice below, not an 'assigned' one (app.notify_assignment)
            v_quiet := current_setting('app.intake_quiet_task', true);
            perform set_config('app.intake_quiet_task', v_rep::text, true);
            insert into public.tasks (organization_id, title, task_type, due_at, priority, owner_id,
                                      lead_id, contact_id, company_id, deal_id, description)
            values (v_doc.organization_id, v_title, 'todo', v_due_at, 2, v_rep,
                    v_doc.lead_id, v_doc.contact_id, v_doc.company_id, v_doc.deal_id,
                    'המסמך נשלח לחתימה ב-' || to_char((v_doc.sent_at at time zone v_row.zone)::date, 'DD.MM.YYYY')
                    || ' ועוד לא נחתם. אפשר לשלוח שוב את הקישור מכרטיס "מסמכים לחתימה".')
            returning id into v_task;
            perform set_config('app.intake_quiet_task', coalesce(v_quiet, ''), true);
          end if;
        end if;

        -- the reminder's own kind (muted by the person's settings like any other); nothing personal in it
        if not v_locked and v_rep is not null and v_task is not null then
          insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
          values (v_doc.organization_id, v_rep, 'signature_reminder', 'תזכורת: מסמך לחתימה עוד לא נחתם',
                  'יש לך משימה להזכיר ללקוח לחתום.', 'task', v_task);
        end if;

        if not v_locked then
          insert into app.signature_reminders as r (organization_id, document_id, task_id, reminders, last_reminder_day,
                                                    failures, last_attempt_at, done_at)
          values (v_doc.organization_id, v_doc.id, v_task, 1, v_row.today, 0, now(), null)
          on conflict (document_id) do update
            set task_id = coalesce(excluded.task_id, r.task_id), reminders = least(r.reminders + 1, 3),
                last_reminder_day = excluded.last_reminder_day, failures = 0, last_attempt_at = excluded.last_attempt_at,
                done_at = case when r.reminders + 1 >= 3 then now() end;
          v_done := v_done + 1;
        end if;
      end if;
    exception when others then
      insert into app.signature_reminders (organization_id, document_id, failures, last_attempt_at)
      values (v_row.organization_id, v_row.id, 1, now())
      on conflict (document_id) do update set failures = app.signature_reminders.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-signature-reminders: document % failed (SQLSTATE %)%', v_row.id, sqlstate,
        case when coalesce((select r.failures from app.signature_reminders r where r.document_id = v_row.id), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_signature_reminders() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The customer's reminder (owner (249) א)
-- ----------------------------------------------------------------------------
-- DRAFT wording until the lawyer edits it; = DEFAULT_SIGNATURE_REMINDER_TEMPLATES. Each is added while the business has no
-- template of its mark on its channel and no template of its name, once per business and channel, each on its own: an
-- insert the 50-template cap (or anything else) refuses is recorded as done all the same, with one warning, so it is never
-- tried again on every run (review L6); the business adds the template by hand if it wants it.
create or replace function app.seed_signature_reminder_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select d.* from (values
      (1, 'מסמך לחתימה: תזכורת (SMS)', 'sms', null::text,
          'שלום {שם פרטי}, המסמך "{שם המסמך}" מ-{שם העסק} ממתין לחתימתך עד {תאריך}: {קישור}. {שם העסק}, {טלפון העסק}'),
      (2, 'מסמך לחתימה: תזכורת (אימייל)', 'email', 'מסמך מ-{שם העסק} ממתין לחתימתך',
          'שלום {שם פרטי}, המסמך "{שם המסמך}" מ-{שם העסק} ממתין לחתימתך עד {תאריך}: {קישור}. {שם העסק}, {טלפון העסק}')
    ) as d(n, name, channel, subject, body)
     where not exists (select 1 from app.signature_template_seeds s where s.organization_id = p_org and s.channel = d.channel)
     order by d.n
  loop
    begin
      if not exists (select 1 from public.message_templates t
                      where t.organization_id = p_org and t.notice_kind = 'signature_reminder' and t.channel = v_row.channel)
         and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(v_row.name)) then
        insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind, wording_version)
        values (p_org, v_row.name, v_row.channel, 'requested_document', v_row.subject, v_row.body, 'signature_reminder',
                'signature-draft-1');
      end if;
      insert into app.signature_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    exception when others then
      raise warning 'signature reminder template % not seeded for business % (SQLSTATE %)', v_row.n, p_org, sqlstate;
      insert into app.signature_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    end;
  end loop;
end;
$$;
revoke all on function app.seed_signature_reminder_templates(uuid) from public, anon, authenticated, service_role;

-- The customer and the template: the preferred channel when it is SMS or email, else SMS, else email, with an address and an
-- active template marked 'signature_reminder' on that channel (CAL-12's rule, app.meeting_customer_template)
create or replace function app.signature_customer_template(p_org uuid, p_contact uuid, p_lead uuid)
returns table (template_id uuid, channel text)
language sql stable security definer
set search_path = ''
as $$
  with customer as (
    select c.preferred_channel, c.phone_e164, c.email
      from public.contacts c
     where p_contact is not null and c.organization_id = p_org and c.id = p_contact and c.deleted_at is null
    union all
    select l.preferred_channel, l.phone_e164, l.email
      from public.leads l
     where p_contact is null and p_lead is not null and l.organization_id = p_org and l.id = p_lead and l.deleted_at is null
  )
  select t.id, t.channel
    from customer cu
    cross join lateral (
      select ch, ord from (values (cu.preferred_channel, 0), ('sms', 1), ('email', 2)) v(ch, ord)
       where ch in ('sms', 'email')
    ) o
    join public.message_templates t
      on t.organization_id = p_org and t.channel = o.ch and t.is_active
     and t.message_type = 'requested_document' and t.notice_kind = 'signature_reminder'
   where nullif(btrim(case when o.ch = 'email' then cu.email else cu.phone_e164 end), '') is not null
   order by o.ord, t.created_at, t.id
   limit 1
$$;
revoke all on function app.signature_customer_template(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.send_signature_customer_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_doc public.signature_documents;
  v_contact uuid;
  v_lead uuid;
  v_template uuid;
  v_channel text;
  v_problem text;
  v_outcome text;
  v_job uuid;
  v_done integer := 0;
begin
  for v_row in
    with orgs as materialized (
      select o.id, app.intake_zone(o.timezone) as zone
        from public.organizations o
        left join public.org_document_settings s on s.organization_id = o.id
       where coalesce(s.signature_customer_reminder, true)
         and exists (select 1 from public.signature_documents d
                      where d.organization_id = o.id and d.status in ('sent', 'viewed') and d.expired_at is null
                        and d.expires_at > now() and d.expires_at < now() + interval '4 days')
         and app.org_writable(o.id)
         and app.org_has_feature(o.id, 'signatures')
    )
    select z.* from (
      select d.organization_id, d.id, r.last_attempt_at,
             row_number() over (partition by d.organization_id order by r.last_attempt_at nulls first, d.expires_at, d.id) as n
        from orgs og
        join public.signature_documents d on d.organization_id = og.id
        left join app.signature_customer_reminders r on r.document_id = d.id
       where d.status in ('sent', 'viewed') and d.expired_at is null and d.erased_at is null
         -- a cheap bound first, then the rule: from 08:00 on the day two calendar days before the last day, never on the
         -- sending day, while it still waits
         and d.expires_at > now() and d.expires_at < now() + interval '4 days'
         and (now() at time zone og.zone)::date >= (d.expires_at at time zone og.zone)::date - 2
         and (now() at time zone og.zone)::date > (d.sent_at at time zone og.zone)::date
         and (now() at time zone og.zone)::time >= time '08:00'
         and num_nonnulls(d.lead_id, d.contact_id, d.company_id, d.deal_id) = 1
         and (r.document_id is null or (r.outcome <> 'queued' and r.failures < 3))
         -- a record in the recycle bin waits
         and not exists (select 1 from public.leads l where l.organization_id = d.organization_id and l.id = d.lead_id and l.deleted_at is not null)
         and not exists (select 1 from public.contacts c where c.organization_id = d.organization_id and c.id = d.contact_id and c.deleted_at is not null)
         and not exists (select 1 from public.deals dl where dl.organization_id = d.organization_id and dl.id = d.deal_id and dl.deleted_at is not null)
    ) z
     where z.n <= app.signature_expiry_per_org()
     order by z.n, z.last_attempt_at nulls first, z.organization_id, z.id
     limit app.signature_expiry_limit()
  loop
    begin
      v_contact := null;
      v_lead := null;
      v_template := null;
      v_channel := null;
      v_outcome := null;
      v_job := null;
      select * into v_doc from public.signature_documents d
       where d.organization_id = v_row.organization_id and d.id = v_row.id
         and d.status in ('sent', 'viewed') and d.expired_at is null and d.erased_at is null and d.expires_at > now()
       for update skip locked;
      -- review L2: the business may have lost the key, the switch or its writable state since the run began
      if found and app.org_writable(v_doc.organization_id) and app.org_has_feature(v_doc.organization_id, 'signatures')
         and coalesce((select s.signature_customer_reminder from public.org_document_settings s
                        where s.organization_id = v_doc.organization_id), true) then
        -- the person the document waits for: the lead, the contact, a deal's live contact; a company has none
        if v_doc.lead_id is not null then
          v_lead := v_doc.lead_id;
        elsif v_doc.contact_id is not null then
          v_contact := v_doc.contact_id;
        elsif v_doc.deal_id is not null then
          select dl.contact_id into v_contact from public.deals dl
           where dl.organization_id = v_doc.organization_id and dl.id = v_doc.deal_id and dl.deleted_at is null;
        end if;
        if v_lead is null and v_contact is null then
          v_outcome := 'no_customer';
        else
          perform app.seed_signature_reminder_templates(v_doc.organization_id);
          select st.template_id, st.channel into v_template, v_channel
            from app.signature_customer_template(v_doc.organization_id, v_contact, v_lead) st;
          if v_template is null then
            v_outcome := 'no_template';
          else
            v_problem := app.message_template_sendable(v_doc.organization_id, v_template);
            if v_problem is not null then
              perform app.message_send_refused(v_doc.organization_id, v_template, v_problem);
              v_outcome := 'template:' || left(regexp_replace(v_problem, '[^a-z_]', '_', 'g'), 40);
            else
              -- see the header: the future sender re-reads the document by signature_document_id and mints the link itself
              v_job := app.enqueue_job(
                v_doc.organization_id, 'message.send',
                jsonb_build_object('channel', v_channel, 'message_type', 'requested_document', 'template_id', v_template,
                                   'signature_document_id', v_doc.id,
                                   'event_at', to_char(v_doc.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                || case when v_contact is not null then jsonb_build_object('contact_id', v_contact)
                        else jsonb_build_object('lead_id', v_lead) end
                || case when v_doc.deal_id is not null and v_contact is not null then jsonb_build_object('deal_id', v_doc.deal_id)
                        else '{}'::jsonb end);
              v_outcome := 'queued';
            end if;
          end if;
        end if;
        insert into app.signature_customer_reminders as r (organization_id, document_id, outcome, job_id, failures, last_attempt_at)
        values (v_doc.organization_id, v_doc.id, v_outcome, v_job, 0, now())
        on conflict (document_id) do update
          set outcome = excluded.outcome, job_id = excluded.job_id, failures = 0, last_attempt_at = excluded.last_attempt_at;
        if v_outcome = 'queued' then
          v_done := v_done + 1;
        end if;
      end if;
    exception when others then
      insert into app.signature_customer_reminders (organization_id, document_id, failures, last_attempt_at)
      values (v_row.organization_id, v_row.id, 1, now())
      on conflict (document_id) do update
        set failures = app.signature_customer_reminders.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-signature-customer-reminders: document % failed (SQLSTATE %)', v_row.id, sqlstate;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_signature_customer_reminders() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A document that stops waiting: its open reminder task closes, its customer reminder still in the queue is cancelled
-- ----------------------------------------------------------------------------
create or replace function app.signature_documents_reminder_close() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_note text;
  v_count integer;
begin
  if old.status in ('sent', 'viewed') and new.status = 'signed' then
    v_note := 'נסגרה: המסמך נחתם';
  elsif old.status in ('sent', 'viewed') and new.status = 'cancelled' then
    v_note := 'נסגרה: המסמך בוטל';
  elsif old.expired_at is null and new.expired_at is not null and new.status in ('sent', 'viewed') then
    v_note := 'נסגרה: פג תוקף המסמך';
  else
    return null;
  end if;
  update public.tasks t
     set status = 'done', outcome = v_note
    from app.signature_reminders r
   where r.document_id = new.id and r.task_id = t.id
     and t.organization_id = new.organization_id and t.status = 'open' and t.deleted_at is null;
  with taken as (
    select j.id from app.jobs j
      join app.signature_customer_reminders r on r.job_id = j.id
     where r.document_id = new.id and r.organization_id = new.organization_id and r.outcome = 'queued'
       and j.organization_id = new.organization_id and j.kind = 'message.send' and j.status in ('queued', 'failed')
     for update of j skip locked
  ), cancelled as (
    update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                          last_error = 'refused:document_closed'
      from taken t
     where j.id = t.id
    returning j.id
  )
  select count(*)::integer into v_count from cancelled;
  if v_count > 0 then
    insert into app.job_cancel_counts (organization_id, reason, pending)
    values (new.organization_id, 'document_closed', v_count)
    on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + excluded.pending;
  end if;
  return null;
end;
$$;
revoke all on function app.signature_documents_reminder_close() from public, anon, authenticated, service_role;

create or replace trigger signature_documents_reminder_close after update of status, expired_at on public.signature_documents
  for each row execute function app.signature_documents_reminder_close();

-- ----------------------------------------------------------------------------
-- Review L4: switching the customer's reminder off cancels the business's reminders still waiting in the queue
-- ----------------------------------------------------------------------------
create or replace function app.org_document_settings_signature_reminder_off() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- delta review D2: no settings row meant "on", so a first save that inserts false switches it off too
  if tg_op = 'INSERT' then
    if new.signature_customer_reminder then
      return null;
    end if;
  elsif not (coalesce(old.signature_customer_reminder, true) and not new.signature_customer_reminder) then
    return null;
  end if;
  with taken as (
    select j.id from app.jobs j
      join app.signature_customer_reminders r on r.job_id = j.id
     where r.organization_id = new.organization_id and r.outcome = 'queued'
       and j.organization_id = new.organization_id and j.kind = 'message.send' and j.status in ('queued', 'failed')
     for update of j skip locked
  ), cancelled as (
    update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                          last_error = 'refused:reminder_off'
      from taken t
     where j.id = t.id
    returning j.id
  )
  select count(*)::integer into v_count from cancelled;
  if v_count > 0 then
    insert into app.job_cancel_counts (organization_id, reason, pending)
    values (new.organization_id, 'reminder_off', v_count)
    on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + excluded.pending;
  end if;
  return null;
end;
$$;
revoke all on function app.org_document_settings_signature_reminder_off() from public, anon, authenticated, service_role;

create or replace trigger org_document_settings_signature_reminder_off
  after insert or update of signature_customer_reminder on public.org_document_settings
  for each row execute function app.org_document_settings_signature_reminder_off();

-- ----------------------------------------------------------------------------
-- The jobs
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-signature-expiry', '*/15 * * * *', 'select app.expire_signature_documents();');
    perform cron.schedule('crm-signature-reminders', '7,22,37,52 * * * *', 'select app.send_signature_reminders();');
    perform cron.schedule('crm-signature-customer-reminders', '11,26,41,56 * * * *', 'select app.send_signature_customer_reminders();');
  end if;
end;
$$;
