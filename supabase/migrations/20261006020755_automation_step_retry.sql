-- =============================================================================
-- AUT-06: a failed step is tried again, and the rule's creator hears of failures too
-- =============================================================================
-- Owner's answer, 18 October 2026 (DECISIONS.md "הרצה חוזרת של צעד שנכשל"): (ב) from the failed step, up to 3 attempts,
-- and only while the record still meets the rule's conditions. Notice: (א) to the owners and admins, once a day per
-- automation, and also to whoever made the automation when they are neither.
-- * The engine runs every step of a rule and records each one (app.run_automation_actions continues past a failed step),
--   so trying again "from the failed step" here means running the steps that failed, in their order; a step that already
--   worked is never run twice (a second task or notice). Up to 3 more attempts per run, 15 minutes, 1 hour and 6 hours
--   after the previous one (automation_runs.retry_count, next_retry_at, retry_note; server-written, readable with the run).
-- * A retry is part of the same run (AUT-07): it is not a new counted run and takes no quota lock. A manual test run
--   ('manual:' key) is not tried again.
-- * A retry happens only while the rule still exists, is on and is unchanged since the run (its actions are matched by
--   position), the record still exists outside the bin and still meets the rule's conditions; otherwise the retries end
--   with a note (rule_changed | rule_off | record_gone | conditions). The owner's answers of 21 October 2026 (DECISIONS.md):
--   the steps run again are the failed one and every later one that did not run (never one that worked); the event that
--   started the run must still hold (note event_changed); a read-only or closed business's retries are cancelled (note
--   org_closed), not left waiting. The owner's answer ב of 25 October 2026: that event check covers every trigger type,
--   from the facts the run saw (automation_runs.event_facts, below), and a trigger type without a check is never retried.
--   A retry that raises still counts as an attempt (the
--   job records it after the rollback), and after the third the retries end with the note 'error'. The changes it makes are marked as the automation's
--   (app.automation_running) and name the rule in the audit log (the app.automation_rule_runs slot, as app.execute_automation).
-- * pg_cron crm-automation-retries (every 5 minutes) runs app.retry_automation_runs(): due runs, oldest first, 500 a run,
--   one exception block per run (a read-only or closed business's run ends with org_closed). app.execute_automation is not
--   changed: the first retry time is set by trigger automation_runs_retry_plan when a run ends failed or partial.
-- * app.notify_automation_failed (the body of 0068) also tells the rule's creator (created_by) while they are an active
--   member who is neither owner nor admin (and not a viewer), with the same once-a-day limit per person and rule.
-- Safe to run twice. No drops, no row removal.

alter table public.automation_runs add column if not exists retry_count smallint not null default 0;
alter table public.automation_runs add column if not exists next_retry_at timestamptz;
alter table public.automation_runs add column if not exists retry_note text;
alter table public.automation_runs add column if not exists event_facts jsonb;
alter table public.automation_runs drop constraint if exists automation_runs_retry_shape;
alter table public.automation_runs add constraint automation_runs_retry_shape check (
  retry_count between 0 and 3
  and (retry_note is null or retry_note in ('rule_changed', 'rule_off', 'record_gone', 'conditions', 'error', 'event_changed', 'org_closed')));
create index if not exists automation_runs_retry_due_idx on public.automation_runs (next_retry_at) where next_retry_at is not null;

-- the wait before attempt n + 1 (n = retries already made): 15 minutes, 1 hour, 6 hours; null after 3
create or replace function app.automation_retry_delay(p_done integer) returns interval
language sql immutable
set search_path = ''
as $$
  select case p_done when 0 then interval '15 minutes' when 1 then interval '1 hour' when 2 then interval '6 hours' end
$$;
revoke all on function app.automation_retry_delay(integer) from public, anon, authenticated, service_role;

-- The owner, 25 October 2026 (answer ב): before a retry the event that started the run must still hold, for EVERY trigger
-- type; a type with no such check is never retried. What the run saw is kept in automation_runs.event_facts (server
-- written, readable with the run like its steps), set by trigger automation_runs_retry_plan when the run ends failed or
-- partial, from the run key the scan built from the values it read (values read before the run's steps), from the
-- outbox event (the payment) or from the record (a deal's stage, a birth date, the watched field's value, the last
-- activity, which then includes the timeline entries the run's own steps wrote):
--   created, deal_won, deal_lost, task_completed: {} (nothing to keep; the record itself is checked)
--   field_changed: {"value": the field's value}       no_activity: {"last_at": the last activity when the run ended}
--   stuck_in_stage: {"stage_id", "stage_entered_at"}  task_due_soon: {"due_at"}   birthday: {"birth_date"}
--   date_reached: {"day": the date the scan matched}   payment_received: {"payment_id"} (from the outbox event's payload)
-- Any other type (or facts that cannot be read) gives null, and a run without facts is not retried. Never raises: a run's
-- end must not fail over its retry plan.
create or replace function app.automation_run_facts(p_trigger text, p_config jsonb, p_entity text, p_org uuid, p_id uuid,
                                                    p_run_key text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_record jsonb;
  v_text text;
  v_payment text;
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
    when 'payment_received' then
      v_text := substring(p_run_key from '^event:([0-9]{1,18})$');
      if v_text is null then
        return null;
      end if;
      select e.payload ->> 'payment_id' into v_payment from public.outbox_events e
       where e.organization_id = p_org and e.id = v_text::bigint and e.event_type = 'payment_received';
      return case when v_payment is not null then jsonb_build_object('payment_id', v_payment::uuid) end;
    else
      -- a trigger type without a decision: never retried
      return null;
  end case;
exception when others then
  return null;
end;
$$;
revoke all on function app.automation_run_facts(text, jsonb, text, uuid, uuid, text) from public, anon, authenticated, service_role;

-- a run that ends failed or partial (not a manual test run) waits for its first retry, when what it saw can be kept
create or replace function app.automation_runs_retry_plan() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_trigger text;
  v_config jsonb;
begin
  if new.status in ('failed', 'partial') and new.retry_count = 0 and new.next_retry_at is null and new.retry_note is null
     and new.run_key not like 'manual:%' and old.status is distinct from new.status then
    select a.trigger_type, a.trigger_config into v_trigger, v_config from public.automations a
     where a.organization_id = new.organization_id and a.id = new.automation_id;
    new.event_facts := app.automation_run_facts(v_trigger, v_config, new.entity_type, new.organization_id, new.entity_id, new.run_key);
    if new.event_facts is not null then
      new.next_retry_at := now() + app.automation_retry_delay(0);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.automation_runs_retry_plan() from public, anon, authenticated, service_role;

create or replace trigger automation_runs_retry_plan before update of status on public.automation_runs
  for each row execute function app.automation_runs_retry_plan();

-- Whether the event still holds for a retry (owner's answers of 21 and 25 October 2026). The record is already known to
-- exist outside the bin and to meet the conditions. One branch per trigger type; any other type is false (no retry).
--   created: true. The event is the record's creation, which cannot be undone; the record still existing is the check.
--   deal_won / deal_lost / task_completed: the deal is still won / lost, the task still done.
--   field_changed: with a target value, the field still has it; without one, the field still has the value the run saw
--     (stage and status rules are field_changed rules).
--   no_activity: the record still has no activity after the last one when the run ended (the rule of app.scheduled_no_activity: the
--     newest activity that is not an 'automation_note', else the record's creation; keep the two in step), and it is
--     still in the scan (a lead not converted, a deal still open).
--   stuck_in_stage: the deal is still open, in the same stage, entered at the same time (it did not leave and come back).
--   task_due_soon: the task is still open and its due time did not change.
--   birthday: the contact's birth date did not change. Retries end within about 7.5 hours, so a greeting that is a few
--     hours late still belongs to the same birthday; a changed or cleared birth date means the occasion is gone.
--   date_reached: the record's date (built-in, or an active cf: date/datetime field) is still the day the scan matched,
--     counted in the business's zone as app.scheduled_date_reached does (keep in step), and the record is still in the
--     scan (a lead not converted; a deal's expected close date and a task's due date only while open).
--   payment_received: the payment still exists and was not cancelled, failed or refunded.
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
    else
      -- a trigger type without a decision is never retried
      return false;
  end case;
end;
$$;
revoke all on function app.automation_event_still_holds(text, jsonb, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

-- one retry of one run: the failed steps again, if the rule and the record still allow it
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

-- the job: due retries, oldest first; one exception block per run (a failure leaves the run for the next pass)
create or replace function app.retry_automation_runs(p_limit integer default 500) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select r.id from public.automation_runs r
     where r.next_retry_at is not null and r.next_retry_at <= now()
     order by r.next_retry_at, r.id
     limit p_limit
  loop
    begin
      if app.retry_automation_run(v_id) is not null then
        v_count := v_count + 1;
      end if;
    exception when others then
      raise warning 'automation retry % failed: %', v_id, sqlerrm;
      -- review low 1: the attempt still counts (its changes were rolled back), so a run that keeps raising ends within
      -- 3 attempts, with the note 'error', instead of being picked again every 5 minutes
      begin
        update public.automation_runs r
           set retry_count = least(r.retry_count + 1, 3),
               next_retry_at = case when r.retry_count + 1 >= 3 then null else now() + app.automation_retry_delay(r.retry_count + 1) end,
               retry_note = case when r.retry_count + 1 >= 3 then 'error' end
         where r.id = v_id and r.next_retry_at is not null;
      exception when others then
        raise warning 'automation retry % could not be recorded: %', v_id, sqlerrm;
      end;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.retry_automation_runs(integer) from public, anon, authenticated;
grant execute on function app.retry_automation_runs(integer) to service_role;

-- the notice of a failed run, now also to the rule's creator (the body of 0068 plus that recipient)
create or replace function app.notify_automation_failed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_name text;
  v_creator uuid;
begin
  select a.name, a.created_by into v_name, v_creator from public.automations a
   where a.organization_id = new.organization_id and a.id = new.automation_id;
  if v_name is null then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select new.organization_id, m.user_id, 'automation_failed',
         left(case when new.status = 'failed' then 'אוטומציה נכשלה: ' else 'אוטומציה נכשלה בחלקה: ' end || v_name, 200),
         'אפשר לראות מה לא עבד ביומן ההרצות של האוטומציה.',
         'automation', new.automation_id
    from public.memberships m
   where m.organization_id = new.organization_id and m.status = 'active'
     -- AUT-06: owners and admins, and the rule's creator when they are neither (and not a viewer)
     and (m.role in ('owner', 'admin') or (m.user_id = v_creator and m.role in ('manager', 'member')))
     -- at most once a day per rule and person, read or not (a broken rule fails on every event)
     and not exists (select 1 from public.notifications n
                      where n.user_id = m.user_id and n.organization_id = new.organization_id
                        and n.type = 'automation_failed' and n.entity_id = new.automation_id
                        and n.created_at > now() - interval '1 day');
  return null;
end;
$$;
revoke all on function app.notify_automation_failed() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-automation-retries', '*/5 * * * *', 'select app.retry_automation_runs(500)');
  end if;
end;
$$;
