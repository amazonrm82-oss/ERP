-- =============================================================================
-- GAP-12 (wave 2): history in an import, for a business with years of data
-- =============================================================================
-- 1. The original creation date. `original_created_on` (a plain date) on leads, contacts, companies and deals. It is a
--    column of its own, never `created_at`: `created_at` stays "when the record entered this system", which every timing
--    rule reads (SPD-06 response time, GAP-06 activation, PRV-01 retention, the "no activity" automation, import undo's
--    "unchanged" test, the waiting-leads clock). So an old original date moves none of them: a lead imported today with a
--    2012 date is measured from today by retention, and is never a waiting lead (imports are left out, MNY-01 / SPD-02).
--    Only an import writes it: a person's insert may carry it only together with an `import_job_id` (which
--    app.guard_import_tag accepts only for the caller's own running import of that type); nobody in the browser changes
--    it later (leads and contacts get an INSERT grant only; companies and deals, which have table grants, are refused by
--    the trigger). Server writers pass. It is not before 1990 and not in the future (hint `import:original_date`).
-- 2. Notes. `public.import_record_notes(org, job, items)` (definer, authenticated: `app.can_import`, the caller's own
--    RUNNING import of leads, contacts, companies or deals, 1,000 items a call) writes one timeline entry of type
--    'import_note' per item: author = the importer, `metadata` = {kind: 'import_note', import_job_id}, the note's date at
--    12:00 in the business's zone (else the record's original date, else now), never later than now. A record the job
--    created, or for an update-mode job any record the caller may edit (accepted as is in review: the same rule as the
--    update itself). Running the same file again adds nothing twice: an item whose record already has an import note
--    with the same text on the same day (of any job) is answered 'exists' and skipped. The type is not one of the six contact types, so it is never "contact"
--    (last contact, response time, activation, lead score, waiting leads, money waiting, retention); a person cannot
--    write one (the insert policy allows the contact types only) and only an admin may change or remove one (the
--    existing update/delete policies: an owner or admin removes a wrong one like any entry). It is not activity either:
--    app.scheduled_no_activity, app.automation_run_facts and app.automation_event_still_holds (bodies of
--    20261006020965 / 20261006021000) skip it beside 'automation_note', and a deal's "last activity"
--    (app.deal_attention_rows of 20261006020870, public.report_pipeline_cleanup of 20261006014400, kept in step) counts
--    only authored entries that are not import notes.
--    Undo: the job's own records go to the recycle bin with their notes (restore brings both back); notes on records an
--    update-mode job changed stay, like the update itself ("updates are not reverted"). app.import_record_worked
--    (body of 20261006020985) does not count the job's own notes as work, so a member's undo_own_import still moves them.
-- Every statement is safe to run twice. Nothing is removed.

alter table public.leads add column if not exists original_created_on date;
alter table public.contacts add column if not exists original_created_on date;
alter table public.companies add column if not exists original_created_on date;
alter table public.deals add column if not exists original_created_on date;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['leads', 'contacts', 'companies', 'deals'] loop
    if not exists (select 1 from pg_constraint
                    where conrelid = format('public.%I', v_table)::regclass and conname = v_table || '_original_created_on_range') then
      execute format('alter table public.%I add constraint %I check (original_created_on >= date ''1990-01-01'')',
                     v_table, v_table || '_original_created_on_range');
    end if;
  end loop;
end;
$$;

comment on column public.leads.original_created_on is 'GAP-12: the creation date in the system the record was imported from; written by an import only.';
comment on column public.contacts.original_created_on is 'GAP-12: the creation date in the system the record was imported from; written by an import only.';
comment on column public.companies.original_created_on is 'GAP-12: the creation date in the system the record was imported from; written by an import only.';
comment on column public.deals.original_created_on is 'GAP-12: the creation date in the system the record was imported from; written by an import only.';

-- leads and contacts have column grants (0038, 0073): the import's insert sends it; no update grant
grant insert (original_created_on) on public.leads to authenticated;
grant insert (original_created_on) on public.contacts to authenticated;

