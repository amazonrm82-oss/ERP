-- =============================================================================
-- AUT-04: commercial automation triggers (quotes, documents, meetings)
-- =============================================================================
-- New trigger types, each an outbox event per linked record, as PAY-07 (payment_received / payment_confirmed, already built):
--   quote_viewed | quote_accepted | quote_declined | quote_expired  (deal and contact rules; flag `quotes`)
--     a quote's status moving to viewed / accepted / rejected / expired, on every path that moves it: the customer's page
--     (app.quote_mark_viewed, public.quote_public_decide; service role, no actor), the expiry job (app.expire_quotes) and any
--     other update of the status column. One event for the quote's deal and one for its contact (owner's answer 3 א,
--     25 October 2026); a quote with neither (detached) writes none.
--   document_recorded  (deal and contact rules; flag `documents`): an active accounting_documents row is inserted (DOC-01,
--     a document issued outside the system; owner's answer 2 א). A cancel writes nothing.
--   meeting_scheduled | meeting_cancelled | meeting_no_show  (lead, contact, company and deal rules; core, no flag)
--     a planned meeting is inserted / a meeting's status moves to cancelled / no_show, one event per linked record. Blocked
--     time (is_block) never writes one, whatever its status. Of a weekly series (CAL-09) only the first meeting writes
--     "scheduled" (owner's answer 1 ב: 52 at once would start 52 runs and use up the AUT-07 quota);
--     each meeting of a series still writes its own cancelled / no-show.
-- * "הצעה אושרה" takes an optional trigger_config.min_agorot (owner's answer 4 ב), compared with net_total_agorot, the
--   quote's amount before VAT after the document discount; a value that is not a JSON number is ignored.
-- * Payloads: quotes {quote_id, number, status, net_total_agorot}, documents {document_id, doc_type, amount_agorot}, meetings
--   {meeting_id, starts_at, status}; plus origin 'automation' only while app.automation_running is on (then no rule runs).
-- * app.automation_trigger_feature(type) names the plan flag a trigger needs (payments / quotes / documents, mirrored by
--   TriggerOption.feature in src/features/automations/definitions.ts): the builder offers and toDbRule saves it only with
--   the flag, and app.process_outbox (body of 020780) runs such a rule only while the business still has the flag.
-- * app.automation_event_matches, app.process_outbox, app.automation_run_facts and app.automation_event_still_holds (bodies
--   of 020780) learn the types. AUT-06 retry: the facts are the quote / document / meeting id from the event (and the
--   meeting's start); a retry runs only while the quote is still in that state, the document is still active, the meeting
--   is still planned at the same start / still cancelled / still a no-show.
-- * app.retry_automation_run (body of 020755): right after the closed-business check, a run whose rule needs a plan flag the
--   business no longer has ends its retries with the note feature_off ("לא רץ: לא כלול בתוכנית"; automation_runs_retry_shape
--   takes it).
-- * Left out: "debt overdue" (follows PAY-02's due date) and "recurring charge failed" (no recurring-charge module yet).
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.automations drop constraint if exists automations_trigger_type_check;
alter table public.automations add constraint automations_trigger_type_check check (trigger_type = any (array[
  'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'no_activity', 'stuck_in_stage', 'birthday',
  'task_due_soon', 'date_reached', 'payment_received', 'payment_confirmed', 'quote_viewed', 'quote_accepted',
  'quote_declined', 'quote_expired', 'document_recorded', 'meeting_scheduled', 'meeting_cancelled', 'meeting_no_show']));

-- the plan flag a trigger type needs (null = core)
create or replace function app.automation_trigger_feature(p_trigger text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_trigger in ('payment_received', 'payment_confirmed') then 'payments'
    when p_trigger in ('quote_viewed', 'quote_accepted', 'quote_declined', 'quote_expired') then 'quotes'
    when p_trigger = 'document_recorded' then 'documents'
  end
$$;
revoke all on function app.automation_trigger_feature(text) from public, anon, authenticated, service_role;

-- one outbox event per linked record (null ids are skipped)
create or replace function app.emit_commercial_event(p_org uuid, p_event text, p_payload jsonb, p_links jsonb) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payload jsonb := p_payload
    || case when current_setting('app.automation_running', true) = 'on' then jsonb_build_object('origin', 'automation') else '{}'::jsonb end;
  v_link record;
begin
  for v_link in select key, value from jsonb_each_text(p_links) where value is not null loop
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (p_org, p_event, v_link.key, v_link.value::uuid, auth.uid(), v_payload);
  end loop;
end;
$$;
revoke all on function app.emit_commercial_event(uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function app.emit_quote_events() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_event text;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  v_event := case new.status when 'viewed' then 'quote_viewed' when 'accepted' then 'quote_accepted'
                             when 'rejected' then 'quote_declined' when 'expired' then 'quote_expired' end;
  if v_event is null then
    return null;
  end if;
  perform app.emit_commercial_event(new.organization_id, v_event,
    jsonb_build_object('quote_id', new.id, 'number', new.number_display, 'status', new.status,
                       'net_total_agorot', new.net_total_agorot),
    jsonb_build_object('deal', new.deal_id, 'contact', new.contact_id));
  return null;
end;
$$;
revoke all on function app.emit_quote_events() from public, anon, authenticated, service_role;

create or replace trigger quotes_emit_events after update of status on public.quotes
  for each row execute function app.emit_quote_events();

create or replace function app.emit_document_recorded() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'active' then
    return null;
  end if;
  perform app.emit_commercial_event(new.organization_id, 'document_recorded',
    jsonb_build_object('document_id', new.id, 'doc_type', new.doc_type, 'amount_agorot', new.amount_agorot),
    jsonb_build_object('deal', new.deal_id, 'contact', new.contact_id));
  return null;
end;
$$;
revoke all on function app.emit_document_recorded() from public, anon, authenticated, service_role;

create or replace trigger accounting_documents_emit_recorded after insert on public.accounting_documents
  for each row execute function app.emit_document_recorded();

create or replace function app.emit_meeting_events() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_event text;
begin
  if new.is_block then
    return null;
  end if;
  if tg_op = 'INSERT' then
    -- of a weekly series only the first meeting is "scheduled"
    if new.status <> 'planned' or coalesce(new.series_index, 1) <> 1 then
      return null;
    end if;
    v_event := 'meeting_scheduled';
  else
    if new.status is not distinct from old.status then
      return null;
    end if;
    v_event := case new.status when 'cancelled' then 'meeting_cancelled' when 'no_show' then 'meeting_no_show' end;
    if v_event is null then
      return null;
    end if;
  end if;
  perform app.emit_commercial_event(new.organization_id, v_event,
    jsonb_build_object('meeting_id', new.id, 'starts_at', new.starts_at, 'status', new.status),
    jsonb_build_object('lead', new.lead_id, 'contact', new.contact_id, 'company', new.company_id, 'deal', new.deal_id));
  return null;
end;
$$;
revoke all on function app.emit_meeting_events() from public, anon, authenticated, service_role;

create or replace trigger meetings_emit_events after insert or update of status on public.meetings
  for each row execute function app.emit_meeting_events();

create or replace function app.automation_event_matches(p_auto public.automations, p_event public.outbox_events, p_record jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_auto.entity_type = p_event.entity_type and case p_auto.trigger_type
    when 'created' then p_event.event_type = p_auto.entity_type || '.created'
    when 'field_changed' then p_event.event_type = p_auto.entity_type || '.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? (p_auto.trigger_config ->> 'field')
      and ((p_auto.trigger_config ->> 'to') is null or p_record ->> (p_auto.trigger_config ->> 'field') = p_auto.trigger_config ->> 'to')
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
                                   'document_recorded', 'meeting_scheduled', 'meeting_cancelled', 'meeting_no_show')
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
      return jsonb_build_object('value', v_record -> (p_config ->> 'field'));
    when 'no_activity' then
      -- the last activity when the run ends, by the rule of the check below (and of app.scheduled_no_activity), so the
      -- run's own timeline entries (a status or stage change by its steps) count as seen; only later activity ends retries
      if p_entity not in ('lead', 'contact', 'company', 'deal') then
        return null;
      end if;
      execute format(
        'select coalesce((select max(a.occurred_at) from public.activities a
                           where a.organization_id = $1 and a.%I = $2 and a.type <> ''automation_note''),
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
      if (p_config ->> 'to') is not null then
        return p_record ->> v_field is not distinct from p_config ->> 'to';
      end if;
      return p_facts ? 'value' and (p_record -> v_field) is not distinct from (p_facts -> 'value');
    when 'no_activity' then
      if p_entity not in ('lead', 'contact', 'company', 'deal')
         or (p_entity = 'lead' and (p_record ->> 'converted_at') is not null)
         or (p_entity = 'deal' and p_record ->> 'status' is distinct from 'open') then
        return false;
      end if;
      execute format(
        'select coalesce((select max(a.occurred_at) from public.activities a
                           where a.organization_id = $1 and a.%I = $2 and a.type <> ''automation_note''),
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
    when 'payment_confirmed' then
      -- the payment is still confirmed (not moved back to recorded, failed, refunded or cancelled)
      return exists (select 1 from public.payments p
                      where p.organization_id = p_org and p.id = (p_facts ->> 'payment_id')::uuid and p.status = 'confirmed');
    else
      -- a trigger type without a decision is never retried
      return false;
  end case;
end;
$$;
revoke all on function app.automation_event_still_holds(text, jsonb, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

alter table public.automation_runs drop constraint if exists automation_runs_retry_shape;
alter table public.automation_runs add constraint automation_runs_retry_shape check (
  retry_count between 0 and 3
  and (retry_note is null or retry_note in ('rule_changed', 'rule_off', 'record_gone', 'conditions', 'error', 'event_changed', 'org_closed',
                                            'feature_off')));

create or replace function app.retry_automation_run(p_run uuid) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_run public.automation_runs%rowtype;
  v_auto public.automations%rowtype;
  v_record jsonb;
  v_failed integer[];
  v_actions jsonb;
  v_new jsonb;
  v_steps jsonb;
  v_i integer;
  v_j integer := 0;
  v_ok integer;
  v_total integer;
  v_status text;
  v_slot integer;
  v_labelled boolean;
  v_all integer;
begin
  select * into v_run from public.automation_runs r
   where r.id = p_run and r.next_retry_at is not null and r.next_retry_at <= now()
   for update skip locked;
  if not found then
    return null;
  end if;
  select * into v_auto from public.automations a where a.organization_id = v_run.organization_id and a.id = v_run.automation_id;
  -- the reasons to stop trying; the owner, 21 October 2026 (6): a read-only or closed business's retries are cancelled
  if not app.org_writable(v_run.organization_id) then
    update public.automation_runs set next_retry_at = null, retry_note = 'org_closed' where id = v_run.id;
    return 'ended';
  end if;
  -- AUT-04 review: a rule whose trigger needs a plan flag the business no longer has is not tried again
  if v_auto.id is not null and app.automation_trigger_feature(v_auto.trigger_type) is not null
     and not app.org_has_feature(v_run.organization_id, app.automation_trigger_feature(v_auto.trigger_type)) then
    update public.automation_runs set next_retry_at = null, retry_note = 'feature_off' where id = v_run.id;
    return 'ended';
  end if;
  if v_auto.id is not null and not v_auto.is_active then
    update public.automation_runs set next_retry_at = null, retry_note = 'rule_off' where id = v_run.id;
    return 'ended';
  end if;
  if v_auto.id is null or v_auto.updated_at > v_run.created_at then
    update public.automation_runs set next_retry_at = null, retry_note = 'rule_changed' where id = v_run.id;
    return 'ended';
  end if;
  v_record := app.automation_record(v_run.entity_type, v_run.organization_id, v_run.entity_id);
  if v_record is null or (v_record ->> 'deleted_at') is not null then
    update public.automation_runs set next_retry_at = null, retry_note = 'record_gone' where id = v_run.id;
    return 'ended';
  end if;
  if not app.automation_conditions_match(v_record, v_auto.conditions) then
    update public.automation_runs set next_retry_at = null, retry_note = 'conditions' where id = v_run.id;
    return 'ended';
  end if;
  if not app.automation_event_still_holds(v_auto.trigger_type, v_auto.trigger_config, v_run.entity_type, v_run.organization_id,
                                          v_run.entity_id, v_record, v_run.event_facts) then
    update public.automation_runs set next_retry_at = null, retry_note = 'event_changed' where id = v_run.id;
    return 'ended';
  end if;

  -- the owner, 21 October 2026 (3): the failed step and every step after it that did not run, never one that worked. The
  -- engine runs every step and records each (it continues past a failure), so this is every position of the rule's
  -- actions whose step is not 'ok': failed, or missing from the log (never ran). The rule is unchanged since the run, so
  -- its actions line up with the steps by position.
  select coalesce(array_agg(a.ord order by a.ord), '{}') into v_failed
    from jsonb_array_elements(v_auto.actions) with ordinality a(action, ord)
   where coalesce(v_run.steps -> (a.ord::integer - 1) ->> 'status', '') <> 'ok';
  if cardinality(v_failed) = 0 then
    update public.automation_runs set next_retry_at = null where id = v_run.id;
    return 'ended';
  end if;
  select coalesce(jsonb_agg(v_auto.actions -> (i - 1) order by i), '[]'::jsonb) into v_actions from unnest(v_failed) i;
  v_all := jsonb_array_length(v_auto.actions);
  v_auto.actions := v_actions;

  perform set_config('app.automation_running', 'on', true);
  v_slot := (txid_current() % 65536)::integer;
  perform 1 from app.automation_rule_runs where slot = v_slot for update skip locked;
  v_labelled := found;
  if v_labelled then
    update app.automation_rule_runs
       set txid = txid_current(), organization_id = v_auto.organization_id, rule_id = v_auto.id
     where slot = v_slot;
  end if;
  v_new := app.run_automation_actions(v_auto, v_run.entity_type, v_run.entity_id);
  if v_labelled then
    update app.automation_rule_runs set rule_id = null where slot = v_slot and txid = txid_current();
  end if;
  perform set_config('app.automation_running', 'off', true);

  -- each retried step takes its new result, marked with the attempt; a step that worked keeps its old entry
  v_steps := '[]'::jsonb;
  for v_i in 1 .. v_all loop
    if v_i = any (v_failed) then
      v_steps := v_steps || jsonb_build_array((v_new -> v_j) || jsonb_build_object('attempt', v_run.retry_count + 2));
      v_j := v_j + 1;
    else
      v_steps := v_steps || jsonb_build_array(v_run.steps -> (v_i - 1));
    end if;
  end loop;
  select count(*) filter (where s ->> 'status' = 'ok'), count(*) into v_ok, v_total from jsonb_array_elements(v_steps) s;
  v_status := case when v_ok = v_total then 'success' when v_ok = 0 then 'failed' else 'partial' end;
  update public.automation_runs
     set steps = v_steps, status = v_status, retry_count = v_run.retry_count + 1,
         next_retry_at = case when v_status = 'success' then null
                              else now() + app.automation_retry_delay(v_run.retry_count + 1) end
   where id = v_run.id;
  return v_status;
end;
$$;
revoke all on function app.retry_automation_run(uuid) from public, anon, authenticated, service_role;
