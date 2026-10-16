-- =============================================================================
-- Automations: "X days before or after a date" triggers (AUT-03, first part)
-- =============================================================================
-- A new trigger type 'date_reached' on every record type. trigger_config:
--   {"field": <date field>, "days": 0..365, "direction": "before" | "after"}   (days 0 = on the day itself)
-- * The date fields (app.automation_date_fields, mirrored by DATE_TRIGGER_FIELDS in src/features/automations/date-trigger.ts):
--     every type: created_at; deals: expected_close_date, renewal_date, recurring_start_date; tasks: due_at;
--     leads, contacts, companies and deals also their active custom fields of type date or datetime ("cf:<key>").
--   A time (created_at, due_at, a datetime field) counts by its day in the business's time zone.
-- * The rule runs once per record and date: on the day the date plus (after) or minus (before) the days is today, in
--   the business's time zone, from 08:00 there (app.date_trigger_hour(); tests lower it with the setting
--   app.date_trigger_hour). A date that moves makes a new occasion; the same date never runs twice (run key).
-- * A day the job did not run at all after the trigger hour (the database was down from 08:00 to midnight) is not caught
--   up the next day: accepted, so a new or changed rule never runs a day late for yesterday's dates.
-- * Records in the recycle bin never run; a converted lead never runs (as "no activity"); an expected close date or a
--   task's due date runs only while the deal or the task is open.
-- * pg_cron 'crm-date-automations' (every 15 minutes) calls app.run_date_automations(): active rules of writable
--   businesses, each in its own exception block, each continuing from its scan cursor (as "no activity") and taking at
--   most app.scheduled_scan_limit() records a run. app.run_scheduled_automations is not changed.
-- Not here (AUT-03 follow-ups): "any field changed", "form submitted", a fixed schedule, an incoming webhook and the
-- manual button; the relative date for set_field (AUT-01 question) waits for the owner.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.automations drop constraint if exists automations_trigger_type_check;
alter table public.automations add constraint automations_trigger_type_check check (trigger_type = any (array[
  'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'no_activity', 'stuck_in_stage', 'birthday',
  'task_due_soon', 'date_reached']));

-- The built-in date fields a 'date_reached' rule may watch, per record type (custom fields come on top)
create or replace function app.automation_date_fields(p_entity text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_entity
    when 'lead' then array['created_at']
    when 'contact' then array['created_at']
    when 'company' then array['created_at']
    when 'deal' then array['created_at', 'expected_close_date', 'renewal_date', 'recurring_start_date']
    when 'task' then array['created_at', 'due_at']
    else array[]::text[]
  end
$$;
revoke all on function app.automation_date_fields(text) from public, anon, authenticated;

-- The local hour from which date rules run (default 8; the setting app.date_trigger_hour, 0..23, is for tests)
create or replace function app.date_trigger_hour() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,2}$' and s::int between 0 and 23 then s::int else 8 end
    from coalesce(current_setting('app.date_trigger_hour', true), '') as s;
$$;
revoke all on function app.date_trigger_hour() from public, anon, authenticated;

-- A custom field's stored value as a day in the zone: 'YYYY-MM-DD' for a date field, any timestamp text for a datetime
-- field; anything that does not read as one is no day (never an error that would stop the scan)
create or replace function app.automation_value_day(p_value text, p_type text, p_zone text) returns date
language plpgsql stable
set search_path = ''
as $$
begin
  if p_value is null or char_length(p_value) > 40 then
    return null;
  end if;
  if p_type = 'date' then
    if p_value !~ '^\d{4}-\d{2}-\d{2}$' then
      return null;
    end if;
    return p_value::date;
  end if;
  return (p_value::timestamptz at time zone p_zone)::date;
exception when others then
  return null;
end;
$$;
revoke all on function app.automation_value_day(text, text, text) from public, anon, authenticated;

