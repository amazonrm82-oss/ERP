-- =============================================================================
-- AUT-03 (rest): "any field changed", "form submitted", a fixed schedule and the card's manual button
-- =============================================================================
-- * "Any field changed" (field_changed, the type that already serves "status changed" and "stage changed"): a rule on a
--   lead, contact, company or deal may watch any built-in column or a custom field ('cf:<key>'), optionally "to" a value
--   (compared as text: an id, a list code, 'true' / 'false', a select option). app.emit_event (body of 019500) now also
--   lists each changed custom field of an update as 'cf:<key>' in payload.changed (only when custom_fields changed), and
--   app.automation_field_value(record, field) reads a column or a custom field. One outbox event per update as before; the
--   origin rules are unchanged: an automation's own change (origin automation) and an import's insert (origin import)
--   start nothing. app.automation_event_matches, app.automation_run_facts and app.automation_event_still_holds read the
--   custom field's value through the same helper.
-- * "Form submitted" (form_submitted; lead and contact rules; trigger_config.form_id optional): public.intake_submit (body
--   of 020975, every required line kept: v_rotation_closed, app.org_takes_leads, v_leads_on, app.intake_form_id) writes one
--   outbox event per record the inquiry touched, through app.emit_form_submitted: the new lead; or the new contact (leads
--   off, LEAD-08); or, for a repeat inquiry, the matched lead and the contact the inquiry entry is on. Payload {form_id,
--   submission: new | repeat}. Spam writes none. Every form kind that goes through intake_submit counts (web form, business
--   card, site widget, webhook). Retry (AUT-06): facts {form_id} from the event; it still holds.
-- * "Fixed schedule" (schedule; every record type): trigger_config {frequency: daily | weekly, time: 'HH:MM', days:
--   [0..6] (0 = Sunday; weekly only, at least one)}, in the business's time zone. pg_cron crm-schedule-automations (every
--   15 minutes) runs app.run_schedule_automations(): the latest scheduled time that has come (app.schedule_slot, as an
--   instant compared with now, so it never steps back when a clock is set back) is worked on for 24 hours, then dropped.
--   Each time runs the rule once per record that meets its conditions (run key sched:<record>:<YYYY-MM-DDTHH:MI>), over
--   live records only (app.schedule_record_open: not in the bin; a lead not converted; a deal or task only while open).
--   A record whose run raises is logged as skipped for that time ("the run stopped with an error") and the rule goes on.
--   At most 200 runs per business a pass, shared fairly among its rules (least recently worked first, an unused share
--   passed on); businesses go least recently worked first; 2,000 runs and 20,000 records examined a pass across all
--   businesses (so the AUT-07 month-row locks are held for a bounded pass); businesses take turns by
--   app.schedule_business_turns (server only, RLS, no grants, cascades with the business); a rule that raises or has
--   nothing due goes last next pass (app.schedule_cursor_touch); records already run count as examined; the
--   next pass goes on from each rule's scan cursor, whose after_at holds the scheduled time it belongs to (a finished
--   time is marked with the id ffffffff-...); at most app.scheduled_scan_limit() records per rule a pass. AUT-07 counts
--   the runs. Retry: facts {slot}; it holds while the record is still open as above.
-- * "Manual button" (manual; leads, contacts, companies and deals): never starts by itself. public.manual_automations(org,
--   type, record) lists the active manual rules of that type to a person who may edit the record (app.can_edit_record:
--   writable business, not a viewer, the record's owner, its team's manager, an owner/admin); public.run_manual_automation
--   (org, rule, record) runs one with the conditions checked, key 'button:<uuid>': AUT-07 counts and stops it (lead's
--   decision: any editor may press it, unlike an admin's 'manual:' test run), AUT-06 never retries it, and the engine's 20
--   runs of a rule on a record a day still hold. Both are security definer, granted to authenticated only (members cannot
--   read automations), and answer the same "not found" for anything the caller may not run.
-- * "Form submitted" never fires lead rules on a converted lead (app.emit_form_submitted leaves it out; its contact still
--   gets the event).
-- * Not here: the inbound webhook trigger (needs a new service-role use, wave 3).
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.automations drop constraint if exists automations_trigger_type_check;
alter table public.automations add constraint automations_trigger_type_check check (trigger_type = any (array[
  'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'no_activity', 'stuck_in_stage', 'birthday',
  'task_due_soon', 'date_reached', 'payment_received', 'payment_confirmed', 'quote_viewed', 'quote_accepted',
  'quote_declined', 'quote_expired', 'document_recorded', 'meeting_scheduled', 'meeting_cancelled', 'meeting_no_show',
  'debt_overdue', 'form_submitted', 'schedule', 'manual']));

-- a rule's field on a record: a column, or a custom field 'cf:<key>' (its stored JSON value)
create or replace function app.automation_field_value(p_record jsonb, p_field text) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case when p_field like 'cf:%' then p_record -> 'custom_fields' -> substr(p_field, 4) else p_record -> p_field end
$$;
revoke all on function app.automation_field_value(jsonb, text) from public, anon, authenticated, service_role;

-- a record a fixed schedule runs on (the recycle bin is checked by the callers): a lead not converted, an open deal or task
create or replace function app.schedule_record_open(p_entity text, p_record jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case p_entity
    when 'lead' then (p_record ->> 'converted_at') is null
    when 'deal' then coalesce(p_record ->> 'status' = 'open', false)
    when 'task' then coalesce(p_record ->> 'status' = 'open', false)
    else true
  end
$$;
revoke all on function app.schedule_record_open(text, jsonb) from public, anon, authenticated, service_role;

create or replace function app.emit_event() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_old jsonb;
  v_new jsonb;
  v_changed text[] := '{}';
  v_key text;
  v_old_cf jsonb;
  v_new_cf jsonb;
  v_event text;
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164', 'reminded_at', 'score'];
  -- set by app.process_outbox() while it runs automation actions
  v_origin jsonb := case when current_setting('app.automation_running', true) = 'on'
                         then jsonb_build_object('origin', 'automation') else '{}'::jsonb end;
begin
  if tg_op = 'DELETE' then
    if not app.org_exists(old.organization_id) then
      return null;
    end if;
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (old.organization_id, v_entity || '.purged', v_entity, old.id, auth.uid(), v_origin);
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- to_jsonb: tasks and deals have no import_job_id column
    if v_origin = '{}'::jsonb and to_jsonb(new) ->> 'import_job_id' is not null then
      v_origin := jsonb_build_object('origin', 'import');
    end if;
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (new.organization_id, v_entity || '.created', v_entity, new.id, auth.uid(), v_origin);
    return null;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  for v_key in select jsonb_object_keys(v_new) loop
    if v_key <> all (v_ignored) and (v_new -> v_key) is distinct from (v_old -> v_key) then
      v_changed := v_changed || v_key;
    end if;
  end loop;
  if cardinality(v_changed) = 0 then
    return null;
  end if;
  -- AUT-03: which custom fields changed, as 'cf:<key>' (a "field changed" rule may watch one)
  if 'custom_fields' = any (v_changed) then
    v_old_cf := case when jsonb_typeof(v_old -> 'custom_fields') = 'object' then v_old -> 'custom_fields' else '{}'::jsonb end;
    v_new_cf := case when jsonb_typeof(v_new -> 'custom_fields') = 'object' then v_new -> 'custom_fields' else '{}'::jsonb end;
    for v_key in
      select k from (select jsonb_object_keys(v_new_cf) as k union select jsonb_object_keys(v_old_cf)) keys
       where (v_new_cf -> k) is distinct from (v_old_cf -> k)
       order by k
    loop
      v_changed := v_changed || ('cf:' || v_key);
    end loop;
  end if;

  v_event := case
    when 'deleted_at' = any (v_changed) and new.deleted_at is not null then v_entity || '.deleted'
    when 'deleted_at' = any (v_changed) then v_entity || '.restored'
    else v_entity || '.updated'
  end;

  insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
  values (new.organization_id, v_event, v_entity, new.id, auth.uid(),
          jsonb_build_object('changed', to_jsonb(v_changed)) || v_origin);
  return null;
end;
$$;

create or replace function app.automation_event_matches(p_auto public.automations, p_event public.outbox_events, p_record jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_auto.entity_type = p_event.entity_type and case p_auto.trigger_type
    when 'created' then p_event.event_type = p_auto.entity_type || '.created'
    when 'field_changed' then p_event.event_type = p_auto.entity_type || '.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? (p_auto.trigger_config ->> 'field')
      -- AUT-03: any built-in column or a custom field ('cf:<key>'); the value compared as text
      and ((p_auto.trigger_config ->> 'to') is null
           or app.automation_field_value(p_record, p_auto.trigger_config ->> 'field') #>> '{}' = p_auto.trigger_config ->> 'to')
    when 'task_completed' then p_event.event_type = 'task.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'done'
    when 'deal_won' then p_event.event_type = 'deal.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'won'
    when 'deal_lost' then p_event.event_type = 'deal.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'lost'
    -- PAY-07: at least min_agorot when the rule sets it (a value that is not a JSON number is ignored)
    when 'payment_received' then p_event.event_type = 'payment_received'
      and (jsonb_typeof(p_auto.trigger_config -> 'min_agorot') is distinct from 'number'
           or jsonb_typeof(p_event.payload -> 'amount_agorot') = 'number'
              and (p_event.payload ->> 'amount_agorot')::numeric >= (p_auto.trigger_config ->> 'min_agorot')::numeric)
    -- PAY-07 (owner, 21 October 2026, answer 3): the payment was confirmed; the same minimum
    when 'payment_confirmed' then p_event.event_type = 'payment_confirmed'
      and (jsonb_typeof(p_auto.trigger_config -> 'min_agorot') is distinct from 'number'
           or jsonb_typeof(p_event.payload -> 'amount_agorot') = 'number'
              and (p_event.payload ->> 'amount_agorot')::numeric >= (p_auto.trigger_config ->> 'min_agorot')::numeric)
    -- AUT-04: the commercial events, one outbox event per linked record (the record type is matched above)
    when 'quote_viewed' then p_event.event_type = 'quote_viewed'
    -- the owner, 25 October 2026 (4 ב): at least min_agorot of the quote's amount before VAT (net_total_agorot, after the
    -- document discount), when the rule sets it; the payment triggers' rule (a value that is not a JSON number is ignored)
    when 'quote_accepted' then p_event.event_type = 'quote_accepted'
      and (jsonb_typeof(p_auto.trigger_config -> 'min_agorot') is distinct from 'number'
           or jsonb_typeof(p_event.payload -> 'net_total_agorot') = 'number'
              and (p_event.payload ->> 'net_total_agorot')::numeric >= (p_auto.trigger_config ->> 'min_agorot')::numeric)
    when 'quote_declined' then p_event.event_type = 'quote_declined'
    when 'quote_expired' then p_event.event_type = 'quote_expired'
    when 'document_recorded' then p_event.event_type = 'document_recorded'
    when 'meeting_scheduled' then p_event.event_type = 'meeting_scheduled'
    when 'meeting_cancelled' then p_event.event_type = 'meeting_cancelled'
    when 'meeting_no_show' then p_event.event_type = 'meeting_no_show'
    -- AUT-03: a public form created or matched the record; only the chosen form when the rule names one
    when 'form_submitted' then p_event.event_type = 'form_submitted'
      and ((p_auto.trigger_config ->> 'form_id') is null or p_event.payload ->> 'form_id' = p_auto.trigger_config ->> 'form_id')
    -- AUT-03: a fixed schedule (app.run_schedule_automations) and the card's button (public.run_manual_automation) never
    -- start from an event
    when 'schedule' then false
    when 'manual' then false
    else false
  end
$$;

revoke all on function app.automation_event_matches(public.automations, public.outbox_events, jsonb) from public, anon, authenticated;

create or replace function app.process_outbox(p_limit integer default 500) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_event public.outbox_events%rowtype;
  v_auto public.automations%rowtype;
  v_record jsonb;
  v_count integer := 0;
begin
  for v_event in
    select * from public.outbox_events e
     where e.processed_at is null
       -- tried earlier in this run (same transaction): wait for the next run
       and (e.last_attempt_at is null or e.last_attempt_at < now())
     order by e.id limit p_limit for update skip locked
  loop
    begin
      if coalesce(v_event.payload ->> 'origin', '') not in ('automation', 'import') and app.org_writable(v_event.organization_id) then
        for v_auto in
          select * from public.automations a
           where a.organization_id = v_event.organization_id and a.is_active and a.entity_type = v_event.entity_type
             and a.trigger_type in ('created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'payment_received',
                                   'payment_confirmed', 'quote_viewed', 'quote_accepted', 'quote_declined', 'quote_expired',
                                   'document_recorded', 'meeting_scheduled', 'meeting_cancelled', 'meeting_no_show',
                                   'form_submitted')
             -- AUT-04: a rule whose trigger belongs to a module runs only while the plan has it
             and (app.automation_trigger_feature(a.trigger_type) is null
                  or app.org_has_feature(a.organization_id, app.automation_trigger_feature(a.trigger_type)))
        loop
          v_record := app.automation_record(v_event.entity_type, v_event.organization_id, v_event.entity_id);
          if v_record is not null and app.automation_event_matches(v_auto, v_event, v_record) then
            perform app.execute_automation(v_auto, v_event.entity_id, 'event:' || v_event.id);
          end if;
        end loop;
      end if;
      update public.outbox_events set processed_at = now(), attempts = attempts + 1, last_attempt_at = now() where id = v_event.id;
    exception when others then
      update public.outbox_events
         set attempts = attempts + 1, last_error = left(sqlerrm, 500), last_attempt_at = now(),
             processed_at = case when attempts + 1 >= 5 then now() end
       where id = v_event.id;
    end;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function app.process_outbox(integer) from public, anon, authenticated;
grant execute on function app.process_outbox(integer) to service_role;

create or replace function app.automation_run_facts(p_trigger text, p_config jsonb, p_entity text, p_org uuid, p_id uuid,
                                                    p_run_key text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
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
                           where a.organization_id = $1 and a.%I = $2 and a.type <> ''automation_note''
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
$$;

revoke all on function app.automation_run_facts(text, jsonb, text, uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function app.automation_event_still_holds(p_trigger text, p_config jsonb, p_entity text, p_org uuid,
                                                            p_id uuid, p_record jsonb, p_facts jsonb) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
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
                           where a.organization_id = $1 and a.%I = $2 and a.type <> ''automation_note''
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
$$;

revoke all on function app.automation_event_still_holds(text, jsonb, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

-- AUT-03: one 'form_submitted' outbox event per record an inquiry touched (null ids are skipped). A converted lead gets
-- none (its contact still does): lead rules never run on a converted lead, as the schedule skips them.
create or replace function app.emit_form_submitted(p_org uuid, p_form uuid, p_submission text, p_lead uuid, p_contact uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead uuid := p_lead;
begin
  if v_lead is not null and exists (select 1 from public.leads l
                                     where l.organization_id = p_org and l.id = v_lead and l.converted_at is not null) then
    v_lead := null;
  end if;
  perform app.emit_commercial_event(p_org, 'form_submitted',
    jsonb_build_object('form_id', p_form, 'submission', p_submission),
    jsonb_build_object('lead', v_lead, 'contact', p_contact));
end;
$$;
revoke all on function app.emit_form_submitted(uuid, uuid, text, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_phone_e164 text;
  -- matched lead (and the contact it became) or matched contact
  v_lead_match uuid;
  v_lead_owner uuid;
  v_lead_contact uuid;
  v_contact_match uuid;
  v_contact_owner uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
  -- CAP-02 / ADS-01: where the visit came from (cleaned, known keys only)
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  -- CAP-01: custom values as sent, and what is kept of them
  v_custom_in jsonb := case when jsonb_typeof(p_payload -> 'custom') = 'object' then p_payload -> 'custom' else '{}'::jsonb end;
  v_custom jsonb := '{}'::jsonb;
  -- values of the shown fields by form key, for the conditions of later fields
  v_values jsonb := '{}'::jsonb;
  v_shown text[] := '{}';
  v_value jsonb;
  v_cond jsonb;
  v_type text;
  v_options jsonb;
  -- SPD-05: when the person asked to be called back ('now' or a slot 'YYYY-MM-DD-HH', its business date and start hour)
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_phrase text;
  v_callback_note text;
  v_task_owner uuid;
  v_task uuid;
  -- CAP-09: the rotation has members, but none is in working hours (or all are on leave)
  v_rotation_closed boolean := false;
  -- CAP-08: the team the new lead belongs to and is distributed in (the form's, or a matching rule's)
  v_team uuid;
  -- HEB-08: the form's owner was away with no usable deputy
  v_absent uuid;
  -- CON-10: how the person likes to be contacted, when the form asks (one of the four, else none)
  v_channel text := case when p_payload ->> 'preferred_channel' in ('phone', 'whatsapp', 'email', 'sms')
                         then p_payload ->> 'preferred_channel' end;
  -- CAP-08: the person's language, when the form asks (one of the contacts' codes, else none)
  v_locale text := case when p_payload ->> 'preferred_locale' in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es')
                        then p_payload ->> 'preferred_locale' end;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
  -- LEAD-08 (owner, 18 October 2026, answer (א)): the business switched leads off; the inquiry becomes a contact
  v_leads_on boolean;
  v_contact uuid;
  v_name text;
  -- LEAD-04 / CAP-08 (020830): the product the person asked about, when the form asks (checked below)
  v_product_raw text := case when jsonb_typeof(p_payload -> 'requested_product_id') = 'string'
                             then nullif(left(btrim(p_payload ->> 'requested_product_id'), 64), '') end;
  v_product uuid;
  v_product_name text;
  -- CAP-07 / CNS-04: the channels whose marketing-consent box the person ticked (as sent; checked below), the ones
  -- that count, their wording, and the inquiry as stored (the ticked boxes' wording and version with it)
  v_consent_in text[] := case jsonb_typeof(p_payload -> 'marketing_consent')
                           when 'array' then array(select left(e.value, 20) from jsonb_array_elements_text(
                                                     case when jsonb_typeof(p_payload -> 'marketing_consent') = 'array'
                                                          then p_payload -> 'marketing_consent' end) with ordinality as e(value, n)
                                                    where e.n <= 10)
                           when 'string' then array[left(p_payload ->> 'marketing_consent', 20)]
                           else '{}'::text[] end;
  v_consent text[] := '{}';
  v_consent_wording jsonb;
  v_payload jsonb;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  -- read-only and suspended businesses keep taking leads (owner, 8 and 13 October 2026)
  if not app.org_takes_leads(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  v_leads_on := app.org_leads_enabled(v_form.organization_id);
  -- CAP-07 follow-up: the form this request came through, for an entry awaiting a double opt-in
  -- (app.intake_marketing_consent reads it; transaction-local)
  perform set_config('app.intake_form_id', v_form.id::text, true);

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam',
            -- CAP-07 / CNS-04: never the sender's own consent record
            case when jsonb_typeof(p_payload) = 'object' then p_payload - 'marketing_consent' else coalesce(p_payload, '{}'::jsonb) end,
            p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  -- CAP-01: the form's fields in order. A hidden field loses its value and is
  -- never required; a shown custom field must hold a valid value.
  if v_form.kind = 'form' then
    for v_field in
      select a.value from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end) a
    loop
      continue when jsonb_typeof(v_field) <> 'object';
      v_key := v_field ->> 'key';
      continue when v_key is null or v_key = any (v_shown);
      v_type := null;
      v_options := null;
      if v_key like 'cf:%' then
        select d.field_type, d.options into v_type, v_options
          from public.field_definitions d
         where d.organization_id = v_form.organization_id and d.object_type = 'lead'
           and d.key = substr(v_key, 4) and d.is_active;
        -- a field that is gone, switched off or picks a team member is not on the form (FLD-06 part B: nor a record link or a file)
        continue when v_type is null or v_type in ('user', 'record_link', 'file');
        v_value := v_custom_in -> substr(v_key, 4);
      elsif v_key = 'full_name' then v_value := to_jsonb(v_full_name);
      elsif v_key = 'phone' then v_value := to_jsonb(v_phone);
      elsif v_key = 'email' then v_value := to_jsonb(v_email);
      elsif v_key = 'company_name' then v_value := to_jsonb(v_company);
      elsif v_key = 'message' then v_value := to_jsonb(v_message);
      else
        continue;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;

      v_cond := v_field -> 'show_if';
      if jsonb_typeof(v_cond) = 'object'
         and not coalesce((v_cond ->> 'field') = any (v_shown)
                          and app.intake_condition_met(v_values -> (v_cond ->> 'field'), v_cond ->> 'value'), false) then
        -- hidden: whatever was sent for it is dropped
        if v_key = 'full_name' then v_full_name := null;
        elsif v_key = 'phone' then v_phone := null;
        elsif v_key = 'email' then v_email := null;
        elsif v_key = 'company_name' then v_company := null;
        elsif v_key = 'message' then v_message := null;
        end if;
        continue;
      end if;

      v_shown := v_shown || v_key;
      if v_type is not null and app.intake_has_value(v_value) then
        if not app.custom_value_ok(v_type, v_options, v_value) then
          raise exception 'invalid custom field: %', substr(v_key, 4) using errcode = '22023';
        end if;
        v_custom := v_custom || jsonb_build_object(substr(v_key, 4), v_value);
      end if;
      if app.intake_has_value(v_value) then
        v_values := v_values || jsonb_build_object(v_key, v_value);
      end if;
      if v_field -> 'required' = 'true'::jsonb and not app.intake_has_value(v_value) then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;

  -- CAP-07 / CNS-04: a ticked box counts only on a web form that shows it now, and only with the address it is for
  -- (an email for email, a phone for SMS and WhatsApp; a field hidden by its condition gave none). An unticked or
  -- unknown box records nothing. The wording is the server's own, never the sender's.
  if v_form.kind = 'form' then
    select coalesce(array_agg(c.channel order by c.ord), '{}'),
           jsonb_object_agg(c.channel, app.marketing_consent_wording(c.channel, o.name))
      into v_consent, v_consent_wording
      from unnest(app.form_marketing_channels(v_form.marketing_consent_channels, v_form.fields)) with ordinality as c(channel, ord)
      cross join public.organizations o
     where o.id = v_form.organization_id
       and c.channel = any (v_consent_in)
       and ((c.channel = 'email' and v_email is not null) or (c.channel <> 'email' and v_phone is not null));
  end if;
  -- the inquiry as stored: never the sender's own "marketing_consent"; the server's record of the ticked boxes instead
  v_payload := case when jsonb_typeof(p_payload) = 'object' then p_payload - 'marketing_consent' else coalesce(p_payload, '{}'::jsonb) end
               || case when cardinality(v_consent) > 0
                       then jsonb_build_object('marketing_consent', jsonb_build_object(
                              'version', app.marketing_consent_version(), 'channels', to_jsonb(v_consent),
                              'wording', v_consent_wording))
                       else '{}'::jsonb end;

  -- CON-10: a channel counts only when the form asks
  if v_form.kind <> 'form' or not v_form.channel_choice then
    v_channel := null;
  end if;
  -- CAP-08: a language counts only when the form asks
  if v_form.kind <> 'form' or not v_form.locale_choice then
    v_locale := null;
  end if;
  -- LEAD-04 / CAP-08 (020830): a requested product counts only when the form asks and the business has the products
  -- flag. It must be one the form offers now (app.intake_form_products, the list intake_form shows); any other id,
  -- whatever it is (another business's, archived, not picked, unknown), gets the same refusal
  if v_form.kind = 'form' and v_form.product_choice and v_product_raw is not null
     and app.org_has_feature(v_form.organization_id, 'products') then
    if v_product_raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select p.id, p.name into v_product, v_product_name
        from app.intake_form_products(v_form.organization_id, v_form.product_ids, v_form.product_category_ids) p
       where p.id = v_product_raw::uuid;
    end if;
    if v_product is null then
      raise exception 'invalid requested product' using errcode = '22023', hint = 'requested_product:invalid';
    end if;
  end if;

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  -- (SPD-05 follow-ups: the slots this form offers now, app.intake_callback_pick())
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select p.at, p.phrase into v_callback_at, v_callback_phrase
      from app.intake_callback_pick(v_form.organization_id, v_form.callback_slots_off, v_callback, now()) p;
    v_callback_note := 'ביקשו שנחזור אליהם ' || v_callback_phrase;
  else
    v_callback := null;
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  -- LEAD-08: with leads off only contacts are matched (the business's old leads stay as they are)
  if v_leads_on then
    select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
      from public.leads l
     where l.organization_id = v_form.organization_id and l.deleted_at is null
       and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
            or (v_email is not null and lower(l.email) = v_email))
     order by l.created_at desc
     limit 1;
  end if;
  if v_lead_match is null then
    -- CON-01: the contact's primary phone or email, or any of its other ones
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and c2.phone_e164 = v_phone_e164)
                 or (v_email is not null and lower(c2.email) = v_email))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and ch.value_e164 = v_phone_e164)
                 or (v_email is not null and ch.kind = 'email' and ch.value = v_email)))
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead_match is not null or v_contact_match is not null then
    -- first touch wins: the lead keeps its attribution and custom fields;
    -- this visit's are kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end
        || case when v_product is not null
                then jsonb_build_object('requested_product_id', v_product, 'requested_product', v_product_name)
                else '{}'::jsonb end);
    -- CAP-08: the form's language fills an empty one only
    if v_locale is not null then
      if v_lead_match is not null then
        update public.leads l set preferred_locale = v_locale
         where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.preferred_locale is null;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c set preferred_locale = v_locale
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and c.preferred_locale is null;
      end if;
    end if;
    -- LEAD-04 (020830): the form's product fills a matched lead's empty one only (a contact has no requested product;
    -- it stays on the inquiry entry)
    if v_product is not null and v_lead_match is not null then
      update public.leads l set requested_product_id = v_product
       where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.requested_product_id is null;
    end if;
    -- CON-10 (owner, 14 October 2026): the form's channel fills an empty one, or replaces one
    -- that came from a form; a channel a person set (or one older than its source) stays
    if v_channel is not null then
      if v_lead_match is not null then
        update public.leads l
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where l.organization_id = v_form.organization_id and l.id = v_lead_match
           and (l.preferred_channel is null or l.preferred_channel_source = 'form')
           and l.preferred_channel is distinct from v_channel;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and (c.preferred_channel is null or c.preferred_channel_source = 'form')
           and c.preferred_channel is distinct from v_channel;
      end if;
    end if;
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      -- SPD-05: the requested call-back time, when there is one, in the body
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים', v_callback_note,
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    -- SPD-05: a call task for the record's owner, else the form's owner
    if v_callback_at is not null then
      -- the record's owner while an active member who is not a viewer, else the form's owner, same check
      select m.user_id into v_task_owner from public.memberships m
       where m.organization_id = v_form.organization_id and m.user_id = v_owner
         and m.status = 'active' and m.role <> 'viewer';
      if v_task_owner is null then
        select m.user_id into v_task_owner from public.memberships m
         where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
           and m.status = 'active' and m.role <> 'viewer';
      end if;
      v_task := app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                     coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- SPD-01: the lead's call task follows "לקחתי"
      if v_lead_match is not null then
        insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
        values (v_task, v_form.organization_id, v_lead_match) on conflict do nothing;
      end if;
    end if;
    -- LEAD-08: with leads off a repeat inquiry from a contact also gets "לחזור ללקוח" (the call-back task does it when asked)
    if not v_leads_on and v_callback_at is null then
      -- the contact's own team (its task and, with no owner, who is told)
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, v_form.owner_id,
                                           (select c.team_id from public.contacts c
                                             where c.organization_id = v_form.organization_id and c.id = v_contact_match),
                                           v_contact_match,
                                           -- LEAD-04 (020830): the product's name in the task's title
                                           nullif(concat_ws(' · ', coalesce(v_full_name, v_phone, v_email), v_product_name), ''),
                                           v_form.name, false);
    end if;
    -- CAP-07 / CNS-04: the ticked boxes on the matched lead and on the contact the inquiry entry is on
    if cardinality(v_consent) > 0 then
      if v_lead_match is not null then
        perform app.intake_marketing_consent(v_form.organization_id, v_lead_match, null, v_consent, v_consent_wording,
                                             v_email, v_phone_e164);
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        perform app.intake_marketing_consent(v_form.organization_id, null, coalesce(v_lead_contact, v_contact_match),
                                             v_consent, v_consent_wording, v_email, v_phone_e164);
      end if;
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, v_payload, p_ip_hash, left(p_user_agent, 300));
    -- AUT-03: "form submitted" on the matched lead and the contact the inquiry entry is on
    perform app.emit_form_submitted(v_form.organization_id, v_form.id, 'repeat', v_lead_match, coalesce(v_lead_contact, v_contact_match));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  if v_leads_on then
    select s.id into v_status from public.lead_statuses s
     where s.organization_id = v_form.organization_id and s.kind = 'open'
     order by s.is_default desc, s.position
     limit 1;
    if v_status is null then
      raise exception 'the organization has no open lead status' using errcode = 'P0001';
    end if;
  end if;

  v_team := v_form.team_id;
  if v_form.assign_mode = 'round_robin' then
    -- CAP-08: the rules (source, language, list field; a team or one person), then the pick
    select p.owner_id, p.team_id, p.rule_user, p.absent_user into v_owner, v_team, v_rule_user, v_absent
      from app.lead_distribution_route(v_form.organization_id, v_form.team_id, now(),
                                       jsonb_build_object('source_id', v_form.source_id, 'locale', v_locale,
                                                          -- LEAD-04 (020830): the product rule sees the form's product
                                                          'product_id', v_product,
                                                          -- the values the lead will hold: with the
                                                          -- fields' defaults (FLD-07) the insert adds
                                                          'custom_fields', (select d.p_result from app.custom_field_defaults_apply(
                                                                              v_form.organization_id, 'lead', v_custom) d)),
                                       '{}'::uuid[]) p;
    -- CAP-09 (owner, 13 October 2026): nobody of the rotation in hours: the lead waits
    -- with no owner for a "לקחתי"; nobody available at all keeps the form owner's fallback
    v_rotation_closed := v_owner is null and v_rule_user is null and app.rotation_has_members(v_form.organization_id, v_team);
  end if;
  -- CAP-08: a rule's person (HEB-08 already applied) never falls back to the form's owner
  if v_owner is null and not v_rotation_closed and v_rule_user is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
    -- HEB-08: an absent form owner's new lead goes to their deputy; with no usable
    -- deputy it has no owner and takes the SPD-01 route (no chain)
    -- (app.auto_lead_owner: the rule every automatic assigner of a fixed person uses)
    if v_owner is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent
        from app.auto_lead_owner(v_form.organization_id, v_owner, now()) a;
    end if;
  end if;

  -- LEAD-08 (owner, 18 October 2026, answer (א)): leads are off: the same owner pick made a contact's owner, the
  -- inquiry is a contact with the details on its timeline, and someone is asked to call back ("לחזור ללקוח").
  -- With no owner (the rotation closed, an absent owner with no deputy) the contact waits for whoever takes the
  -- task: there is no waiting list for contacts, so nobody is handed it later.
  if not v_leads_on then
    v_name := coalesce(v_full_name, '');
    insert into public.contacts (organization_id, first_name, last_name, phone, email, source_id, owner_id, team_id,
                                 preferred_channel, preferred_channel_source, preferred_locale)
    values (v_form.organization_id,
            case when position(' ' in v_name) > 0 then split_part(v_name, ' ', 1) else nullif(v_name, '') end,
            case when position(' ' in v_name) > 0 then btrim(substr(v_name, position(' ' in v_name) + 1)) end,
            v_phone, v_email, v_form.source_id, v_owner, v_team,
            v_channel, case when v_channel is not null then 'form' end, v_locale)
    returning id into v_contact;
    -- what a lead would have held and a contact has no field for (message, company name, campaign, the form's own
    -- fields) is kept on the contact's timeline
    insert into public.activities (organization_id, type, body, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_contact,
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end
        || case when v_product is not null
                then jsonb_build_object('requested_product_id', v_product, 'requested_product', v_product_name)
                else '{}'::jsonb end);
    if v_callback_at is not null then
      -- SPD-05: the requested time is the follow-up; told first, so the task itself is quiet for the owner
      perform app.intake_contact_notice(v_form.organization_id, v_owner, v_team, v_contact, v_callback_note);
      v_task := app.intake_call_task(v_form.organization_id, v_owner, null, v_contact, v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- the call task takes the contact's team, as "לחזור ללקוח" does (intake_call_task finds a team on a lead only)
      update public.tasks t set team_id = v_team
       where t.organization_id = v_form.organization_id and t.id = v_task and v_team is not null
         and t.team_id is distinct from v_team;
    else
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, null, v_team, v_contact,
                                           -- LEAD-04 (020830): the product's name in the task's title
                                           nullif(concat_ws(' · ', coalesce(v_full_name, v_phone, v_email), v_product_name), ''),
                                           v_form.name, true);
    end if;
    -- CAP-07 / CNS-04: the ticked boxes on the new contact
    if cardinality(v_consent) > 0 then
      perform app.intake_marketing_consent(v_form.organization_id, null, v_contact, v_consent, v_consent_wording,
                                           v_email, v_phone_e164);
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'accepted', null, v_payload, p_ip_hash, left(p_user_agent, 300));
    -- AUT-03: "form submitted" on the new contact
    perform app.emit_form_submitted(v_form.organization_id, v_form.id, 'new', null, v_contact);
    return jsonb_build_object(
      'status', 'accepted',
      'contact_id', v_contact,
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  -- SPD-01: the owner is told as 'lead_new' (app.notify_assignment())
  perform set_config('app.intake', 'on', true);
  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields, preferred_channel, preferred_channel_source, preferred_locale,
                            requested_product_id)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_team,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content',
            -- CAP-02: the extra parameters of the closed list, in one place
            'extra', v_attr -> 'extra')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid',
          v_custom, v_channel, case when v_channel is not null then 'form' end, v_locale,
          v_product)
  returning id into v_lead;
  perform set_config('app.intake', '', true);

  -- CAP-09: if nobody takes it, the rotation gives it to the first member back in hours
  if v_rotation_closed then
    insert into app.rotation_waiting_leads (lead_id, organization_id, team_id)
    values (v_lead, v_form.organization_id, v_team) on conflict do nothing;
  end if;

  -- HEB-08: back from the absence, the form's owner gets it if nobody took it (app.return_absence_leads())
  if v_owner is null and v_absent is not null then
    perform app.lead_waits_for_absent(v_form.organization_id, v_lead, v_form.id, v_absent);
  end if;

  -- SPD-01: nobody owns it: whoever may take it is told, and the first "לקחתי" wins
  if v_owner is null then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    select v_form.organization_id, r.user_id, 'lead_new', 'ליד חדש מחכה למי שייקח אותו', 'lead', v_lead
      from app.intake_unowned_recipients(v_form.organization_id, v_team) r;
  end if;

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    v_task := app.intake_call_task(v_form.organization_id, v_owner, v_lead, null, v_callback = 'now', v_callback_at,
                                   v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    -- SPD-01: the lead's call task follows "לקחתי"
    insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
    values (v_task, v_form.organization_id, v_lead) on conflict do nothing;
    update public.notifications n set body = v_callback_note
     where n.organization_id = v_form.organization_id and n.entity_type = 'lead' and n.entity_id = v_lead
       and n.body is null;
  end if;

  -- CAP-07 / CNS-04: the ticked boxes on the new lead
  if cardinality(v_consent) > 0 then
    perform app.intake_marketing_consent(v_form.organization_id, v_lead, null, v_consent, v_consent_wording,
                                         v_email, v_phone_e164);
  end if;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, v_payload, p_ip_hash, left(p_user_agent, 300));
  -- AUT-03: "form submitted" on the new lead
  perform app.emit_form_submitted(v_form.organization_id, v_form.id, 'new', v_lead, null);

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;

revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;

-- The latest scheduled time at or before p_now, as an instant, looking back up to 8 days; null when the setting is not a
-- valid one: {frequency: daily | weekly, time: 'HH:MM', days: [0..6] for weekly (0 = Sunday)}. Each day's time is turned
-- into an instant in p_zone and compared with p_now (not with the local wall clock), so the answer never steps back as
-- p_now moves on, also in the hour a clock is set back (an ambiguous local time is read as PostgreSQL reads it).
create or replace function app.schedule_slot(p_config jsonb, p_now timestamptz, p_zone text) returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_frequency text := p_config ->> 'frequency';
  v_time text := p_config ->> 'time';
  v_today date := (p_now at time zone p_zone)::date;
  v_day date;
  v_slot timestamptz;
  v_i integer;
begin
  if coalesce(v_frequency, '') not in ('daily', 'weekly') or jsonb_typeof(p_config -> 'time') is distinct from 'string'
     or v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return null;
  end if;
  if v_frequency = 'weekly' and (jsonb_typeof(p_config -> 'days') is distinct from 'array'
     or not exists (select 1 from jsonb_array_elements(p_config -> 'days') d
                     where jsonb_typeof(d) = 'number' and d::text in ('0', '1', '2', '3', '4', '5', '6'))) then
    return null;
  end if;
  -- days run backwards from today, so the first instant at or before p_now is the latest one
  for v_i in 0 .. 8 loop
    v_day := v_today - v_i;
    if v_frequency = 'daily' or (p_config -> 'days') @> jsonb_build_array(extract(dow from v_day)::integer) then
      v_slot := (v_day + v_time::time) at time zone p_zone;
      if v_slot <= p_now then
        return v_slot;
      end if;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function app.schedule_slot(jsonb, timestamptz, text) from public, anon, authenticated, service_role;

