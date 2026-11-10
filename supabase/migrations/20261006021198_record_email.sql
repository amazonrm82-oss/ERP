-- =============================================================================
-- EML-02: an email to the customer from the record's card, from a message template, with files attached
-- =============================================================================
-- SPEC-ADDITIONS EML-02, owner's answers (193) ב, (194) א, (195) א, (196) א, (197) ב (9 November 2026). A person sends an
-- email to a lead, a contact or a deal's contact from the record's card, from a MSG-02 template of channel email, with files
-- of the record and of the content library (LIB-01) attached; it goes out from a platform address with "reply to" = the
-- person who sent it. No real provider exists: the message is an OPS-04 `message.send` job like every other, judged by the
-- queue's own send check (app.consent_suppressed for marketing, the blocklist / erasure for service types, HEB-09's pause,
-- sending hours, rates and MSG-05's caps) and handed to the email channel's provider (only the fake). Nothing on the
-- worker's path changes: claim_jobs, finish_job, job_message_may_send and app.jobs_record_message (md5 pinned in test 284)
-- are untouched, and a sent or failed message reaches the timeline through public.messages as every other message.
-- No new use of the service key.
--
-- * app.job_payload_ok (021196's body, CAL-12's meeting_id kept) takes four more ids on a message.send job, email only:
--   `deal_id` (the deal the person sent from; the message is the deal's contact's), `file_ids` (files of the record),
--   `library_file_ids` (the current file of a content-library item; a separate key, so the future adapter tells the two
--   kinds apart without reading anything), each 1..5 distinct ids and at most 5 together, and `reply_to_user_id` (the
--   person who sent it). The queue still holds ids and codes only.
-- * public.record_email_send(org, kind, record, template, files, library_items) (INVOKER): reads the record, the deal's
--   contact, the template, every record file and every library item's current file with the caller's own rights (RLS: a
--   private note's file stays its author's and the admins'; an HEB-08 deputy reads what the select policies give), then
--   hands over to app.record_email_enqueue (definer, granted to authenticated only for this wrapper; schema app is not in the
--   API), which judges everything again:
--   - (193) ב who: the activities_insert rule, app.can_write in a writable business and reading the record (the select
--     policies' rule: app.can_read_record or app.deputy_readable); a deal's contact must be live and read the same way;
--   - the address is the record's own email (the payload names only the record; the send check reads the address itself);
--   - (194) א the template is the business's, of channel email, sendable now (app.message_template_sendable: active and the
--     MSG-02 rules), and marketing, or requested_document, or collection only for app.can_record_payments and (lead's interim
--     choice, review of 9 November 2026) only with the plan keys collection, documents and payments (hint feature:<key>), as
--     every other collection feature; never a meeting reminder (CAL-12 sends those), a verification code or a punch card
--     notice;
--   - (196) א / (197) ב files: record files of THIS record, confirmed, not on someone else's private note; library items of
--     kind file, active and valid today in the business's zone, each by its current file (the newest confirmed one), and
--     (lead's interim choice until the owner answers) on a MARKETING template only, where consent applies (hint
--     record_email:library_service); at most 5 files together and 10 MB together;
--   - at most 30 emails a person an hour across every business (advisory lock per person).
--   It answers {job_id, paused}; paused = HEB-09's pause holds now (the queue keeps the message waiting).
-- * public.record_email_queue(org, kind, record) (definer; members who may send, not viewers, and read the record): the
--   emails sent by a person FROM THIS RECORD's card in the last 30 days (newest 20; a deal's email shows on the deal's card,
--   not on its contact's): when, the template's name, the sender, how many files, and the state waiting | sent | not_sent
--   with a coarse reason (consent | paused | other), never an address or a refusal code.
--
-- Approved for later, NOT built here (owner (195) א, together with the email provider's choice): the real adapter will read
-- what it sends through ONE security definer function granted to service_role only, which answers, only for a message.send
-- job under a live lease the worker holds (the lease check of job_message_may_send), the Storage paths of the job's
-- `file_ids` and `library_file_ids`, each re-read on the send day and dropped (the message then not sent, with a code) unless
-- it still holds: a record file still confirmed, still of that record, and not on a note that has since become private or
-- been removed; a library file still the current file of its item, the item still of kind file, active and valid on the
-- send day in the business's zone, and the template still marketing; the template sendable again
-- (app.message_template_sendable, then app.message_filled_problem on the filled text); the template filled with the
-- record's values (marketing inside marketingEnvelope's rule) and the reply-to address (the sending person's email while
-- they are an active member, else none); the adapter reads Storage objects only at those paths. It gets its own "In use" line in hard rule 5 once
-- built, database tests and an independent review. Until then the fake provider gets the ids only.
-- No row is deleted here. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The payload: 021196's body (CAL-12's meeting_id kept) plus deal_id, file_ids, library_file_ids and reply_to_user_id
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
                               'reply_to_user_id'))
           from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
      and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
      and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
      -- EML-02: an email from a record's card: the deal it was sent from (with the deal's contact as the record), the record
      -- files attached and the person who sent it (the reply-to address), ids only and email only
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
      and ((not (p_payload ? 'deal_id') and not (p_payload ? 'file_ids') and not (p_payload ? 'library_file_ids')
            and not (p_payload ? 'reply_to_user_id'))
           or (p_payload ->> 'channel') = 'email')
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

-- the card's own emails, found without reading the whole queue of the business
create index if not exists jobs_record_email_idx on app.jobs (organization_id, created_at)
  where kind = 'message.send' and payload ? 'reply_to_user_id';
-- the person's hourly count, across every business
create index if not exists jobs_record_email_sender_idx on app.jobs ((payload ->> 'reply_to_user_id'), created_at)
  where kind = 'message.send' and payload ? 'reply_to_user_id';