-- One 'date_reached' rule: the records whose date reaches today, once each
create or replace function app.scheduled_date_reached(p_auto public.automations) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entity text := p_auto.entity_type;
  v_table text := app.automation_table(p_auto.entity_type);
  v_field text := p_auto.trigger_config ->> 'field';
  v_direction text := p_auto.trigger_config ->> 'direction';
  v_days integer;
  v_zone text;
  v_local timestamp;
  v_today date;
  v_source date;
  v_day text;
  v_extra text := '';
  v_key text;
  v_type text;
  v_prefix text;
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_after_id uuid;
begin
  if v_table is null or v_field is null or v_direction not in ('before', 'after')
     or jsonb_typeof(p_auto.trigger_config -> 'days') is distinct from 'number'
     or (p_auto.trigger_config ->> 'days') !~ '^[0-9]{1,3}$' then
    return 0;
  end if;
  v_days := (p_auto.trigger_config ->> 'days')::int;
  if v_days > 365 then
    return 0;
  end if;

  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_auto.organization_id;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_local := now() at time zone v_zone;
  if extract(hour from v_local) < app.date_trigger_hour() then
    return 0;
  end if;
  v_today := v_local::date;
  -- the day the field must hold for the rule to run today
  v_source := case when v_direction = 'after' then v_today - v_days else v_today + v_days end;

  -- the day of the field, as an SQL expression over the row t
  if v_field like 'cf:%' then
    if v_entity not in ('lead', 'contact', 'company', 'deal') then
      return 0;
    end if;
    v_key := substr(v_field, 4);
    select f.field_type into v_type from public.field_definitions f
     where f.organization_id = p_auto.organization_id and f.object_type = v_entity and f.key = v_key and f.is_active
       and f.field_type in ('date', 'datetime');
    if v_type is null then
      return 0;
    end if;
    v_day := format('app.automation_value_day(t.custom_fields ->> %L, %L, %L)', v_key, v_type, v_zone);
  elsif v_field = any (app.automation_date_fields(v_entity)) then
    if v_field in ('created_at', 'due_at') then
      v_day := format('(t.%I at time zone %L)::date', v_field, v_zone);
    else
      v_day := format('t.%I', v_field);
    end if;
  else
    return 0;
  end if;

  if v_entity = 'lead' then
    v_extra := ' and t.converted_at is null';
  elsif v_entity = 'deal' and v_field = 'expected_close_date' then
    v_extra := ' and t.status = ''open''';
  elsif v_entity = 'task' and v_field = 'due_at' then
    v_extra := ' and t.status = ''open''';
  end if;

  -- one occasion per rule setting, record and date
  v_prefix := 'date:' || v_field || ':' || v_direction || ':' || v_days || ':';
  select c.after_id into v_after_id from app.scan_cursor_get(p_auto) c;
  loop
    v_page := 0;
    for v_row in execute format(
      'select t.id from public.%I t
        where t.organization_id = $1 and t.deleted_at is null %s
          and %s = $2
          and t.id > $3
          and not exists (select 1 from public.automation_runs r
                           where r.automation_id = $4 and r.run_key = $5 || t.id || '':'' || $2)
        order by t.id
        limit $6', v_table, v_extra, v_day)
      using p_auto.organization_id, v_source, v_after_id, p_auto.id, v_prefix, v_page_size
    loop
      v_page := v_page + 1;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, v_prefix || v_row.id || ':' || v_source) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: the next run starts again from the first record
      perform app.scan_cursor_set(p_auto, '-infinity', '00000000-0000-0000-0000-000000000000');
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, '-infinity', v_after_id);
      exit;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.scheduled_date_reached(public.automations) from public, anon, authenticated;

-- Every active 'date_reached' rule of a writable business; a failing rule does not stop the others
create or replace function app.run_date_automations() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_count integer := 0;
begin
  for v_auto in
    select a.* from public.automations a
     where a.is_active and a.trigger_type = 'date_reached'
       and app.org_writable(a.organization_id)
     order by a.organization_id, a.id
  loop
    begin
      v_count := v_count + app.scheduled_date_reached(v_auto);
    exception when others then
      raise warning 'date automation % failed: %', v_auto.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.run_date_automations() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-date-automations', '*/15 * * * *', 'select app.run_date_automations();');
  end if;
end;
$$;