-- Runs per business in one pass (default and most 200; the setting app.schedule_runs_per_business is for tests) and runs
-- in one pass across every business (default and most 2,000; app.schedule_runs_per_pass). The cap keeps a pass, and so
-- the AUT-07 month-row locks its runs take (each held to the end of the pass's transaction), bounded.
create or replace function app.schedule_runs_per_business() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,3}$' and s::int between 1 and 200 then s::int else 200 end
    from coalesce(current_setting('app.schedule_runs_per_business', true), '') as s;
$$;
revoke all on function app.schedule_runs_per_business() from public, anon, authenticated, service_role;

create or replace function app.schedule_runs_per_pass() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,4}$' and s::int between 1 and 2000 then s::int else 2000 end
    from coalesce(current_setting('app.schedule_runs_per_pass', true), '') as s;
$$;
revoke all on function app.schedule_runs_per_pass() from public, anon, authenticated, service_role;

-- records examined in one pass across every business, whether they run or not (default and most 20,000; the setting
-- app.schedule_scan_per_pass is for tests): a rule whose conditions match few records still costs bounded work a pass
create or replace function app.schedule_scan_per_pass() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,5}$' and s::int between 1 and 20000 then s::int else 20000 end
    from coalesce(current_setting('app.schedule_scan_per_pass', true), '') as s;
