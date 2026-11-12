-- =============================================================================
-- LIB-02, the owner's answers of 12 November 2026: (292) ב, (293) ב, (294) ב, (296) ג
-- =============================================================================
-- * (292) ב: the rep is told only on a link's FIRST opening. Every business day the customer opens the link (the first day
--   included, lead's reading: the timeline lists each day with an opening) writes one `system` entry on the link's record,
--   with no author: metadata {kind: 'library_viewed', library_link_id}, body "הלקוח פתח את הקישור מהספרייה: <item title>"
--   (the item's title only; nothing of the customer). At most one entry per link and business day, so a refresh does not
--   flood the timeline: app.library_link_secrets.notified_on (021229) now holds the business day of the last entry written.
--   A person (owners and admins too) never writes, changes or deletes such an entry: app.activities_library_entry_guard
--   (invoker, the pattern of app.activities_money_entry_guard, hint activity:library_entry); its author is cleared by
--   activities_zz_library_entry_author. The entry is not contact (not in app.contact_types()) and not activity: the three
--   rules that skip record_link_removed skip it too (app.scheduled_no_activity, body of 20261006021091;
--   app.automation_run_facts and app.automation_event_still_holds, bodies of 20261006021139; each with one changed line,
--   `= 'record_link_removed'` -> `in ('record_link_removed', 'library_viewed')`, and nothing else). app.deal_attention_rows
--   and public.report_pipeline_cleanup count only entries with an author (`a.created_by is not null`), so they skip it
--   unchanged. Privacy: the entry sits on the link's record only and holds no personal data (the item's title, the link's
--   id); a purge of the record removes it (app.purge_links: an entry of that record alone), and app.audit_erase_core, which
--   reaches the record's entries by their ids (app.activity_audit_links), needs no new line: after the erasure no log line
--   carries the entry (db test 342).
-- * (296) ג: when the link's maker is no longer an active member who reads the record, the first-opening notice goes to the
--   active owners and admins of the business instead (kind library_viewed, the item's title only). The link keeps serving.
--   app.library_link_mark_viewed is redefined (body of 20261006021229 with these two changes).
-- * (294) ב: whoever may edit the record (app.can_edit_record on its owner and team, in a writable business) may turn a link
--   off too, beside its maker and owners/admins. public.library_link_revoke is redefined (body of 20261006021229 plus the
--   record's owner and team and that one condition).
-- * (293) ב: a link item no longer opens straight away: the page's button goes to /f/lib/<token>/go, which shows the page
--   "אתם עוברים לאתר [domain]. [business] אחראי לתוכן שלו" of BIZ-03 (src/features/qr-codes/interstitial.ts, its escaping and
--   punycode rule), never framed. The address comes only from the stored item: public.library_link_public_link(token, ip_hash)
--   (service_role only; the page's lookup, rule and counters of app.library_link_take: a call of the link, not a view)
--   answers only the item's https link and the business's display name (organizations.name), and "not found" for a file item.
-- * BIZ-03's emergency switch (app.qr_external_blocks, 021088 / 021092; review of 12 November 2026) covers library link items:
--   - public.library_link_public_link (new here) answers "not found" while app.qr_external_off(business) holds, judged by
--     the token's SHA-256 alone BEFORE app.library_link_take, so nothing is counted, as public.qr_scan does;
--   - public.library_link_public is redefined: body of 20261006021229 plus exactly these lines: the declaration
--     `v_external_off boolean;`, the assignment `v_external_off := v_item.kind = 'link' and app.qr_external_off(...)`
--     after the file lookup, and in the item object the 'url' line changed to `case when v_item.kind = 'link' and not
--     v_external_off then v_item.url end` plus the new key `'external_blocked', v_external_off` (with their comments).
--     The view is counted as before (the customer opened the page); the page shows no button while it is true.
--   Internal targets (file items) are untouched.
-- * Merge: app.merge_move_links (definer) moves a duplicate's activities, library_viewed entries included; the guard lets
--   it pass because current_user is not `authenticated` (db test 342).
-- Every statement is safe to run twice. No statement starts with drop; no row removal.

-- ----------------------------------------------------------------------------
-- (292) ב / (296) ג: a view counts; the timeline gets one entry a business day; the first opening tells the rep, else the
-- owners and admins
-- ----------------------------------------------------------------------------
create or replace function app.library_link_mark_viewed(p_link public.library_links) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_today date := app.library_today(p_link.organization_id);
  v_told uuid;
  v_record record;
  v_owner uuid;
  v_team uuid;
  v_title text;
  v_views integer;
  v_maker boolean := false;
begin
  update public.library_links l
     set view_count = l.view_count + 1, first_viewed_at = coalesce(l.first_viewed_at, now()), last_viewed_at = now()
   where l.organization_id = p_link.organization_id and l.id = p_link.id
  returning l.view_count into v_views;
  v_record := app.library_link_record(p_link);
  select i.title into v_title from public.library_items i where i.organization_id = p_link.organization_id and i.id = p_link.library_item_id;
  -- (292) ב: one timeline entry a business day, even when two views arrive together (notified_on = the day last written)
  update app.library_link_secrets s set notified_on = v_today
   where s.link_id = p_link.id and s.notified_on is distinct from v_today
  returning s.link_id into v_told;
  if v_told is not null then
    insert into public.activities (organization_id, type, lead_id, contact_id, company_id, deal_id, body, metadata, created_by)
    values (p_link.organization_id, 'system', p_link.lead_id, p_link.contact_id, p_link.company_id, p_link.deal_id,
            'הלקוח פתח את הקישור מהספרייה: ' || coalesce(v_title, 'פריט'),
            jsonb_build_object('kind', 'library_viewed', 'library_link_id', p_link.id), null);
  end if;
  -- (292) ב: the rep is told only on the first opening (the row lock above orders two first views: only one sees 1)
  if v_views is distinct from 1 then
    return;
  end if;
  if p_link.created_by is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_link.organization_id and m.user_id = p_link.created_by and m.status = 'active') then
    if v_record.record_type = 'lead' then
      select r.owner_id, r.team_id into v_owner, v_team from public.leads r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
    elsif v_record.record_type = 'contact' then
      select r.owner_id, r.team_id into v_owner, v_team from public.contacts r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
    elsif v_record.record_type = 'company' then
      select r.owner_id, r.team_id into v_owner, v_team from public.companies r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
    else
      select r.owner_id, r.team_id into v_owner, v_team from public.deals r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
    end if;
    -- the rep still reads the record (the notice opens it)
    v_maker := coalesce(app.user_can_read_record(p_link.organization_id, p_link.created_by, v_owner, v_team), false)
            or app.user_deputy_reads(p_link.organization_id, p_link.created_by, v_record.record_type, v_record.record_id);
  end if;
  if v_maker then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (p_link.organization_id, p_link.created_by, 'library_viewed', 'הלקוח פתח את הקישור ששלחת מהספרייה',
            -- no personal data: a later privacy erasure does not reach notification bodies
            v_title, v_record.record_type, v_record.record_id);
  else
    -- (296) ג: the maker left or no longer reads the record: the active owners and admins are told instead
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    select p_link.organization_id, m.user_id, 'library_viewed', 'הלקוח פתח קישור שנשלח מהספרייה',
           v_title, v_record.record_type, v_record.record_id
      from public.memberships m
     where m.organization_id = p_link.organization_id and m.status = 'active' and m.role in ('owner', 'admin');
  end if;
end;
$$;
revoke all on function app.library_link_mark_viewed(public.library_links) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (292) ב: a person never writes, changes or deletes a library opening entry (owners and admins too)
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user tells a person's write from the server's (the page, purge, merge, erasure pass).
create or replace function app.activities_library_entry_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and coalesce(old.metadata ->> 'kind', '') = 'library_viewed' then
    raise exception 'an opened library link on the timeline is history' using errcode = '42501', hint = 'activity:library_entry';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and coalesce(new.metadata ->> 'kind', '') = 'library_viewed' then
    raise exception 'only the server writes an opened library link entry' using errcode = '42501', hint = 'activity:library_entry';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_library_entry_guard() from public, anon, authenticated, service_role;

create or replace trigger activities_library_entry_guard before insert or update or delete on public.activities
  for each row execute function app.activities_library_entry_guard();

-- the entry has no author (the customer opened the link; nobody in the business wrote it)
create or replace function app.activities_library_entry_author() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := null;
  return new;
end;
$$;
revoke all on function app.activities_library_entry_author() from public, anon, authenticated, service_role;

create or replace trigger activities_zz_library_entry_author before insert on public.activities
  for each row when (new.type = 'system' and coalesce(new.metadata ->> 'kind', '') = 'library_viewed')
  execute function app.activities_library_entry_author();

-- ----------------------------------------------------------------------------
-- (292) ב: not activity. Each body below is its latest one with one changed line (the system kinds it skips)
-- ----------------------------------------------------------------------------
-- "No activity" skips a library opening entry (body of 20261006021091)
CREATE OR REPLACE FUNCTION app.scheduled_no_activity(p_auto automations)
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
         select t.id, coalesce((select max(a.occurred_at) from public.activities a where a.%I = t.id and a.type not in (''automation_note'', ''import_note'', ''share_note'')
                             and not (a.type = ''system'' and coalesce(a.metadata ->> ''kind'', '''') in (''record_link_removed'', ''library_viewed''))), t.created_at) as last_at
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


-- AUT-06 run facts: the same rule (body of 20261006021139)
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
                           where a.organization_id = $1 and a.%I = $2 and a.type not in (''automation_note'', ''import_note'', ''share_note'')
                             and not (a.type = ''system'' and coalesce(a.metadata ->> ''kind'', '''') in (''record_link_removed'', ''library_viewed''))),
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
    when 'customer_dormant' then
      -- RET-01: the last purchase the dormancy counts from, from the run key dormant:<record>:<YYYY-MM-DD>, and the day the
      -- customer became dormant by the thresholds at the time of the run
      v_text := substring(p_run_key from '^dormant:[0-9a-f-]{36}:([0-9]{4}-[0-9]{2}-[0-9]{2})$');
      return case when v_text is not null then jsonb_build_object(
        'last_purchase_on', v_text::date,
        'dormant_on', (v_text::date + make_interval(months => (select m.dormant_months from app.customer_status_months(p_org) m)))::date) end;
    else
      -- a trigger type without a decision: never retried
      return null;
  end case;
exception when others then
  return null;
end;
$function$

;
revoke all on function app.automation_run_facts(text, jsonb, text, uuid, uuid, text) from public, anon, authenticated, service_role;

-- AUT-06 retry: the same rule (body of 20261006021139)
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
                           where a.organization_id = $1 and a.%I = $2 and a.type not in (''automation_note'', ''import_note'', ''share_note'')
                             and not (a.type = ''system'' and coalesce(a.metadata ->> ''kind'', '''') in (''record_link_removed'', ''library_viewed''))),
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
    when 'customer_dormant' then
      -- RET-01: no purchase since the run (the same last purchase) and the record is still a contact or company
      return p_entity in ('contact', 'company')
         and coalesce(app.customer_last_purchase_all(p_org, case when p_entity = 'contact' then p_id end,
                                                    case when p_entity = 'company' then p_id end)
                      = (p_facts ->> 'last_purchase_on')::date, false);
    else
      -- a trigger type without a decision is never retried
      return false;
  end case;
end;
$function$

;
revoke all on function app.automation_event_still_holds(text, jsonb, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (294) ב: turning a link off only lessens access: its maker, an owner or admin, or whoever may edit the record, for a
-- record they read (body of 20261006021229 plus the record's owner and team and the app.can_edit_record condition)
-- ----------------------------------------------------------------------------
create or replace function public.library_link_revoke(p_org uuid, p_link uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link public.library_links;
  v_record record;
  v_table text;
  v_owner uuid;
  v_team uuid;
begin
  select * into v_link from public.library_links l where l.organization_id = p_org and l.id = p_link;
  if v_link.id is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_record := app.library_link_record(v_link);
  -- (294) ב: the record's owner and team, for app.can_edit_record (writable business, owner/admin, its owner, its team's manager)
  if v_record.record_type = 'lead' then
    select r.owner_id, r.team_id into v_owner, v_team from public.leads r where r.organization_id = p_org and r.id = v_record.record_id;
  elsif v_record.record_type = 'contact' then
    select r.owner_id, r.team_id into v_owner, v_team from public.contacts r where r.organization_id = p_org and r.id = v_record.record_id;
  elsif v_record.record_type = 'company' then
    select r.owner_id, r.team_id into v_owner, v_team from public.companies r where r.organization_id = p_org and r.id = v_record.record_id;
  else
    select r.owner_id, r.team_id into v_owner, v_team from public.deals r where r.organization_id = p_org and r.id = v_record.record_id;
  end if;
  if app.role_in(p_org) is null or app.role_in(p_org)::text = 'viewer'
     or not app.library_link_caller_reads(p_org, v_record.record_type, v_record.record_id)
     or not (v_link.created_by = auth.uid() or app.is_admin(p_org)
             or coalesce(app.can_edit_record(p_org, v_owner, v_team), false)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_link.revoked_at is not null then
    return false;
  end if;
  update public.library_links l set revoked_at = now(), revoked_by = auth.uid()
   where l.organization_id = p_org and l.id = p_link and l.revoked_at is null;
  update app.library_link_secrets s set token_hash = null, window_started_at = null, window_count = 0
   where s.link_id = p_link;
  v_table := case v_record.record_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies' else 'deals' end;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'library_link', v_table, v_record.record_id,
          jsonb_build_object('link', 'revoked', 'item', v_link.library_item_id));
  return true;
end;
$$;
revoke all on function public.library_link_revoke(uuid, uuid) from public, anon;
grant execute on function public.library_link_revoke(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- (293) ב: the page before a link item's site. The same lookup, rule and counters as the page (a call of the link, not a
-- view); answers only the stored https link and the business's display name; a file item has no such page
-- ----------------------------------------------------------------------------
create or replace function public.library_link_public_link(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_take record;
  v_link public.library_links;
  v_item public.library_items;
  v_business text;
  v_org uuid;
begin
  -- BIZ-03's emergency switch (021088 / 021092): while the platform blocks the business's outside links, "not found",
  -- judged before the counters, so nothing is counted (as public.qr_scan); a token of another shape falls to the lookup
  if coalesce(p_token, '') ~ '^[A-Za-z0-9_-]{64}$' then
    select s.organization_id into v_org from app.library_link_secrets s
     where s.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
    if v_org is not null and app.qr_external_off(v_org) then
      raise exception 'link not found' using errcode = 'P0002';
    end if;
  end if;
  v_take := app.library_link_take(p_token, p_ip_hash);
  if v_take.verdict = 'rate' then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_link := v_take.link;
  select * into v_item from public.library_items i where i.organization_id = v_link.organization_id and i.id = v_link.library_item_id;
  if v_item.kind is distinct from 'link' or v_item.url is null or not app.qr_target_url_ok(v_item.url) then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  select o.name into v_business from public.organizations o where o.id = v_link.organization_id;
  return jsonb_build_object('url', v_item.url, 'business', v_business);
end;
$$;
revoke all on function public.library_link_public_link(text, text) from public, anon, authenticated;
grant execute on function public.library_link_public_link(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- BIZ-03's emergency switch (app.qr_external_blocks, 021088 / 021092) covers library link items too: the customer's page
-- (body of 20261006021229 plus the lines marked "added", and the 'url' line marked "changed") answers no link and
-- external_blocked = true for a link item while the business is blocked; the view is counted as before (the page was
-- opened), and the page shows no button
-- ----------------------------------------------------------------------------
create or replace function public.library_link_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_take record;
  v_link public.library_links;
  v_item public.library_items;
  v_org public.organizations;
  v_file public.files;
  v_built_with boolean;
  -- added (BIZ-03's emergency switch): a link item's site is not offered while the platform blocks outside links
  v_external_off boolean;
begin
  v_take := app.library_link_take(p_token, p_ip_hash);
  if v_take.verdict = 'rate' then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_link := v_take.link;
  perform app.library_link_mark_viewed(v_link);

  select * into v_item from public.library_items i where i.organization_id = v_link.organization_id and i.id = v_link.library_item_id;
  select * into v_org from public.organizations o where o.id = v_link.organization_id;
  begin
    v_built_with := coalesce(app.show_built_with(v_link.organization_id), true);
  exception when others then
    v_built_with := true;
  end;
  if v_item.kind = 'file' then
    v_file := app.library_item_file(v_link.organization_id, v_item.id);
  end if;
  -- added: the switch of app.qr_external_blocks (021088), read for a link item only
  v_external_off := v_item.kind = 'link' and app.qr_external_off(v_link.organization_id);
  return jsonb_build_object(
    'business', v_org.name,
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'built_with', v_built_with,
    'item', jsonb_build_object(
      'kind', v_item.kind,
      'title', v_item.title,
      'description', v_item.description,
      -- changed: no link while the switch is on, and the page says so
      'url', case when v_item.kind = 'link' and not v_external_off then v_item.url end,
      'external_blocked', v_external_off,
      'file', case when v_item.kind = 'file' then jsonb_build_object('name', v_file.name, 'mime_type', v_file.mime_type, 'size_bytes', v_file.size_bytes) end));
end;
$$;
revoke all on function public.library_link_public(text, text) from public, anon, authenticated;
grant execute on function public.library_link_public(text, text) to service_role;

