-- =============================================================================
-- RET-01: dormant customers (owner, 2 November 2026, answer (56) א: every plan, no key)
-- =============================================================================
-- Needs CON-11 (customer_status migration): the kept facts app.customer_purchase_facts and its readers.
-- * The list: public.dormant_customers(org, kind, limit) for owners and admins (the kept facts are business-wide, as the
--   list columns; anyone else gets {allowed: false}): contacts or companies not in the bin whose status is dormant today,
--   longest without a purchase first, at most 500, `more` when there are more. Index-driven: the kept last day in a window
--   around the thresholds (a few days wide, for the month-end clamp), then the exact rule. The app's page
--   /o/[org]/contacts/dormant. Computed field public.customer_last_purchase (owners and admins, kept).
-- * The trigger customer_dormant (contact and company rules): a scheduled scan like debt_overdue. pg_cron
--   crm-dormant-automations (every 15 minutes) runs app.run_dormant_automations(): active rules of writable businesses, from
--   08:00 in the business's zone (app.date_trigger_hour()), at most 200 runs per business a pass, each rule taking at most
--   app.scheduled_scan_limit() records a pass from its scan cursor. A record whose status (read in full, the server's view)
--   is dormant today (from last purchase + dormant months, before last purchase + former months) runs the rule once per
--   record and last purchase: run key dormant:<record>:<the last purchase day> (review: keyed by the dormancy day, a change of
--   the dormant months ran the rule again for the same quiet spell). A new purchase moves the day, so a
--   customer who buys and goes quiet again is a new occasion; a former customer never runs it. Existing dormant customers
--   run it once when a rule is switched on (that is the list to call back), 200 per business a pass.
-- * The action is any existing one (create_task gets the call-back task). AUT-06: facts {last_purchase_on, dormant_on}
--   (the last from the run key, dormant_on by the thresholds of the run); a retry holds only while the kept last purchase is
--   the same (no purchase since).
-- * Accepted: the scan pages through the dormant window by id from its cursor, re-reading the window's rows before the
--   cursor on each page (quadratic in the window's size per pass, bounded by app.scheduled_scan_limit()); fine at today's
--   sizes, an index on (organization_id, customer_id) inside the window is the follow-up.
-- * Shared ground, each redefined from its latest body: the constraint (021000), app.automation_event_matches (021000; the
--   type never starts from an event), app.automation_run_facts and app.automation_event_still_holds (021091). Not
--   app.process_outbox (021000): it only picks rules whose trigger comes from an outbox event, and this one never does, so
--   its type list stays as it is (the same as debt_overdue, date_reached and schedule).

-- the kept last purchase day (owners and admins; null otherwise or for a contact or company that is not a customer)
create or replace function public.customer_last_purchase(public.contacts) returns date
language sql stable
as $$ select app.customer_kept_last(($1).organization_id, ($1).id, null) $$;
create or replace function public.customer_last_purchase(public.companies) returns date
language sql stable
as $$ select app.customer_kept_last(($1).organization_id, null, ($1).id) $$;
revoke all on function public.customer_last_purchase(public.contacts) from public, anon;
revoke all on function public.customer_last_purchase(public.companies) from public, anon;
grant execute on function public.customer_last_purchase(public.contacts) to authenticated;
grant execute on function public.customer_last_purchase(public.companies) to authenticated;

-- the customers whose kept last day is dormant today (the server's view; no grants): the list and the scan share it
create or replace function app.dormant_customer_rows(p_org uuid, p_kind text, p_after uuid, p_limit integer)
returns table (id uuid, last_purchase_on date, value_agorot bigint)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date;
  v_dormant integer;
  v_former integer;
begin
  select m.dormant_months, m.former_months into v_dormant, v_former from app.customer_status_months(p_org) m;
  if p_kind = 'contact' then
    return query
      select f.contact_id, f.last_purchase_on, f.value_agorot
        from app.customer_purchase_facts f
        join public.contacts c on c.organization_id = f.organization_id and c.id = f.contact_id and c.deleted_at is null
       where f.organization_id = p_org and f.purchases > 0 and f.contact_id is not null
         and f.last_purchase_on <= (v_today - make_interval(months => v_dormant))::date + 4
         and f.last_purchase_on > (v_today - make_interval(months => v_former))::date - 4
         and app.customer_status_rule(f.last_purchase_on, v_today, v_dormant, v_former) = 'dormant'
         and (p_after is null or f.contact_id > p_after)
       order by case when p_after is null then f.last_purchase_on end, f.contact_id
       limit p_limit;
  elsif p_kind = 'company' then
    return query
      select f.company_id, f.last_purchase_on, f.value_agorot
        from app.customer_purchase_facts f
        join public.companies c on c.organization_id = f.organization_id and c.id = f.company_id and c.deleted_at is null
       where f.organization_id = p_org and f.purchases > 0 and f.company_id is not null
         and f.last_purchase_on <= (v_today - make_interval(months => v_dormant))::date + 4
         and f.last_purchase_on > (v_today - make_interval(months => v_former))::date - 4
         and app.customer_status_rule(f.last_purchase_on, v_today, v_dormant, v_former) = 'dormant'
         and (p_after is null or f.company_id > p_after)
       order by case when p_after is null then f.last_purchase_on end, f.company_id
       limit p_limit;
  end if;
end;
$$;
revoke all on function app.dormant_customer_rows(uuid, text, uuid, integer) from public, anon, authenticated, service_role;

-- the page's list: owners and admins only
create or replace function public.dormant_customers(p_org uuid, p_kind text, p_limit integer default 200)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_rows jsonb;
begin
  if p_kind is null or p_kind not in ('contact', 'company') then
    raise exception 'a contact or a company list' using errcode = '22023', hint = 'customer_status:kind';
  end if;
  if not app.is_admin(p_org) then
    return jsonb_build_object('allowed', false);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id,
           'name', case when p_kind = 'contact'
                        then (select coalesce(nullif(btrim(c.full_name), ''), c.email, c.phone) from public.contacts c
                               where c.organization_id = p_org and c.id = r.id)
                        else (select co.name from public.companies co where co.organization_id = p_org and co.id = r.id) end,
           'last_purchase_on', r.last_purchase_on,
           'value_agorot', r.value_agorot) order by r.n), '[]'::jsonb)
    into v_rows
    from (select x.*, row_number() over () as n from app.dormant_customer_rows(p_org, p_kind, null, v_limit + 1) x) r;
  return jsonb_build_object('allowed', true,
                            'rows', case when jsonb_array_length(v_rows) > v_limit then v_rows - v_limit else v_rows end,
                            'more', jsonb_array_length(v_rows) > v_limit);