$$;
revoke all on function app.schedule_scan_per_pass() from public, anon, authenticated, service_role;

-- the last pass that gave each business its turn (the runner orders businesses by it, least recent first); server only
create table if not exists app.schedule_business_turns (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  last_turn_at    timestamptz not null default now()
);
alter table app.schedule_business_turns enable row level security;
revoke all on app.schedule_business_turns from public, anon, authenticated, service_role;

-- a rule had its turn: its cursor's time moves to the pass's time (now(), as app.scan_cursor_set stamps), so it goes after
-- the others next pass. Where it stands (after_at, after_id, the done marker) is kept, unless the cursor is older than the
-- rule's last change, read again here (an edit committed since the pass read the rule counts; app.scan_cursor_get ignores
-- such a cursor): then it starts again; run keys keep a record from running twice for one scheduled time. A rule deleted
-- meanwhile gets no cursor.
create or replace function app.schedule_cursor_touch(p_auto public.automations) returns void
language sql security definer
set search_path = ''
as $$
  insert into app.automation_scan_cursors as c (automation_id, organization_id, after_at, after_id, updated_at)
  select a.id, a.organization_id, '-infinity', '00000000-0000-0000-0000-000000000000', now()
    from public.automations a where a.id = p_auto.id
  on conflict (automation_id) do update
    set updated_at = excluded.updated_at,
        after_at = case when c.updated_at < (select a.updated_at from public.automations a where a.id = c.automation_id)
                        then '-infinity'::timestamptz else c.after_at end,
        after_id = case when c.updated_at < (select a.updated_at from public.automations a where a.id = c.automation_id)
                        then '00000000-0000-0000-0000-000000000000'::uuid else c.after_id end;
