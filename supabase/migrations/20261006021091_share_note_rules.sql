-- =============================================================================
-- WAB-06 (owner's answer of 27 October 2026, (ב)), part two: the shared rules that read the new type 'share_note'
-- =============================================================================
-- The type, its insert/update/delete policies and its mark trigger are in 20261006021090_share_note_type.sql (kept apart
-- so that tests which re-run these function bodies never re-run the policies; see the header there for every decision).
-- Each function below is its latest body, one type wider, and nothing else:
-- * not activity: app.scheduled_no_activity, app.automation_run_facts, app.automation_event_still_holds,
--   app.deal_attention_rows, public.report_pipeline_cleanup (bodies of 20261006021050);
-- * a person's note: app.search_notes (20261006021070), app.files_links_check (20261006020645), app.notify_mentions
--   (20261006009900) and app.notify_followers_of_entry (20261006019900, follower text "הוסיף/ה הערת שיתוף").
-- Every statement is safe to run twice. Nothing is removed.

-- "No activity" skips a share note (body of 20261006021050, one type wider)
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

-- AUT-06 run facts: the same rule (body of 20261006021050, one type wider)
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

-- AUT-06 retry: the same rule (body of 20261006021050, one type wider)
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

-- A deal's last activity leaves out share notes (body of 20261006021050)
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
           where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null and a.type not in ('import_note', 'share_note')
             and not (a.type = 'system' and a.metadata ->> 'kind' = 'snooze_cleared')
        ) la on true
       where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
         and (p_pipeline is null or d.pipeline_id = p_pipeline)
         and (p_owner is null or d.owner_id = p_owner)
         and (p_ids is null or d.id = any (p_ids))
    ) x
$function$

;

-- The cleanup report's copy of that rule, kept in step (body of 20261006021050)
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
         where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null and a.type not in ('import_note', 'share_note')
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

-- Global search finds share notes (body of 20261006021070, one type wider)
CREATE OR REPLACE FUNCTION app.search_notes(p_org uuid, p_q text, p_like text, p_limit integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select a.id, a.type, left(a.body, 160) as body, a.occurred_at, a.lead_id, a.contact_id, a.company_id, a.deal_id
      from public.activities a
     where a.organization_id = p_org and a.body is not null
       and a.type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms', 'import_note', 'share_note')
       and (app.search_norm(a.body) like p_like or p_q operator(extensions.<%) app.search_norm(a.body))
     order by a.occurred_at desc
     limit p_limit) x;
$function$

;

-- REC-07: the author attaches files to a share note (body of 20261006020645, one type wider)
CREATE OR REPLACE FUNCTION app.files_links_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_note public.activities;
  v_prev public.files;
  v_latest uuid;
  v_person boolean := current_user in ('authenticated', 'anon');