-- ----------------------------------------------------------------------------
-- The limits and the service types a card may send
-- ----------------------------------------------------------------------------
create or replace function app.record_email_max_files() returns integer
language sql immutable set search_path = '' as $$ select 5 $$;
create or replace function app.record_email_max_bytes() returns bigint
language sql immutable set search_path = '' as $$ select 10485760::bigint $$;
create or replace function app.record_email_hourly_limit() returns integer
language sql immutable set search_path = '' as $$ select 30 $$;
-- a meeting reminder, a verification code and a punch card notice carry their own context (a meeting, a code, a card),
-- which a card does not have; they are sent by their own senders only
create or replace function app.record_email_service_types() returns text[]
language sql immutable set search_path = '' as $$ select array['requested_document', 'collection']::text[] $$;
revoke all on function app.record_email_max_files() from public, anon, authenticated;
revoke all on function app.record_email_max_bytes() from public, anon, authenticated;
revoke all on function app.record_email_hourly_limit() from public, anon, authenticated;
revoke all on function app.record_email_service_types() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Who reads the record: the select policies' rule (app.can_read_record, or an HEB-08 deputy's app.deputy_readable)
-- ----------------------------------------------------------------------------
create or replace function app.record_email_readable(p_org uuid, p_kind text, p_record uuid, p_owner uuid, p_team uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_org is not null and p_record is not null
     and (app.can_read_record(p_org, p_owner, p_team)
          or exists (select 1 from app.deputy_readable(p_kind) r where r.organization_id = p_org and r.id = p_record))
$$;
revoke all on function app.record_email_readable(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The definer half: judges and queues
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
  if cardinality(v_library) > 0 and v_tpl.message_type <> 'marketing' then
    -- lead's interim choice until the owner answers: library files go on marketing only, where consent applies
    raise exception 'library files go on marketing only' using errcode = 'P0001', hint = 'record_email:library_service';
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
  return jsonb_build_object('job_id', v_job, 'paused', coalesce(app.customer_sending_paused(p_org), false));
end;
$$;
revoke all on function app.record_email_enqueue(uuid, text, uuid, uuid, uuid[], uuid[]) from public, anon, authenticated;
-- only for public.record_email_send (invoker); schema app is not exposed by the API
grant execute on function app.record_email_enqueue(uuid, text, uuid, uuid, uuid[], uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- The person's call: reads with the caller's rights, then the definer half
-- ----------------------------------------------------------------------------
create or replace function public.record_email_send(p_org uuid, p_kind text, p_record uuid, p_template uuid,
                                                    p_files uuid[] default '{}', p_library_items uuid[] default '{}')
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_contact uuid;
  v_files uuid[];
  v_items uuid[];
  v_library uuid[];
  v_readable integer;
begin
  if auth.uid() is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'contact', 'deal') then
    raise exception 'unknown record type' using errcode = 'P0001', hint = 'record_email:kind';
  end if;
  -- the record, as the caller reads it (RLS)
  if p_kind = 'lead' then
    perform 1 from public.leads l where l.organization_id = p_org and l.id = p_record and l.deleted_at is null;
  elsif p_kind = 'contact' then
    perform 1 from public.contacts c where c.organization_id = p_org and c.id = p_record and c.deleted_at is null;
  else
    select d.contact_id into v_contact from public.deals d
     where d.organization_id = p_org and d.id = p_record and d.deleted_at is null;
  end if;
  if not found then
    raise exception 'record not found' using errcode = 'P0001', hint = 'record_email:not_found';
  end if;
  if p_kind = 'deal' then
    perform 1 from public.contacts c where c.organization_id = p_org and c.id = v_contact and c.deleted_at is null;
    if v_contact is null or not found then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_email:no_contact';
    end if;
  end if;
  -- the template, as the caller reads it
  perform 1 from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    raise exception 'template not found' using errcode = 'P0001', hint = 'record_email:template';
  end if;
  -- every record file, as the caller reads it (RLS: a private note's file is its author's and the admins')
  select coalesce(array_agg(distinct f), '{}') into v_files from unnest(coalesce(p_files, '{}'::uuid[])) f where f is not null;
  if cardinality(v_files) > 0 then
    select count(*) into v_readable from public.files f
     where f.organization_id = p_org and f.id = any (v_files) and f.unconfirmed_since is null;
    if v_readable <> cardinality(v_files) then
      raise exception 'a file is not a file of this record' using errcode = 'P0001', hint = 'record_email:file';
    end if;
  end if;
  -- every library item, as the caller reads it, by its current file (the newest confirmed one)
  select coalesce(array_agg(distinct i), '{}') into v_items from unnest(coalesce(p_library_items, '{}'::uuid[])) i where i is not null;
  if cardinality(v_items) > 0 then
    select coalesce(array_agg(c.id), '{}') into v_library
      from (select distinct on (f.library_item_id) f.id
              from public.files f
             where f.organization_id = p_org and f.library_item_id = any (v_items) and f.unconfirmed_since is null
             order by f.library_item_id, f.created_at desc, f.id desc) c;
    if cardinality(v_library) <> cardinality(v_items) then
      raise exception 'a library file cannot be sent' using errcode = 'P0001', hint = 'record_email:library';
    end if;
  end if;
  return app.record_email_enqueue(p_org, p_kind, p_record, p_template, v_files, coalesce(v_library, '{}'));
end;
$$;
revoke all on function public.record_email_send(uuid, text, uuid, uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.record_email_send(uuid, text, uuid, uuid, uuid[], uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- The card's list: the person-sent emails of the record and their state
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