-- security invoker on purpose: current_user tells a browser write from a server one
create or replace function app.original_created_on_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'UPDATE' then
      if new.original_created_on is distinct from old.original_created_on then
        raise exception 'the original creation date is written by an import only'
          using errcode = 'P0001', hint = 'import:original_date_fixed';
      end if;
    elsif new.original_created_on is not null and new.import_job_id is null then
      -- app.guard_import_tag checks the job itself: the caller's own running import of this type
      raise exception 'the original creation date is written by an import only'
        using errcode = 'P0001', hint = 'import:original_date_fixed';
    end if;
  end if;
  if new.original_created_on is not null
     and (tg_op = 'INSERT' or new.original_created_on is distinct from old.original_created_on)
     -- the furthest zone ahead (UTC+14): never refuses a business's today
     and (new.original_created_on < date '1990-01-01'
          or new.original_created_on > (now() at time zone 'Pacific/Kiritimati')::date) then
    raise exception 'the original creation date is out of range'
      using errcode = 'P0001', hint = 'import:original_date';
  end if;
  return new;
end;
$$;

revoke all on function app.original_created_on_check() from public, anon, authenticated;

create or replace trigger leads_original_created_on before insert or update of original_created_on on public.leads
  for each row execute function app.original_created_on_check();
create or replace trigger contacts_original_created_on before insert or update of original_created_on on public.contacts
  for each row execute function app.original_created_on_check();
create or replace trigger companies_original_created_on before insert or update of original_created_on on public.companies
  for each row execute function app.original_created_on_check();
create or replace trigger deals_original_created_on before insert or update of original_created_on on public.deals
  for each row execute function app.original_created_on_check();