begin
  -- a person who may not write here gets RLS's plain refusal right after
  if v_person and not app.can_write(new.organization_id) then
    return new;
  end if;
  -- The latest row is taken even while it still waits for confirm_file_upload (review of 020640, low 1): it already holds
  -- the one newer slot of the confirmed file before it (files_one_newer), so linking past it would collide and refuse every
  -- later file. The card follows the line through a waiting row and shows confirmed files only; a waiting row that is later
  -- confirmed becomes a real version in its place, and one its uploader removes is linked around by files_relink_versions.
  if new.accounting_document_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_document:' || new.organization_id::text || ':' || new.accounting_document_id::text, 0));
    -- the latest file: the one no other file of the document replaces (the history is one line)
    select f.id into v_latest
      from public.files f
     where f.organization_id = new.organization_id and f.accounting_document_id = new.accounting_document_id
       and not exists (select 1 from public.files n where n.organization_id = f.organization_id and n.previous_id = f.id)
     order by f.created_at desc, f.id desc
     limit 1;
    if new.previous_id is not null and new.previous_id is distinct from v_latest then
      raise exception 'this document already has a newer file' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
    new.previous_id := v_latest;
  end if;
  -- PAY-01 follow-up: a payment's new file follows its latest file the same way
  if new.payment_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_payment:' || new.organization_id::text || ':' || new.payment_id::text, 0));
    select f.id into v_latest
      from public.files f
     where f.organization_id = new.organization_id and f.payment_id = new.payment_id
       and not exists (select 1 from public.files n where n.organization_id = f.organization_id and n.previous_id = f.id)
     order by f.created_at desc, f.id desc
     limit 1;
    if new.previous_id is not null and new.previous_id is distinct from v_latest then
      raise exception 'this payment already has a newer file' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
    new.previous_id := v_latest;
  end if;
  if new.activity_id is not null then
    select * into v_note from public.activities a where a.organization_id = new.organization_id and a.id = new.activity_id;
    if not found
       or v_note.lead_id is distinct from new.lead_id or v_note.contact_id is distinct from new.contact_id
       or v_note.company_id is distinct from new.company_id or v_note.deal_id is distinct from new.deal_id
       or (v_person and (v_note.type not in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms', 'share_note')
                         or v_note.created_by is distinct from auth.uid())) then
      raise exception 'a file is attached only to an entry of the same record, by its author'
        using errcode = 'P0001', hint = 'file:note';
    end if;
  end if;
  if new.previous_id is not null then
    select * into v_prev from public.files f where f.organization_id = new.organization_id and f.id = new.previous_id;
    if not found
       or v_prev.lead_id is distinct from new.lead_id or v_prev.contact_id is distinct from new.contact_id
       or v_prev.company_id is distinct from new.company_id or v_prev.deal_id is distinct from new.deal_id
       or v_prev.activity_id is distinct from new.activity_id
       or v_prev.accounting_document_id is distinct from new.accounting_document_id
       or v_prev.payment_id is distinct from new.payment_id then
      raise exception 'a new version belongs to the same record and note as the earlier one'
        using errcode = 'P0001', hint = 'file:version';
    end if;
    if exists (select 1 from public.files f where f.previous_id = new.previous_id) then
      raise exception 'this file already has a newer version' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
  end if;
  return new;
end;
$function$

;

-- REC-02: a mention in a share note notifies (body of 20261006009900, one type wider)
CREATE OR REPLACE FUNCTION app.notify_mentions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
  v_added uuid[];
  v_actor uuid;
  v_user uuid;
  v_subject record;
  v_author_name text;
  v_title text;
begin
  -- what a person logged (the triggers fire for browser writes only)
  if new.created_by is null or not (new.type = any (app.contact_types()) or new.type = 'share_note') then
    return null;
  end if;
  v_ids := app.mention_ids(new.body);
  if cardinality(v_ids) = 0 then
    return null;
  end if;
  v_actor := coalesce(auth.uid(), new.created_by);

  v_added := v_ids;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(u), '{}'::uuid[]) into v_added
      from unnest(v_ids) as u
     where not (u = any (app.mention_ids(old.body)));
  end if;

  if cardinality(v_added) > 0 then
    if cardinality(v_ids) > 20 then
      raise exception 'too many mentions' using errcode = 'P0001', hint = 'mention:too_many';
    end if;
    foreach v_user in array v_added loop
      if v_user is distinct from v_actor then
        select * into v_subject
          from app.mention_subject(new.organization_id, v_user, new.lead_id, new.contact_id, new.company_id, new.deal_id);
        if v_subject.entity_id is null then
          raise exception 'this person cannot see the record' using errcode = 'P0001', hint = 'mention:forbidden';
        end if;
      end if;
    end loop;
  end if;

  -- GAP-05: nobody is told about a private note
  if new.is_private then
    return null;
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'משתמש') into v_author_name
    from public.profiles p where p.id = new.created_by;

  foreach v_user in array v_ids loop
    continue when v_user is not distinct from v_actor or v_user is not distinct from new.created_by;
    continue when exists (select 1 from app.activity_mentions am where am.activity_id = new.id and am.user_id = v_user);
    -- told only while they may still read the record (a mention older than this edit is not re-checked above)
    select * into v_subject
      from app.mention_subject(new.organization_id, v_user, new.lead_id, new.contact_id, new.company_id, new.deal_id);
    continue when v_subject.entity_id is null;

    insert into app.activity_mentions (organization_id, activity_id, user_id)
    values (new.organization_id, new.id, v_user)
    on conflict do nothing;
    v_title := case v_subject.entity_type
                 when 'lead' then 'הזכירו אתכם בליד: '
                 when 'contact' then 'הזכירו אתכם באיש קשר: '
                 when 'company' then 'הזכירו אתכם בחברה: '
                 else 'הזכירו אתכם בעסקה: ' end || v_subject.name;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (new.organization_id, v_user, 'mention', left(v_title, 200),
            left(coalesce(v_author_name, 'משתמש') || ' הזכיר/ה אתכם', 200),
            v_subject.entity_type, v_subject.entity_id);
  end loop;
  return null;