$$;
revoke all on function app.schedule_cursor_touch(public.automations) from public, anon, authenticated, service_role;

-- one schedule rule: its records for the latest scheduled time, from its scan cursor; at most p_budget runs and p_scan
-- records examined (and app.scheduled_scan_limit()); answers the runs and the records examined
create or replace function app.scheduled_schedule(p_auto public.automations, p_budget integer, p_scan integer,
                                                  out runs integer, out scanned integer)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_table text := app.automation_table(p_auto.entity_type);
  v_zone text;
  v_slot_at timestamptz;
  v_suffix text;
  v_key text;
  v_extra text := '';
  v_cursor_at timestamptz;
  v_after uuid;
  v_done constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_row record;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := least(app.scheduled_scan_limit(), p_scan);
  v_page_size integer := least(200, v_limit);
  v_count integer := 0;
begin
  runs := 0;
  scanned := 0;
  if v_table is null or p_budget <= 0 or p_scan <= 0 then
    return;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_auto.organization_id;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_slot_at := app.schedule_slot(p_auto.trigger_config, now(), v_zone);
  -- a time that came more than 24 hours ago is not caught up; the rule still had its turn
  if v_slot_at is null or v_slot_at <= now() - interval '24 hours' then
    perform app.schedule_cursor_touch(p_auto);
    return;
  end if;
  v_suffix := ':' || to_char(v_slot_at at time zone v_zone, 'YYYY-MM-DD"T"HH24:MI');
  select c.after_at, c.after_id into v_cursor_at, v_after from app.scan_cursor_get(p_auto) c;
  if v_cursor_at is distinct from v_slot_at then
    v_after := v_zero;
  elsif v_after = v_done then
    perform app.schedule_cursor_touch(p_auto);
    return;
  end if;
  v_extra := case p_auto.entity_type when 'lead' then ' and t.converted_at is null'
                                     when 'deal' then ' and t.status = ''open'''
                                     when 'task' then ' and t.status = ''open''' else '' end;
  <<pages>>
  loop
    v_page := 0;
    for v_row in execute format(
      'select t.id from public.%I t
        where t.organization_id = $1 and t.deleted_at is null %s
          and t.id > $2
        order by t.id
        limit $3', v_table, v_extra)
      using p_auto.organization_id, v_after, v_page_size
    loop
      v_page := v_page + 1;
      v_after := v_row.id;
      v_key := 'sched:' || v_row.id || v_suffix;
      -- one record that fails does not stop its rule: its run is undone, and the record is logged as skipped for this
      -- time (with the run key, so it is not tried again until the next time) and named in the server log
      -- a record that already ran for this time is skipped here, not in the page query, so it counts as examined
      if not exists (select 1 from public.automation_runs r where r.automation_id = p_auto.id and r.run_key = v_key) then
        begin
          if app.execute_automation(p_auto, v_row.id, v_key) is not null then
            v_count := v_count + 1;
          end if;
        exception when others then
          raise warning 'schedule automation % on record % failed: %', p_auto.id, v_row.id, sqlerrm;
          insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status, steps)
          values (p_auto.organization_id, p_auto.id, p_auto.entity_type, v_row.id, v_key, 'skipped',
                  jsonb_build_array(jsonb_build_object('action', null, 'status', 'error', 'error', 'the run stopped with an error')))
          on conflict (automation_id, run_key) do nothing;
        end;
      end if;
      if v_count >= p_budget or v_scanned + v_page >= v_limit then
        perform app.scan_cursor_set(p_auto, v_slot_at, v_after);
        v_scanned := v_scanned + v_page;
        exit pages;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: this scheduled time is done
      perform app.scan_cursor_set(p_auto, v_slot_at, v_done);
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, v_slot_at, v_after);
      exit;
    end if;
  end loop;
  runs := v_count;
  scanned := v_scanned;