-- Notes of an import: one 'import_note' timeline entry per item. Answers, per item: 'written', 'exists' (the record has
-- this note on this day already), 'refused' (not a record this job may annotate) or 'invalid' (no record id, an empty or
-- too long text, a date that is not a valid day between 1990 and the business's today).
create or replace function public.import_record_notes(p_org uuid, p_job uuid, p_items jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job record;
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_result text;
  v_record uuid;
  v_body text;
  v_date text;
  v_day date;
  v_ok boolean;
  v_original date;
  v_zone text;
  v_today date;
  v_at timestamptz;
  v_seen boolean;
begin
  if auth.uid() is null or p_org is null or p_job is null or not coalesce(app.can_import(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the caller's own running import in this business (the rule of app.guard_import_tag); held until this call commits,
  -- so the job is not finished and undone while its notes are still written
  select j.entity_type, j.duplicate_mode into v_job
    from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'running'
     and j.entity_type in ('lead', 'contact', 'company', 'deal')
     for share;
  if not found then
    raise exception 'not a running import of this user' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be an array' using errcode = '22023', hint = 'import_note:items';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'too many notes in one call' using errcode = 'P0001', hint = 'import_note:too_many';
  end if;
  select coalesce(nullif(o.timezone, ''), 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = p_org;
  v_today := (now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date;

  for v_item in select e from jsonb_array_elements(p_items) as e loop
    v_result := null;
    v_record := null;
    v_day := null;
    v_ok := null;
    v_original := null;
    v_seen := null;
    v_body := case when jsonb_typeof(v_item) = 'object' then btrim(v_item ->> 'body') end;
    v_date := case when jsonb_typeof(v_item) = 'object' then nullif(btrim(v_item ->> 'date'), '') end;
    if jsonb_typeof(v_item) = 'object' then
      begin
        v_record := (v_item ->> 'record_id')::uuid;
      exception when others then
        v_record := null;
      end;
    end if;
    if v_date is not null then
      if v_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        begin
          v_day := v_date::date;
        exception when others then
          v_day := null;
        end;
      end if;
      if v_day is null or v_day < date '1990-01-01' or v_day > v_today then
        v_result := 'invalid';
      end if;
    end if;
    if v_record is null or v_body is null or v_body = '' or char_length(v_body) > 5000 then
      v_result := 'invalid';
    end if;
    if v_result is null then
      if v_job.entity_type = 'lead' then
        select true, t.original_created_on into v_ok, v_original from public.leads t
         where t.organization_id = p_org and t.id = v_record and t.deleted_at is null
           and (t.import_job_id = p_job
                or (v_job.duplicate_mode = 'update' and app.can_edit_record(t.organization_id, t.owner_id, t.team_id)));
      elsif v_job.entity_type = 'contact' then
        select true, t.original_created_on into v_ok, v_original from public.contacts t
         where t.organization_id = p_org and t.id = v_record and t.deleted_at is null
           and (t.import_job_id = p_job
                or (v_job.duplicate_mode = 'update' and app.can_edit_record(t.organization_id, t.owner_id, t.team_id)));
      elsif v_job.entity_type = 'company' then
        select true, t.original_created_on into v_ok, v_original from public.companies t
         where t.organization_id = p_org and t.id = v_record and t.deleted_at is null
           and (t.import_job_id = p_job
                or (v_job.duplicate_mode = 'update' and app.can_edit_record(t.organization_id, t.owner_id, t.team_id)));
      else
        select true, t.original_created_on into v_ok, v_original from public.deals t
         where t.organization_id = p_org and t.id = v_record and t.deleted_at is null
           and (t.import_job_id = p_job
                or (v_job.duplicate_mode = 'update' and app.can_edit_record(t.organization_id, t.owner_id, t.team_id)));
      end if;
      if not coalesce(v_ok, false) then
        v_result := 'refused';
      else
        v_at := least(case when v_day is not null then (v_day + time '12:00') at time zone v_zone
                           when v_original is not null then (v_original + time '12:00') at time zone v_zone
                           else now() end, now());
        -- the same file imported again: the same text on the same day of the same record is there already (any job);
        -- found through the record's own foreign key, the text compared as a filter
        if v_job.entity_type = 'lead' then
          select true into v_seen from public.activities a
           where a.organization_id = p_org and a.lead_id = v_record and a.type = 'import_note' and a.body = v_body
             and (a.occurred_at at time zone v_zone)::date = (v_at at time zone v_zone)::date limit 1;
        elsif v_job.entity_type = 'contact' then
          select true into v_seen from public.activities a
           where a.organization_id = p_org and a.contact_id = v_record and a.type = 'import_note' and a.body = v_body
             and (a.occurred_at at time zone v_zone)::date = (v_at at time zone v_zone)::date limit 1;
        elsif v_job.entity_type = 'company' then
          select true into v_seen from public.activities a
           where a.organization_id = p_org and a.company_id = v_record and a.type = 'import_note' and a.body = v_body
             and (a.occurred_at at time zone v_zone)::date = (v_at at time zone v_zone)::date limit 1;
        else
          select true into v_seen from public.activities a
           where a.organization_id = p_org and a.deal_id = v_record and a.type = 'import_note' and a.body = v_body
             and (a.occurred_at at time zone v_zone)::date = (v_at at time zone v_zone)::date limit 1;
        end if;
        if coalesce(v_seen, false) then
          v_result := 'exists';
        end if;
      end if;
      if v_result is null then
        -- the author is the importer (app.touch_row stamps auth.uid()); not a contact type, not activity
        insert into public.activities (organization_id, lead_id, contact_id, company_id, deal_id, type, body, occurred_at, metadata)
        values (p_org,
                case when v_job.entity_type = 'lead' then v_record end,
                case when v_job.entity_type = 'contact' then v_record end,
                case when v_job.entity_type = 'company' then v_record end,
                case when v_job.entity_type = 'deal' then v_record end,
                'import_note', v_body, v_at,
                jsonb_build_object('kind', 'import_note', 'import_job_id', p_job));
        v_result := 'written';
      end if;
    end if;
    v_out := v_out || to_jsonb(v_result);
  end loop;
  return v_out;
end;
$$;

revoke all on function public.import_record_notes(uuid, uuid, jsonb) from public, anon;
grant execute on function public.import_record_notes(uuid, uuid, jsonb) to authenticated;

-- An import's notes are history, not activity: the "no activity" scan and the AUT-06 retry's mirror of it skip them
-- (bodies of 20261006020965 and 20261006021000, one condition wider).

CREATE OR REPLACE FUNCTION app.scheduled_no_activity(p_auto public.automations)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_after_at timestamptz;
  v_after_id uuid;
  v_days integer := greatest(coalesce((p_auto.trigger_config ->> 'days')::int, 3), 1);
  v_fk text := p_auto.entity_type || '_id';
  v_extra text := case p_auto.entity_type when 'lead' then ' and t.converted_at is null'
                                          when 'deal' then ' and t.status = ''open''' else '' end;
begin
  select c.after_at, c.after_id into v_after_at, v_after_id from app.scan_cursor_get(p_auto) c;
  loop
    v_page := 0;
    for v_row in execute format(
      'select x.id, x.last_at from (
         select t.id, coalesce((select max(a.occurred_at) from public.activities a where a.%I = t.id and a.type not in (''automation_note'', ''import_note'')
                             and not (a.type = ''system'' and coalesce(a.metadata ->> ''kind'', '''') = ''record_link_removed'')), t.created_at) as last_at
           from public.%I t
          where t.organization_id = $1 and t.deleted_at is null %s
       ) x
       where x.last_at < now() - make_interval(days => $2)
         and (x.last_at, x.id) > ($3, $4)
         and not exists (select 1 from public.automation_runs r
                          where r.automation_id = $5 and r.run_key = ''noact:'' || x.id || '':'' || x.last_at)
       order by x.last_at, x.id
       limit $6', v_fk, app.automation_table(p_auto.entity_type), v_extra)
      using p_auto.organization_id, v_days, v_after_at, v_after_id, p_auto.id, v_page_size
    loop
      v_page := v_page + 1;
      v_after_at := v_row.last_at;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'noact:' || v_row.id || ':' || v_row.last_at) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: the next run starts again from the oldest record
      perform app.scan_cursor_set(p_auto, '-infinity', '00000000-0000-0000-0000-000000000000');
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, v_after_at, v_after_id);
      exit;
    end if;
  end loop;
  return v_count;
end;
$function$

;

CREATE OR REPLACE FUNCTION app.automation_run_facts(p_trigger text, p_config jsonb, p_entity text, p_org uuid, p_id uuid, p_run_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_record jsonb;
  v_text text;
  v_payment text;
  v_payload jsonb;
  v_last timestamptz;
begin
  case p_trigger
    when 'created', 'deal_won', 'deal_lost', 'task_completed' then
      return '{}'::jsonb;
    when 'field_changed' then
      v_record := app.automation_record(p_entity, p_org, p_id);
      if v_record is null or (p_config ->> 'field') is null then
        return null;
      end if;
      -- AUT-03: a custom field ('cf:<key>') reads its stored value
      return jsonb_build_object('value', app.automation_field_value(v_record, p_config ->> 'field'));
    when 'no_activity' then
      -- the last activity when the run ends, by the rule of the check below (and of app.scheduled_no_activity), so the
      -- run's own timeline entries (a status or stage change by its steps) count as seen; only later activity ends retries
      if p_entity not in ('lead', 'contact', 'company', 'deal') then
        return null;
      end if;
      execute format(
        'select coalesce((select max(a.occurred_at) from public.activities a
                           where a.organization_id = $1 and a.%I = $2 and a.type not in (''automation_note'', ''import_note'')
                             and not (a.type = ''system'' and coalesce(a.metadata ->> ''kind'', '''') = ''record_link_removed'')),
                         (select t.created_at from public.%I t where t.organization_id = $1 and t.id = $2))',
        p_entity || '_id', app.automation_table(p_entity))
        into v_last using p_org, p_id;
      return case when v_last is not null then jsonb_build_object('last_at', v_last) end;
    when 'stuck_in_stage' then
      v_text := substring(p_run_key from '^stuck:[0-9a-f-]{36}:(.+)$');
      if v_text is null then
        return null;
      end if;
      return (select jsonb_build_object('stage_id', d.stage_id, 'stage_entered_at', v_text::timestamptz)
                from public.deals d where d.organization_id = p_org and d.id = p_id);
    when 'task_due_soon' then
      v_text := substring(p_run_key from '^due:[0-9a-f-]{36}:(.+)$');
      return case when v_text is not null then jsonb_build_object('due_at', v_text::timestamptz) end;
    when 'birthday' then
      return (select jsonb_build_object('birth_date', c.birth_date)
                from public.contacts c where c.organization_id = p_org and c.id = p_id and c.birth_date is not null);
    when 'date_reached' then
      v_text := substring(p_run_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})$');
      return case when v_text is not null then jsonb_build_object('day', v_text::date) end;
    when 'payment_received', 'payment_confirmed', 'quote_viewed', 'quote_accepted', 'quote_declined', 'quote_expired', 'document_recorded', 'meeting_scheduled', 'meeting_cancelled', 'meeting_no_show' then
      v_text := substring(p_run_key from '^event:([0-9]{1,18})$');
      if v_text is null then
        return null;
      end if;
      -- the outbox event of the run's own type; its payload names the payment, quote, document or meeting
      select e.payload into v_payload from public.outbox_events e
       where e.organization_id = p_org and e.id = v_text::bigint and e.event_type = p_trigger;
      if v_payload is null then
        return null;
      end if;
      if p_trigger like 'payment_%' then
        return case when v_payload ->> 'payment_id' is not null then jsonb_build_object('payment_id', (v_payload ->> 'payment_id')::uuid) end;
      elsif p_trigger like 'quote_%' then
        return case when v_payload ->> 'quote_id' is not null then jsonb_build_object('quote_id', (v_payload ->> 'quote_id')::uuid) end;
      elsif p_trigger = 'document_recorded' then
        return case when v_payload ->> 'document_id' is not null then jsonb_build_object('document_id', (v_payload ->> 'document_id')::uuid) end;
      elsif p_trigger = 'meeting_scheduled' then
        return case when v_payload ->> 'meeting_id' is not null and v_payload ->> 'starts_at' is not null
                    then jsonb_build_object('meeting_id', (v_payload ->> 'meeting_id')::uuid,
                                            'starts_at', (v_payload ->> 'starts_at')::timestamptz) end;
      else
        return case when v_payload ->> 'meeting_id' is not null then jsonb_build_object('meeting_id', (v_payload ->> 'meeting_id')::uuid) end;
      end if;
    when 'debt_overdue' then
      -- AUT-04 follow-up: the document and the due date the scan saw, from the run key
      v_text := substring(p_run_key from '^debt:([0-9a-f-]{36}):[0-9]{4}-[0-9]{2}-[0-9]{2}:');
      if v_text is null then
        return null;
      end if;
      return jsonb_build_object('document_id', v_text::uuid,
                                'due_date', substring(p_run_key from '^debt:[0-9a-f-]{36}:([0-9]{4}-[0-9]{2}-[0-9]{2}):')::date);
    when 'form_submitted' then
      -- AUT-03: the form the inquiry came through, from the run's own outbox event
      v_text := substring(p_run_key from '^event:([0-9]{1,18})$');
      if v_text is null then
        return null;
      end if;
      select e.payload into v_payload from public.outbox_events e
       where e.organization_id = p_org and e.id = v_text::bigint and e.event_type = 'form_submitted';
      return case when v_payload ->> 'form_id' is not null then jsonb_build_object('form_id', (v_payload ->> 'form_id')::uuid) end;
    when 'schedule' then
      -- AUT-03: the scheduled time the run belongs to, from the run key sched:<record>:<YYYY-MM-DDTHH:MI>
      v_text := substring(p_run_key from '^sched:[0-9a-f-]{36}:([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})$');
      return case when v_text is not null then jsonb_build_object('slot', v_text) end;
    when 'manual' then
      -- AUT-03: a manual rule (run from the card's button, 'button:' key) has no facts, so AUT-06 never retries it
      return null;
    else
      -- a trigger type without a decision: never retried
      return null;
  end case;
exception when others then
  return null;
end;
$function$

;

CREATE OR REPLACE FUNCTION app.automation_event_still_holds(p_trigger text, p_config jsonb, p_entity text, p_org uuid, p_id uuid, p_record jsonb, p_facts jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_field text := p_config ->> 'field';
  v_last timestamptz;
  v_zone text;
  v_type text;
  v_day date;
begin
  if p_facts is null or p_record is null then
    return false;
  end if;
  case p_trigger
    when 'created' then
      return true;
    when 'deal_won' then
      return coalesce(p_record ->> 'status' = 'won', false);
    when 'deal_lost' then
      return coalesce(p_record ->> 'status' = 'lost', false);
    when 'task_completed' then
      return coalesce(p_record ->> 'status' = 'done', false);
    when 'field_changed' then
      if v_field is null then
        return false;
      end if;
      -- AUT-03: a custom field ('cf:<key>') reads its stored value
      if (p_config ->> 'to') is not null then
        return app.automation_field_value(p_record, v_field) #>> '{}' is not distinct from p_config ->> 'to';
      end if;
      return p_facts ? 'value' and app.automation_field_value(p_record, v_field) is not distinct from (p_facts -> 'value');
    when 'no_activity' then
      if p_entity not in ('lead', 'contact', 'company', 'deal')
         or (p_entity = 'lead' and (p_record ->> 'converted_at') is not null)
         or (p_entity = 'deal' and p_record ->> 'status' is distinct from 'open') then
        return false;
      end if;
      execute format(
        'select coalesce((select max(a.occurred_at) from public.activities a
                           where a.organization_id = $1 and a.%I = $2 and a.type not in (''automation_note'', ''import_note'')
                             and not (a.type = ''system'' and coalesce(a.metadata ->> ''kind'', '''') = ''record_link_removed'')),
                         (select t.created_at from public.%I t where t.organization_id = $1 and t.id = $2))',
        p_entity || '_id', app.automation_table(p_entity))
        into v_last using p_org, p_id;
      return coalesce(v_last = (p_facts ->> 'last_at')::timestamptz, false);
    when 'stuck_in_stage' then
      return coalesce(p_entity = 'deal' and p_record ->> 'status' = 'open'
                      and p_record ->> 'stage_id' = p_facts ->> 'stage_id'
                      and (p_record ->> 'stage_entered_at')::timestamptz = (p_facts ->> 'stage_entered_at')::timestamptz, false);
    when 'task_due_soon' then
      return coalesce(p_entity = 'task' and p_record ->> 'status' = 'open'
                      and (p_record ->> 'due_at')::timestamptz = (p_facts ->> 'due_at')::timestamptz, false);
    when 'birthday' then
      return coalesce(p_entity = 'contact' and (p_record ->> 'birth_date')::date = (p_facts ->> 'birth_date')::date, false);
    when 'date_reached' then
      if v_field is null
         or (p_entity = 'lead' and (p_record ->> 'converted_at') is not null)
         or (p_entity = 'deal' and v_field = 'expected_close_date' and p_record ->> 'status' is distinct from 'open')
         or (p_entity = 'task' and v_field = 'due_at' and p_record ->> 'status' is distinct from 'open') then
        return false;
      end if;
      select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
      v_zone := coalesce(v_zone, 'Asia/Jerusalem');
      if v_field like 'cf:%' then
        if p_entity not in ('lead', 'contact', 'company', 'deal') then
          return false;
        end if;
        select f.field_type into v_type from public.field_definitions f
         where f.organization_id = p_org and f.object_type = p_entity and f.key = substr(v_field, 4) and f.is_active
           and f.field_type in ('date', 'datetime');
        if v_type is null then
          return false;
        end if;
        v_day := app.automation_value_day(p_record -> 'custom_fields' ->> substr(v_field, 4), v_type, v_zone);
      elsif v_field = any (app.automation_date_fields(p_entity)) then
        if v_field in ('created_at', 'due_at') then
          v_day := ((p_record ->> v_field)::timestamptz at time zone v_zone)::date;
        else
          v_day := (p_record ->> v_field)::date;
        end if;
      else
        return false;
      end if;
      return coalesce(v_day = (p_facts ->> 'day')::date, false);
    when 'payment_received' then
      return exists (select 1 from public.payments p
                      where p.organization_id = p_org and p.id = (p_facts ->> 'payment_id')::uuid
                        and p.status not in ('cancelled', 'failed', 'refunded'));
    -- AUT-04: the quote, document or meeting is still in the state the event put it in
    when 'quote_viewed', 'quote_accepted', 'quote_declined', 'quote_expired' then
      return exists (select 1 from public.quotes q
                      where q.organization_id = p_org and q.id = (p_facts ->> 'quote_id')::uuid
                        and q.status = case p_trigger when 'quote_viewed' then 'viewed' when 'quote_accepted' then 'accepted'
                                                      when 'quote_declined' then 'rejected' else 'expired' end);
    when 'document_recorded' then
      return exists (select 1 from public.accounting_documents d
                      where d.organization_id = p_org and d.id = (p_facts ->> 'document_id')::uuid and d.status = 'active');
    when 'meeting_scheduled' then
      return exists (select 1 from public.meetings mt
                      where mt.organization_id = p_org and mt.id = (p_facts ->> 'meeting_id')::uuid and mt.status = 'planned'
                        and mt.starts_at = (p_facts ->> 'starts_at')::timestamptz);
    when 'meeting_cancelled', 'meeting_no_show' then
      return exists (select 1 from public.meetings mt
                      where mt.organization_id = p_org and mt.id = (p_facts ->> 'meeting_id')::uuid
                        and mt.status = case p_trigger when 'meeting_cancelled' then 'cancelled' else 'no_show' end);
    when 'debt_overdue' then
      -- the document is still active, its due date unchanged and its balance still above zero (app.document_balance)
      return exists (select 1 from public.accounting_documents d
                      where d.organization_id = p_org and d.id = (p_facts ->> 'document_id')::uuid and d.status = 'active'
                        and d.due_date = (p_facts ->> 'due_date')::date)
         and app.document_balance(p_org, (p_facts ->> 'document_id')::uuid) > 0;
    when 'payment_confirmed' then
      -- the payment is still confirmed (not moved back to recorded, failed, refunded or cancelled)
      return exists (select 1 from public.payments p
                      where p.organization_id = p_org and p.id = (p_facts ->> 'payment_id')::uuid and p.status = 'confirmed');
    when 'form_submitted' then
      -- AUT-03: a sent inquiry stays sent (the rule unchanged since the run is checked by the caller)
      return p_facts ? 'form_id';
    when 'schedule' then
      -- AUT-03: the record is still one the schedule runs on (app.schedule_record_open: a lead not converted, an open deal)
      return p_facts ? 'slot' and app.schedule_record_open(p_entity, p_record);
    when 'manual' then
      -- AUT-03: a run from the card's button is never retried
      return false;
    else
      -- a trigger type without a decision is never retried
      return false;
  end case;
end;
$function$

;

-- The job's own notes are part of the import, not work on the record (body of 20261006020985, one condition wider).
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
                                          and not (x.type = ''import_note'' and x.metadata ->> ''import_job_id'' = $4::text))
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
$function$

;

-- A deal's "last activity" (the stuck list, the board, the weekly cleanup) leaves out import notes: history, not work
-- (bodies of 20261006020870 and 20261006014400, one condition wider; the two copies stay in step, test 93).
CREATE OR REPLACE FUNCTION app.deal_attention_rows(p_org uuid, p_pipeline uuid, p_owner uuid, p_days integer, p_ids uuid[])
 RETURNS TABLE(id uuid, name text, amount_agorot bigint, owner_id uuid, pipeline_id uuid, stage_name text, limit_days integer, stage_entered_at timestamp with time zone, days_in_stage integer, snoozed_until date, last_activity_at timestamp with time zone, idle_days integer, next_task_at timestamp with time zone, next_meeting_at timestamp with time zone, stuck boolean, postponed boolean, no_next_step boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with today as (
    select (now() at time zone coalesce(
             (select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date as d
  )
  select x.id, x.name, x.amount_agorot, x.owner_id, x.pipeline_id, x.stage_name,
         x.limit_days, x.stage_entered_at, x.days_in_stage, x.snoozed_until,
         x.last_activity_at, x.idle_days, x.next_task_at, x.next_meeting_at,
         (x.days_in_stage > x.limit_days
          and (x.snoozed_until is null or x.snoozed_until <= (select d from today))) as stuck,
         (x.days_in_stage > x.limit_days
          and x.snoozed_until is not null and x.snoozed_until > (select d from today)) as postponed,
         (x.next_task_at is null and x.next_meeting_at is null) as no_next_step
    from (
      select d.id, d.name, d.amount_agorot::bigint as amount_agorot, d.owner_id, d.pipeline_id, s.name as stage_name,
             coalesce(s.rot_days, greatest(coalesce(p_days, 14), 1))::integer as limit_days,
             d.stage_entered_at,
             greatest(floor(extract(epoch from now() - d.stage_entered_at) / 86400), 0)::integer as days_in_stage,
             d.snoozed_until,
             la.last_at as last_activity_at,
             greatest(floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400), 0)::integer as idle_days,
             (select min(coalesce(t.due_at, t.created_at)) from public.tasks t
               where t.organization_id = d.organization_id and t.deal_id = d.id
                 and t.status = 'open' and t.deleted_at is null) as next_task_at,
             (select min(m.starts_at) from public.meetings m
               where m.organization_id = d.organization_id and m.deal_id = d.id
                 and m.status = 'planned' and m.ends_at > now()) as next_meeting_at
        from public.deals d
        join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
        left join lateral (
          select max(a.occurred_at) as last_at from public.activities a
           where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null and a.type <> 'import_note'
             and not (a.type = 'system' and a.metadata ->> 'kind' = 'snooze_cleared')
        ) la on true
       where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
         and (p_pipeline is null or d.pipeline_id = p_pipeline)
         and (p_owner is null or d.owner_id = p_owner)
         and (p_ids is null or d.id = any (p_ids))
    ) x
$function$

;

CREATE OR REPLACE FUNCTION public.report_pipeline_cleanup(p_org uuid, p_owner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with cur as (
    select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today
      from public.organizations o
     where o.id = p_org
  ), x as (
    select d.id, d.name, d.owner_id, d.pipeline_id, d.stage_id, s.name as stage_name, s.position as stage_position,
           d.amount_agorot, d.contact_id, d.expected_close_date, d.snoozed_until,
           coalesce(s.rot_days, 14) as limit_days,
           greatest(floor(extract(epoch from now() - d.stage_entered_at) / 86400), 0)::int as days_in_stage,
           la.last_at as last_activity_at,
           greatest(floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400), 0)::int as idle_days
      from public.deals d
      join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
      left join lateral (
        select max(a.occurred_at) as last_at from public.activities a
         where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null and a.type <> 'import_note'
           and not (a.type = 'system' and a.metadata ->> 'kind' = 'snooze_cleared')
      ) la on true
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
       and (p_owner is null or d.owner_id = p_owner)
       and exists (select 1 from cur)
  ), y as (
    select x.*,
           (x.snoozed_until is null or x.snoozed_until <= (select today from cur)) as awake,
           (x.days_in_stage > x.limit_days) as over_limit,
           (x.expected_close_date is not null and x.expected_close_date < (select today from cur)) as past_close
      from x
  ), r as (
    select y.id, y.name, y.owner_id, y.pipeline_id, y.stage_id, y.stage_name, y.stage_position, y.amount_agorot,
           y.contact_id, y.expected_close_date, y.days_in_stage, y.limit_days, y.last_activity_at, y.idle_days,
           (y.over_limit and y.awake) as stuck,
           (y.past_close and y.awake) as overdue
      from y
     where y.awake and (y.over_limit or y.past_close)
  )
  select jsonb_build_object(
    'today', (select today from cur),
    'stuck', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(r.amount_agorot), 0)) from r where r.stuck),
    'overdue', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(r.amount_agorot), 0)) from r where r.overdue and not r.stuck),
    'deals', coalesce((
      select jsonb_agg(z order by z.last_activity_at asc nulls first, z.days_in_stage desc, z.amount_agorot desc, z.id)
        from (
          select r.* from r
           order by r.last_activity_at asc nulls first, r.days_in_stage desc, r.amount_agorot desc, r.id
           limit 300
        ) z), '[]'::jsonb))
  where exists (select 1 from cur);
$function$

;
