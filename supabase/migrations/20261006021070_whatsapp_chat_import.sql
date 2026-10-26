-- =============================================================================
-- WAB-07 (wave 2): an exported WhatsApp chat on a record's timeline
-- =============================================================================
-- Owner, 26 October 2026, answer (ב): an imported chat is history, NEVER contact with the customer and never activity,
-- exactly like a note from an import (GAP-12). So it is stored as an entry of type 'import_note', which every contact and
-- activity rule already leaves out (app.stamp_last_contact, app.mark_org_activation, the response-time reports and the
-- waiting-leads rule read the six contact types only; app.scheduled_no_activity, app.automation_run_facts,
-- app.automation_event_still_holds, app.deal_attention_rows and public.report_pipeline_cleanup skip 'import_note', bodies
-- of 20261006021050). Its metadata says what it is: {kind: 'whatsapp_import', via: 'import', ...}; it carries no
-- import_job_id, so app.import_record_worked counts it as work done on the record (a person attached a conversation),
-- which is what an undo of the record's import should see.
--
-- 1. public.whatsapp_chat_import(org, type, id, body, occurred_at, meta): the one writer. A person cannot insert an
--    'import_note' (activities_insert allows the six contact types only), so this is security definer, granted to
--    authenticated only. It refuses (42501, one answer for "no such record" and "not yours") unless the caller may EDIT
--    the record (app.can_edit_record: a writer of a writable business; members their own, managers their teams',
--    owners/admins all), a live lead, contact or deal of that business. Body 1..10,000 characters with no mention token
--    (hint whatsapp_import:mention; the app flattens them, so a chat never notifies anyone); occurred_at between 1990 and
--    now, with a minute of grace for clock skew, stored as least(occurred_at, now()) (hint whatsapp_import:occurred_at); metadata only the closed list of keys and types below (hint
--    whatsapp_import:meta), rebuilt here. The author is the caller (app.touch_row). Removing or changing one: the existing
--    activities policies, owners and admins only (GAP-12's rule for import notes).
-- 2. app.import_record_worked (body of 20261006021050, one condition made null-safe): it left out every import note whose
--    metadata.import_job_id equals the job being undone, but for an entry with no job id that comparison was NULL, so an
--    imported chat was skipped too. Now only the job's own notes are left out; a chat attached after the import is work, so
--    undo_own_import keeps the record (the chat would otherwise go to the bin with it).
-- 3. Search: app.search_notes (body of 20261006001700, one type wider) also finds 'import_note' entries, so a chat (and an
--    import's notes) is found by the global search like any logged entry. Still security invoker: RLS decides.
-- Every statement is safe to run twice.

create or replace function public.whatsapp_chat_import(
  p_org uuid, p_type text, p_id uuid, p_body text, p_occurred_at timestamptz, p_meta jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
  v_body text := btrim(p_body);
  v_key text;
  v_meta jsonb;
  v_names jsonb;
  v_first timestamptz;
  v_last timestamptz;
  v_id uuid;
begin
  if auth.uid() is null or p_org is null or p_id is null or p_type is null or p_type not in ('lead', 'contact', 'deal') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- a live record of this business the caller may edit; the same answer whether it is missing or not theirs
  if p_type = 'lead' then
    select app.can_edit_record(t.organization_id, t.owner_id, t.team_id) into v_ok
      from public.leads t where t.organization_id = p_org and t.id = p_id and t.deleted_at is null;
  elsif p_type = 'contact' then
    select app.can_edit_record(t.organization_id, t.owner_id, t.team_id) into v_ok
      from public.contacts t where t.organization_id = p_org and t.id = p_id and t.deleted_at is null;
  else
    select app.can_edit_record(t.organization_id, t.owner_id, t.team_id) into v_ok
      from public.deals t where t.organization_id = p_org and t.id = p_id and t.deleted_at is null;
  end if;
  if not coalesce(v_ok, false) or not coalesce(app.can_write(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if v_body is null or v_body = '' or char_length(v_body) > 10000 then
    raise exception 'the conversation text is empty or too long' using errcode = '22023', hint = 'whatsapp_import:body';
  end if;
  -- a mention would tell a colleague nothing here (the mention triggers serve a person's own entries): refused
  if coalesce(cardinality(app.mention_ids(v_body)), 0) > 0 then
    raise exception 'a conversation may not mention a colleague' using errcode = '22023', hint = 'whatsapp_import:mention';
  end if;
  -- a minute of grace for the server's clock against the database's; the entry is never dated after now
  if p_occurred_at is null or p_occurred_at > now() + interval '1 minute' or p_occurred_at < timestamptz '1990-01-01 00:00:00+00' then
    raise exception 'the conversation time is not valid' using errcode = '22023', hint = 'whatsapp_import:occurred_at';
  end if;

  -- the metadata: the closed list of keys, each of its type; rebuilt, so nothing else is stored
  if p_meta is null or jsonb_typeof(p_meta) <> 'object' then
    raise exception 'invalid metadata' using errcode = '22023', hint = 'whatsapp_import:meta';
  end if;
  for v_key in select jsonb_object_keys(p_meta) loop
    if v_key not in ('kind', 'via', 'first_message_at', 'last_message_at', 'message_count', 'kept_count', 'truncated',
                     'media_count', 'participants', 'participant_count') then
      raise exception 'invalid metadata' using errcode = '22023', hint = 'whatsapp_import:meta';
    end if;
  end loop;
  begin
    v_first := (p_meta ->> 'first_message_at')::timestamptz;
    v_last := (p_meta ->> 'last_message_at')::timestamptz;
  exception when others then
    raise exception 'invalid metadata' using errcode = '22023', hint = 'whatsapp_import:meta';
  end;
  v_names := p_meta -> 'participants';
  if coalesce(p_meta ->> 'kind', 'whatsapp_import') <> 'whatsapp_import'
     or coalesce(p_meta ->> 'via', 'import') <> 'import'
     or v_first is null or v_last is null or v_first > v_last or v_last > p_occurred_at + interval '1 minute'
     or v_first < timestamptz '1990-01-01 00:00:00+00'
     or jsonb_typeof(p_meta -> 'message_count') is distinct from 'number'
     or jsonb_typeof(p_meta -> 'kept_count') is distinct from 'number'
     or jsonb_typeof(p_meta -> 'media_count') is distinct from 'number'
     or jsonb_typeof(p_meta -> 'participant_count') is distinct from 'number'
     or jsonb_typeof(p_meta -> 'truncated') is distinct from 'boolean'
     or jsonb_typeof(v_names) is distinct from 'array'
     or jsonb_array_length(v_names) > 20
     or exists (select 1 from jsonb_array_elements(v_names) n
                 where jsonb_typeof(n) <> 'string' or char_length(n #>> '{}') not between 1 and 60)
     or (p_meta ->> 'message_count') !~ '^[0-9]{1,6}$' or (p_meta ->> 'message_count')::integer < 1
     or (p_meta ->> 'kept_count') !~ '^[0-9]{1,6}$'
     or (p_meta ->> 'kept_count')::integer not between 1 and (p_meta ->> 'message_count')::integer
     or (p_meta ->> 'media_count') !~ '^[0-9]{1,6}$'
     or (p_meta ->> 'media_count')::integer > (p_meta ->> 'message_count')::integer
     or (p_meta ->> 'participant_count') !~ '^[0-9]{1,6}$'
     or (p_meta ->> 'participant_count')::integer < jsonb_array_length(v_names) then
    raise exception 'invalid metadata' using errcode = '22023', hint = 'whatsapp_import:meta';
  end if;
  v_meta := jsonb_build_object(
    'kind', 'whatsapp_import',
    'via', 'import',
    'first_message_at', v_first,
    'last_message_at', v_last,
    'message_count', (p_meta ->> 'message_count')::integer,
    'kept_count', (p_meta ->> 'kept_count')::integer,
    'truncated', (p_meta ->> 'truncated')::boolean,
    'media_count', (p_meta ->> 'media_count')::integer,
    'participants', v_names,
    'participant_count', (p_meta ->> 'participant_count')::integer);

  -- the author is the caller (app.touch_row stamps auth.uid()); not a contact type, not activity
  insert into public.activities (organization_id, lead_id, contact_id, deal_id, type, body, occurred_at, metadata)
  values (p_org,
          case when p_type = 'lead' then p_id end,
          case when p_type = 'contact' then p_id end,
          case when p_type = 'deal' then p_id end,
          'import_note', v_body, least(p_occurred_at, now()), v_meta)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.whatsapp_chat_import(uuid, text, uuid, text, timestamptz, jsonb) from public, anon;
grant execute on function public.whatsapp_chat_import(uuid, text, uuid, text, timestamptz, jsonb) to authenticated;

-- timeline notes and logged calls, meetings and messages (not system entries), and since WAB-07 notes from an import
-- and imported WhatsApp chats ('import_note'); body of 20261006001700, one type wider
create or replace function app.search_notes(p_org uuid, p_q text, p_like text, p_limit integer) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select a.id, a.type, left(a.body, 160) as body, a.occurred_at, a.lead_id, a.contact_id, a.company_id, a.deal_id
      from public.activities a
     where a.organization_id = p_org and a.body is not null
       and a.type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms', 'import_note')
       and (app.search_norm(a.body) like p_like or p_q operator(extensions.<%) app.search_norm(a.body))
     order by a.occurred_at desc
     limit p_limit) x;
$$;
revoke all on function app.search_notes(uuid, text, text, integer) from public, anon;
grant execute on function app.search_notes(uuid, text, text, integer) to authenticated;

-- the job's own notes are part of the import; any other entry after the import (an imported chat included) is work
CREATE OR REPLACE FUNCTION app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamp with time zone, p_job uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- RVW-36: an imported task is worked on when a checklist step was added after the import or any step is done
  if p_type = 'task' then
    return exists (select 1 from public.task_checklist_items x
                    where x.organization_id = p_org and x.task_id = p_id
                      and (x.created_at > p_since or x.done_at is not null))
        -- TASK-06 part B: a sub-task added under it (an import makes none)
        or exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- no other records are linked to an imported task; its own row and its steps are the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3
                                          and not (x.type = ''import_note'' and coalesce(x.metadata ->> ''import_job_id'' = $4::text, false)))
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since, p_job;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    -- CNS-05: the import's own consents are part of the import, not work on the record
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since
                    and x.import_job_id is distinct from p_job)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        -- ORD-01: an order is always made after the import
        or exists (select 1 from public.orders x where x.organization_id = p_org and p_id in (x.contact_id, x.delivery_contact_id))
        -- DOC-01: a document is always recorded after the import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.contact_id = p_id)
        -- PAY-01: a payment is always recorded after the import
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.contact_id = p_id)
        -- COL-05: a hold is always set after the import
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job));
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$function$;