end;
$$;
revoke all on function app.scheduled_schedule(public.automations, integer, integer) from public, anon, authenticated, service_role;

-- every active schedule rule of a writable business. Businesses go in the order of their last turn
-- (app.schedule_business_turns, stamped whenever a pass reaches the business, even if it runs nothing; a business never
-- stamped goes first), then their id, so under the pass caps no business starves another. Per business at
-- most app.schedule_runs_per_business() runs a pass, shared fairly: its rules go least recently worked first, each gets an
-- equal share of what is left (rounded up), and a share a rule does not use passes on to the rules after it. Across all
-- businesses at most app.schedule_runs_per_pass() runs and app.schedule_scan_per_pass() records examined a pass. A rule
-- that raises is named in the server log and its cursor's time is moved (app.schedule_cursor_touch), so it goes last next
-- pass; an idle rule (no time due, or its time done) is touched the same way.
create or replace function app.run_schedule_automations() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org record;
  v_auto public.automations%rowtype;
  v_budget integer;
  v_left integer;
  v_share integer;
  v_result record;
  v_count integer := 0;
  v_scanned integer := 0;
  v_pass integer := app.schedule_runs_per_pass();
  v_scan integer := app.schedule_scan_per_pass();
begin
  <<orgs>>
  for v_org in
    select a.organization_id as id, count(*)::integer as rules
      from public.automations a
      left join app.schedule_business_turns t on t.organization_id = a.organization_id
     where a.is_active and a.trigger_type = 'schedule'
       and app.org_writable(a.organization_id)
     group by a.organization_id, t.last_turn_at
     order by coalesce(t.last_turn_at, '-infinity'::timestamptz), a.organization_id
  loop
    exit orgs when v_count >= v_pass or v_scanned >= v_scan;
    insert into app.schedule_business_turns (organization_id, last_turn_at) values (v_org.id, clock_timestamp())
    on conflict (organization_id) do update set last_turn_at = excluded.last_turn_at;
    v_budget := app.schedule_runs_per_business();
    v_left := v_org.rules;
    for v_auto in
      select a.* from public.automations a
        left join app.automation_scan_cursors c on c.automation_id = a.id
       where a.organization_id = v_org.id and a.is_active and a.trigger_type = 'schedule'
       order by coalesce(c.updated_at, '-infinity'::timestamptz), a.id
    loop
      exit orgs when v_count >= v_pass or v_scanned >= v_scan;
      v_share := least(ceil(v_budget::numeric / greatest(v_left, 1))::integer, v_pass - v_count);
      v_left := v_left - 1;
      continue when v_share <= 0;
      begin
        select * into v_result from app.scheduled_schedule(v_auto, v_share, v_scan - v_scanned);
        v_budget := v_budget - v_result.runs;
        v_count := v_count + v_result.runs;
        v_scanned := v_scanned + v_result.scanned;
      exception when others then
        raise warning 'schedule automation % failed: %', v_auto.id, sqlerrm;
        -- its own block: a touch that fails too (the rule deleted meanwhile) never stops the pass
        begin
          perform app.schedule_cursor_touch(v_auto);
        exception when others then
          raise warning 'schedule automation % cursor not moved: %', v_auto.id, sqlerrm;
        end;
      end;
    end loop;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.run_schedule_automations() from public, anon, authenticated;