end;
$function$

;

-- REC-03: followers are told about a share note (body of 20261006019900, one type wider)
CREATE OR REPLACE FUNCTION app.notify_followers_of_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  v_author_name text;
  v_body text;
  v_mentioned uuid[];
  v_last uuid;
  v_record record;
  v_row record;
begin
  -- what a person logged, in the open (GAP-05: a private note tells nobody)
  if new.created_by is null or new.is_private or not (new.type = any (app.contact_types()) or new.type = 'share_note') then
    return null;
  end if;
  v_actor := coalesce(auth.uid(), new.created_by);
  v_mentioned := app.mention_ids(new.body);
  v_author_name := coalesce(app.follow_person_name(new.created_by), 'משתמש');
  v_body := v_author_name || case new.type
              when 'note' then ' הוסיף/ה הערה'
              when 'share_note' then ' הוסיף/ה הערת שיתוף'
              when 'call' then ' תיעד/ה שיחה'
              when 'meeting' then ' תיעד/ה פגישה'
              when 'email' then ' תיעד/ה אימייל'
              when 'whatsapp' then ' תיעד/ה הודעת WhatsApp'
              else ' תיעד/ה SMS' end;

  -- each follower once, on the first record of the entry they follow and may read; the owner of
  -- each record of the entry is a built-in follower of it (REC-03, owner 14 October 2026)
  for v_row in
    select x.user_id, x.kind, x.record_id, x.rank
      from (
        select f.user_id,
               case when f.lead_id is not null then 'lead' when f.contact_id is not null then 'contact'
                    when f.company_id is not null then 'company' else 'deal' end as kind,
               coalesce(f.lead_id, f.contact_id, f.company_id, f.deal_id) as record_id,
               case when f.lead_id is not null then 1 when f.contact_id is not null then 2
                    when f.company_id is not null then 3 else 4 end as rank
          from public.record_followers f
         where f.organization_id = new.organization_id
           and (f.lead_id = new.lead_id or f.contact_id = new.contact_id
                or f.company_id = new.company_id or f.deal_id = new.deal_id)
        union all
        select l.owner_id, 'lead', l.id, 1 from public.leads l
         where new.lead_id is not null and l.organization_id = new.organization_id and l.id = new.lead_id and l.owner_id is not null
        union all
        select c.owner_id, 'contact', c.id, 2 from public.contacts c
         where new.contact_id is not null and c.organization_id = new.organization_id and c.id = new.contact_id and c.owner_id is not null
        union all
        select co.owner_id, 'company', co.id, 3 from public.companies co
         where new.company_id is not null and co.organization_id = new.organization_id and co.id = new.company_id and co.owner_id is not null
        union all
        select d.owner_id, 'deal', d.id, 4 from public.deals d
         where new.deal_id is not null and d.organization_id = new.organization_id and d.id = new.deal_id and d.owner_id is not null
      ) x
     order by x.user_id, x.rank
  loop
    continue when v_row.user_id is not distinct from v_last;
    continue when v_row.user_id is not distinct from v_actor or v_row.user_id is not distinct from new.created_by;
    -- a mentioned follower is told by the mention
    continue when v_row.user_id = any (v_mentioned);
    select * into v_record from app.follow_record(new.organization_id, v_row.kind, v_row.record_id);
    continue when v_record.in_trash is distinct from false;
    continue when not app.user_can_read_record(new.organization_id, v_row.user_id, v_record.owner_id, v_record.team_id);
    v_last := v_row.user_id;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (new.organization_id, v_row.user_id, 'follow', app.follow_title(v_row.kind, v_record.name),
            left(v_body, 200), v_row.kind, v_row.record_id);
  end loop;
  return null;
end;
$function$

;