end;
$$;
revoke all on function public.dormant_customers(uuid, text, integer) from public, anon;
grant execute on function public.dormant_customers(uuid, text, integer) to authenticated;

alter table public.automations drop constraint if exists automations_trigger_type_check;
alter table public.automations add constraint automations_trigger_type_check check (trigger_type = any (array[
  'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'no_activity', 'stuck_in_stage', 'birthday',
  'task_due_soon', 'date_reached', 'payment_received', 'payment_confirmed', 'quote_viewed', 'quote_accepted',
  'quote_declined', 'quote_expired', 'document_recorded', 'meeting_scheduled', 'meeting_cancelled', 'meeting_no_show',
  'debt_overdue', 'form_submitted', 'schedule', 'manual', 'customer_dormant']));

-- body of 20261006021000 with one more branch
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
    -- RET-01: the dormant scan (app.run_dormant_automations) never starts from an event
    when 'customer_dormant' then false
    when 'manual' then false
    else false
  end
$$;
revoke all on function app.automation_event_matches(public.automations, public.outbox_events, jsonb) from public, anon, authenticated;

-- AUT-06: body of 20261006021091 with one more branch
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

-- AUT-06: body of 20261006021091 with one more branch
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

-- one rule: the records that are dormant today and have not run it for this dormancy, from its scan cursor; at most p_budget runs
create or replace function app.scheduled_customer_dormant(p_auto public.automations, p_budget integer) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_local timestamp;
  v_after uuid;
  v_row record;
  v_key text;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_count integer := 0;
begin
  if p_auto.entity_type not in ('contact', 'company') or p_budget <= 0 then
    return 0;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_auto.organization_id;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_local := now() at time zone v_zone;
  if extract(hour from v_local) < app.date_trigger_hour() then
    return 0;
  end if;
  select c.after_id into v_after from app.scan_cursor_get(p_auto) c;
  <<pages>>
  loop
    v_page := 0;
    -- only the customers dormant today, from the kept facts, by id from the cursor
    for v_row in
      select r.id, r.last_purchase_on from app.dormant_customer_rows(p_auto.organization_id, p_auto.entity_type, v_after, v_page_size) r
    loop
      v_page := v_page + 1;
      v_after := v_row.id;
      -- once per customer and last purchase: a change of the thresholds never runs the rule again for the same quiet spell
      v_key := 'dormant:' || v_row.id || ':' || v_row.last_purchase_on;
      continue when exists (select 1 from public.automation_runs r where r.automation_id = p_auto.id and r.run_key = v_key);
      if app.execute_automation(p_auto, v_row.id, v_key) is not null then
        v_count := v_count + 1;
      end if;
      if v_count >= p_budget then
        perform app.scan_cursor_set(p_auto, '-infinity', v_after);
        exit pages;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: the next pass starts again from the first customer
      perform app.scan_cursor_set(p_auto, '-infinity', '00000000-0000-0000-0000-000000000000');
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, '-infinity', v_after);
      exit;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.scheduled_customer_dormant(public.automations, integer) from public, anon, authenticated, service_role;

-- every active dormant-customer rule of a writable business; at most 200 runs per business a pass
create or replace function app.run_dormant_automations() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_org uuid;
  v_budget integer := 0;
  v_runs integer;
  v_count integer := 0;
begin
  for v_auto in
    select a.* from public.automations a
     where a.is_active and a.trigger_type = 'customer_dormant'
       and app.org_writable(a.organization_id)
     order by a.organization_id, a.id
  loop
    if v_org is distinct from v_auto.organization_id then
      v_org := v_auto.organization_id;
      v_budget := 200;
    end if;
    continue when v_budget <= 0;
    begin
      v_runs := app.scheduled_customer_dormant(v_auto, v_budget);
      v_budget := v_budget - v_runs;
      v_count := v_count + v_runs;
    exception when others then
      raise warning 'dormant customer automation % failed: %', v_auto.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.run_dormant_automations() from public, anon, authenticated;
grant execute on function app.run_dormant_automations() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-dormant-automations', '*/15 * * * *', 'select app.run_dormant_automations();');
  end if;
end;
$$;

-- Every statement is safe to run twice. No drops but the constraint's own replacement, no row removal.

notify pgrst, 'reload schema';