grant execute on function app.run_schedule_automations() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-schedule-automations', '*/15 * * * *', 'select app.run_schedule_automations();');
  end if;
end;
$$;

-- the record a manual rule may run on for this caller: live, of one of the four types, editable by the caller; else null
create or replace function app.manual_automation_record(p_org uuid, p_entity text, p_record uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_record jsonb;
begin
  if p_entity not in ('lead', 'contact', 'company', 'deal') or app.role_in(p_org) is null then
    return null;
  end if;
  v_record := app.automation_record(p_entity, p_org, p_record);
  if v_record is null or (v_record ->> 'deleted_at') is not null
     or not app.can_edit_record(p_org, (v_record ->> 'owner_id')::uuid, (v_record ->> 'team_id')::uuid) then
    return null;
  end if;
  return v_record;
end;
$$;
revoke all on function app.manual_automation_record(uuid, text, uuid) from public, anon, authenticated, service_role;

-- the active manual rules of the record's type, for its card ([{id, name}], at most 50); empty for anyone who may not edit it
create or replace function public.manual_automations(p_org uuid, p_entity text, p_record uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if app.manual_automation_record(p_org, p_entity, p_record) is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.name, x.id)
      from (select a.id, a.name from public.automations a
             where a.organization_id = p_org and a.is_active and a.trigger_type = 'manual' and a.entity_type = p_entity
             order by a.name, a.id limit 50) x), '[]'::jsonb);
