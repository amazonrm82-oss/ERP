-- =============================================================================
-- AUT-04 follow-up: the trigger "חוב עבר את מועדו" (debt_overdue)
-- =============================================================================
-- * A scheduled trigger for deal and contact rules, like date_reached: an active tax invoice or proforma whose due date
--   (PAY-02, accounting_documents.due_date) plus trigger_config.days_overdue (0..365, default 0; another value counts as 0)
--   is before the business's today, and whose balance is above zero (app.document_balance = the balance of
--   public.money_allocation_state, the same rule), runs the rule on the document's deal (deal rules) or contact (contact
--   rules). Once per document and due date (run key debt:<document>:<due date>:<days>): a moved due date makes a new occasion.
--   From 08:00 in the business's zone (app.date_trigger_hour()), like the date triggers.
-- * Needs both plan flags documents and payments (balances need allocations): app.automation_trigger_flags(type) lists a
--   trigger's flags (debt_overdue = both; the others as app.automation_trigger_feature), app.automation_trigger_flags_ok
--   checks them. The builder (triggerFlags in definitions.ts) offers and saves the trigger only with both;
--   app.run_debt_automations runs only rules whose business has both; app.retry_automation_run (body of 020800) now asks
--   app.automation_trigger_flags_ok, so a retry ends with feature_off when any flag is gone.
-- * pg_cron crm-debt-automations (every 15 minutes) runs app.run_debt_automations(): active debt rules of writable
--   businesses, each in its own exception block, at most 200 runs per business a pass (the next pass goes on from each
--   rule's scan cursor), each rule taking at most app.scheduled_scan_limit() documents a pass.
-- * AUT-06: facts {document_id, due_date} from the run key; a retry runs only while the document is still active, its due
--   date unchanged and its balance above zero. app.automation_run_facts and app.automation_event_still_holds (bodies of
--   020800) learn the branch.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.automations drop constraint if exists automations_trigger_type_check;
alter table public.automations add constraint automations_trigger_type_check check (trigger_type = any (array[
  'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'no_activity', 'stuck_in_stage', 'birthday',
  'task_due_soon', 'date_reached', 'payment_received', 'payment_confirmed', 'quote_viewed', 'quote_accepted',
  'quote_declined', 'quote_expired', 'document_recorded', 'meeting_scheduled', 'meeting_cancelled', 'meeting_no_show',
  'debt_overdue']));

-- every plan flag a trigger type needs (empty = core)
create or replace function app.automation_trigger_flags(p_trigger text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case
    when p_trigger = 'debt_overdue' then array['documents', 'payments']
    when app.automation_trigger_feature(p_trigger) is not null then array[app.automation_trigger_feature(p_trigger)]
    else array[]::text[]
  end
$$;
revoke all on function app.automation_trigger_flags(text) from public, anon, authenticated, service_role;

create or replace function app.automation_trigger_flags_ok(p_org uuid, p_trigger text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not exists (select 1 from unnest(app.automation_trigger_flags(p_trigger)) f where not app.org_has_feature(p_org, f))
$$;
revoke all on function app.automation_trigger_flags_ok(uuid, text) from public, anon, authenticated, service_role;

-- a document's balance: the rule of public.money_allocation_state (read here as the owner, so every allocation counts)
create or replace function app.document_balance(p_org uuid, p_document uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce((public.money_allocation_state(p_org, array[p_document], '{}'::uuid[]) -> 'documents' -> 0 ->> 'balance')::bigint, 0)
$$;
revoke all on function app.document_balance(uuid, uuid) from public, anon, authenticated, service_role;

-- one rule: its overdue documents with a balance, from its scan cursor; at most p_budget runs
create or replace function app.scheduled_debt_overdue(p_auto public.automations, p_budget integer) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_days integer := 0;
  v_zone text;
  v_local timestamp;
  v_today date;
  v_after uuid;
  v_row record;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_count integer := 0;
  v_key text;
begin
  if p_auto.entity_type not in ('deal', 'contact') or p_budget <= 0 then
    return 0;
  end if;
  if jsonb_typeof(p_auto.trigger_config -> 'days_overdue') = 'number'
     and (p_auto.trigger_config ->> 'days_overdue') ~ '^[0-9]{1,3}$'
     and (p_auto.trigger_config ->> 'days_overdue')::integer <= 365 then
    v_days := (p_auto.trigger_config ->> 'days_overdue')::integer;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_auto.organization_id;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_local := now() at time zone v_zone;
  if extract(hour from v_local) < app.date_trigger_hour() then
    return 0;
  end if;
  v_today := v_local::date;
  select c.after_id into v_after from app.scan_cursor_get(p_auto) c;
  <<pages>>
  loop
    v_page := 0;
    for v_row in
      select d.id, d.due_date, case when p_auto.entity_type = 'deal' then d.deal_id else d.contact_id end as record_id
        from public.accounting_documents d
       where d.organization_id = p_auto.organization_id and d.status = 'active' and d.doc_type in ('tax_invoice', 'proforma')
         and d.due_date is not null and d.due_date + v_days < v_today
         and (case when p_auto.entity_type = 'deal' then d.deal_id else d.contact_id end) is not null
         and d.id > v_after
         and not exists (select 1 from public.automation_runs r
                          where r.automation_id = p_auto.id and r.run_key = 'debt:' || d.id || ':' || d.due_date || ':' || v_days)
       order by d.id
       limit v_page_size
    loop
      v_page := v_page + 1;
      v_after := v_row.id;
      if app.document_balance(p_auto.organization_id, v_row.id) > 0 then
        v_key := 'debt:' || v_row.id || ':' || v_row.due_date || ':' || v_days;
        if app.execute_automation(p_auto, v_row.record_id, v_key) is not null then
          v_count := v_count + 1;
        end if;
        if v_count >= p_budget then
          perform app.scan_cursor_set(p_auto, '-infinity', v_after);
          exit pages;
        end if;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: the next pass starts again from the first document
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
revoke all on function app.scheduled_debt_overdue(public.automations, integer) from public, anon, authenticated, service_role;

-- every active debt rule of a writable business that has both flags; at most 200 runs per business a pass
create or replace function app.run_debt_automations() returns integer
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
     where a.is_active and a.trigger_type = 'debt_overdue'
       and app.org_writable(a.organization_id)
       and app.automation_trigger_flags_ok(a.organization_id, 'debt_overdue')
     order by a.organization_id, a.id
  loop
    if v_org is distinct from v_auto.organization_id then
      v_org := v_auto.organization_id;
      v_budget := 200;
    end if;
    continue when v_budget <= 0;
    begin
      v_runs := app.scheduled_debt_overdue(v_auto, v_budget);
      v_budget := v_budget - v_runs;
      v_count := v_count + v_runs;
    exception when others then
      raise warning 'debt automation % failed: %', v_auto.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.run_debt_automations() from public, anon, authenticated;
grant execute on function app.run_debt_automations() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-debt-automations', '*/15 * * * *', 'select app.run_debt_automations();');
  end if;
end;
$$;

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
    when 'debt_overdue' then
      -- AUT-04 follow-up: the document and the due date the scan saw, from the run key
      v_text := substring(p_run_key from '^debt:([0-9a-f-]{36}):[0-9]{4}-[0-9]{2}-[0-9]{2}:');
      if v_text is null then
        return null;
      end if;
      return jsonb_build_object('document_id', v_text::uuid,
                                'due_date', substring(p_run_key from '^debt:[0-9a-f-]{36}:([0-9]{4}-[0-9]{2}-[0-9]{2}):')::date);
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
    else
      -- a trigger type without a decision is never retried
      return false;
  end case;
end;
$$;
revoke all on function app.automation_event_still_holds(text, jsonb, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

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
  if v_auto.id is not null and not app.automation_trigger_flags_ok(v_run.organization_id, v_auto.trigger_type) then
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