end;
$$;
revoke all on function public.manual_automations(uuid, text, uuid) from public, anon, service_role;
grant execute on function public.manual_automations(uuid, text, uuid) to authenticated;

-- run one manual rule on one record from its card: {ok: true, status} | {ok: false, reason: not_found | conditions | limit}
-- (limit with detail daily = 20 runs of the rule on the record today, quota = the plan's monthly runs). The run key is
-- 'button:<uuid>': unlike an admin's 'manual:' test run, AUT-07 counts and stops it (lead's decision, 26 October 2026);
-- AUT-06 never retries it (a manual rule has no retry facts).
create or replace function public.run_manual_automation(p_org uuid, p_automation uuid, p_record uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_key text := 'button:' || gen_random_uuid();
  v_status text;
  v_error text;
begin
  select * into v_auto from public.automations a
   where a.organization_id = p_org and a.id = p_automation and a.is_active and a.trigger_type = 'manual';
  if not found or app.manual_automation_record(p_org, v_auto.entity_type, p_record) is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  v_status := app.execute_automation(v_auto, p_record, v_key);
  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'conditions');
  end if;
  if v_status = 'skipped' then
    select r.steps -> 0 ->> 'error' into v_error from public.automation_runs r
     where r.automation_id = v_auto.id and r.run_key = v_key;
    return jsonb_build_object('ok', false, 'reason', 'limit',
      'detail', case when v_error = 'the monthly automation runs of the plan are used up' then 'quota' else 'daily' end);
  end if;
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;
revoke all on function public.run_manual_automation(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.run_manual_automation(uuid, uuid, uuid) to authenticated;
