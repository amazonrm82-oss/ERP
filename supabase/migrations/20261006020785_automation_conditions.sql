-- =============================================================================
-- AUT-05: automation conditions with "or" groups, a linked record, working hours and the weekday
-- =============================================================================
-- Owner's answers of 18 October 2026 (DECISIONS.md "תנאים באוטומציה"): working hours are the record owner's hours, else
-- the business's (ב); a linked record is judged on its basic fields now, custom fields later (א). The lead's choices of
-- 25 October 2026 until the owner answers (DECISIONS.md, both (א)): a condition on a linked record that is missing or in
-- the recycle bin does not hold; an owner on leave that day is outside working hours (as app.member_in_hours).
-- * automations.conditions stays a JSON array whose items all must hold ("and"). An item is
--     a leaf, as before: {field, op, value?} on the rule's own record, optionally with
--       "on": "contact" | "company" | "deal" | "lead" = the record its <on>_id column points at (a contact's company; a
--       deal's contact or company; a task's lead, contact, company or deal);
--     an "or" group: {"any": [item, ...]} (2..10 items, no group inside a group), holds when one of them holds;
--     working hours: {"kind": "hours", "value": "in" | "out"};
--     the weekday: {"kind": "weekday", "days": [0..6]} (0 = Sunday), in the business's time zone.
--   Old rules are plain leaves without "on", so they are judged exactly as before (the leaf operators are unchanged).
-- * app.automation_condition_tree(conditions, records, ctx) is the pure rule (immutable, no reads), mirrored by
--   conditionTreeMatch() in src/features/automations/condition-match.ts; both run the cases of
--   tests/unit/fixtures/automation-conditions.json (a unit test and a database test read the same file). Keep them in step.
-- * app.automation_conditions_match(record, conditions) keeps its signature, so app.execute_automation (020735, the AUT-07
--   quota lock and count untouched) and app.retry_automation_run (020755) are not redefined. It is now stable and security
--   definer: it reads only the linked records the conditions name, each through app.automation_record with the record's
--   own organization_id (the composite foreign keys keep a link inside the business, and the read is scoped by it too),
--   and works out the working hours and the weekday only when a condition asks. Hours and weekday are judged at the time
--   of the call: when the run starts, and again at a retry (AUT-06), when the retry runs (now), not when the run started.
--   Hours: app.member_in_hours(org, owner, now) for a record with an owner (the person's hours, else the business's; a
--   rest day or holiday and a day of leave are outside; no hours anywhere = no limit); without an owner, the business's
--   hours by the same rule (app.automation_org_in_hours).
-- * The engine never raises over the shape of a stored item: anything it does not know does not hold. A person's write is
--   checked by trigger automations_conditions_check (invoker, only when the conditions change): hint automation:conditions.
--   At most 10 items, 20 leaves in all (a group's items count). A value is text, and a gte/lte value is a number
--   (^-?[0-9]+(\.[0-9]+)?$); the builder's schema has the same rule.
-- Every statement is safe to run twice. No drops, no row removal.

-- one leaf on one record (the operators of 0009, unchanged; a number comparison on a value that is not a number raises,
-- as before)
create or replace function app.automation_condition_leaf(p_record jsonb, p_cond jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_field text := p_cond ->> 'field';
  v_op text := p_cond ->> 'op';
  v_value text := p_cond ->> 'value';
  v_actual jsonb;
  v_text text;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object' or v_field is null or v_field !~ '^[a-z_]{1,40}$' then
    return false;
  end if;
  v_actual := p_record -> v_field;
  v_text := case when v_actual is null or jsonb_typeof(v_actual) = 'null' then null else v_actual #>> '{}' end;
  return coalesce(case v_op
    when 'eq' then v_text is not distinct from v_value
    when 'neq' then v_text is distinct from v_value
    when 'empty' then v_text is null or v_text = '' or v_text = '[]'
    when 'not_empty' then not (v_text is null or v_text = '' or v_text = '[]')
    when 'gte' then v_text ~ '^-?[0-9.]+$' and v_value ~ '^-?[0-9.]+$' and v_text::numeric >= v_value::numeric
    when 'lte' then v_text ~ '^-?[0-9.]+$' and v_value ~ '^-?[0-9.]+$' and v_text::numeric <= v_value::numeric
    when 'has_tag' then jsonb_typeof(v_actual) = 'array' and v_actual ? v_value
    else false
  end, false);
end;
$$;
revoke all on function app.automation_condition_leaf(jsonb, jsonb) from public, anon, authenticated, service_role;

-- one item: a leaf (on its record), an "or" group (only where p_group allows one), working hours or the weekday
create or replace function app.automation_condition_item(p_item jsonb, p_records jsonb, p_ctx jsonb, p_group boolean)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_sub jsonb;
  v_on text;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    return false;
  end if;
  if p_item ? 'any' then
    if not p_group or jsonb_typeof(p_item -> 'any') <> 'array' or jsonb_array_length(p_item -> 'any') not between 2 and 10 then
      return false;
    end if;
    for v_sub in select * from jsonb_array_elements(p_item -> 'any') loop
      if app.automation_condition_item(v_sub, p_records, p_ctx, false) then
        return true;
      end if;
    end loop;
    return false;
  end if;
  if p_item ? 'kind' then
    if p_item ->> 'kind' = 'hours' then
      return coalesce(jsonb_typeof(p_ctx -> 'in_hours') = 'boolean' and p_item ->> 'value' in ('in', 'out')
                      and (p_ctx -> 'in_hours')::boolean = (p_item ->> 'value' = 'in'), false);
    elsif p_item ->> 'kind' = 'weekday' then
      return coalesce(jsonb_typeof(p_item -> 'days') = 'array' and jsonb_typeof(p_ctx -> 'weekday') = 'number'
                      and (p_item -> 'days') @> jsonb_build_array(p_ctx -> 'weekday'), false);
    end if;
    return false;
  end if;
  v_on := coalesce(p_item ->> 'on', 'self');
  if v_on not in ('self', 'contact', 'company', 'deal', 'lead') then
    return false;
  end if;
  return app.automation_condition_leaf(p_records -> v_on, p_item);
end;
$$;
revoke all on function app.automation_condition_item(jsonb, jsonb, jsonb, boolean) from public, anon, authenticated, service_role;

-- the whole list: every item holds (no list or an empty one = no conditions)
create or replace function app.automation_condition_tree(p_conditions jsonb, p_records jsonb, p_ctx jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if p_conditions is null or jsonb_typeof(p_conditions) = 'null' then
    return true;
  end if;
  if jsonb_typeof(p_conditions) <> 'array' then
    return false;
  end if;
  for v_item in select * from jsonb_array_elements(p_conditions) loop
    if not app.automation_condition_item(v_item, p_records, p_ctx, true) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function app.automation_condition_tree(jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;

-- the business's working hours at a time (the business part of app.member_in_hours: no hours = no limit; a rest day or
-- holiday is outside); keep in step with it
create or replace function app.automation_org_in_hours(p_org uuid, p_at timestamptz) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_hours jsonb;
begin
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
  if v_zone is null then
    return false;
  end if;
  select c.working_hours into v_hours from public.org_calendar_settings c where c.organization_id = p_org;
  if v_hours is null then
    return true;
  end if;
  if app.org_rest_day(p_org, (p_at at time zone v_zone)::date) then
    return false;
  end if;
  return app.hours_cover(v_hours, p_at at time zone v_zone);
end;
$$;
revoke all on function app.automation_org_in_hours(uuid, timestamptz) from public, anon, authenticated, service_role;

-- the engine's check: reads what the conditions need and judges them by the pure rule
create or replace function app.automation_conditions_match(p_record jsonb, p_conditions jsonb) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_records jsonb;
  v_ctx jsonb := '{}'::jsonb;
  v_link text;
  v_id uuid;
  v_linked jsonb;
  v_zone text;
  v_owner uuid;
begin
  if p_conditions is null or jsonb_typeof(p_conditions) <> 'array' or jsonb_array_length(p_conditions) = 0 then
    return app.automation_condition_tree(p_conditions, jsonb_build_object('self', p_record), v_ctx);
  end if;
  v_records := jsonb_build_object('self', p_record);
  if p_record ->> 'organization_id' ~ '^[0-9a-f-]{36}$' then
    v_org := (p_record ->> 'organization_id')::uuid;
  end if;

  -- the linked records the conditions name (in groups too), read in the record's own business only
  for v_link in
    select distinct x ->> 'on'
      from (select e from jsonb_array_elements(p_conditions) e
            union all
            select g from jsonb_array_elements(p_conditions) e,
                          jsonb_array_elements(case when jsonb_typeof(e -> 'any') = 'array' then e -> 'any' else '[]'::jsonb end) g) t(x)
     where jsonb_typeof(x) = 'object' and x ->> 'on' in ('contact', 'company', 'deal', 'lead')
  loop
    v_id := null;
    if p_record ->> (v_link || '_id') ~ '^[0-9a-f-]{36}$' then
      v_id := (p_record ->> (v_link || '_id'))::uuid;
    end if;
    if v_org is not null and v_id is not null then
      v_linked := app.automation_record(v_link, v_org, v_id);
      -- a missing record or one in the recycle bin is no record: its conditions do not hold
      if v_linked is not null and (v_linked ->> 'deleted_at') is null
         and v_linked ->> 'organization_id' = v_org::text then
        v_records := v_records || jsonb_build_object(v_link, v_linked);
      end if;
    end if;
  end loop;

  -- working hours and the weekday, only when asked, at the time of the call
  if v_org is not null and (jsonb_path_exists(p_conditions, 'lax $[*].kind') or jsonb_path_exists(p_conditions, 'lax $[*].any[*].kind')) then
    select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
    if v_zone is not null then
      v_ctx := jsonb_build_object('weekday', extract(dow from now() at time zone v_zone)::integer);
    end if;
    if p_record ->> 'owner_id' ~ '^[0-9a-f-]{36}$' then
      v_owner := (p_record ->> 'owner_id')::uuid;
    end if;
    v_ctx := v_ctx || jsonb_build_object('in_hours', case when v_owner is not null then app.member_in_hours(v_org, v_owner, now())
                                                          else app.automation_org_in_hours(v_org, now()) end);
  end if;

  return app.automation_condition_tree(p_conditions, v_records, v_ctx);
end;
$$;
revoke all on function app.automation_conditions_match(jsonb, jsonb) from public, anon, authenticated, service_role;

-- the shape a person may save (the builder's shapes); the engine itself never raises over a shape
create or replace function app.automation_condition_item_ok(p_item jsonb, p_group boolean) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_sub jsonb;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    return false;
  end if;
  if p_item ? 'any' then
    if not p_group or jsonb_typeof(p_item -> 'any') <> 'array' or jsonb_array_length(p_item -> 'any') not between 2 and 10 then
      return false;
    end if;
    for v_sub in select * from jsonb_array_elements(p_item -> 'any') loop
      if not app.automation_condition_item_ok(v_sub, false) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if p_item ? 'kind' then
    return case p_item ->> 'kind'
      when 'hours' then p_item ->> 'value' in ('in', 'out')
      when 'weekday' then jsonb_typeof(p_item -> 'days') = 'array'
        and jsonb_array_length(p_item -> 'days') between 1 and 7
        and not exists (select 1 from jsonb_array_elements(p_item -> 'days') d
                         where jsonb_typeof(d) <> 'number' or d::text !~ '^[0-6]$')
        and (select count(distinct d) from jsonb_array_elements(p_item -> 'days') d) = jsonb_array_length(p_item -> 'days')
      else false
    end;
  end if;
  -- a value is text (the builder writes text; a JSON number would compare by PostgreSQL's own number text, which the TS
  -- mirror cannot see after JSON parsing); a number comparison needs a value that is a number
  return coalesce(p_item ->> 'field' ~ '^[a-z_]{1,40}$', false)
    and coalesce(p_item ->> 'op' in ('eq', 'neq', 'empty', 'not_empty', 'gte', 'lte', 'has_tag'), false)
    and (not p_item ? 'on' or p_item ->> 'on' in ('contact', 'company', 'deal', 'lead'))
    and (not p_item ? 'value' or jsonb_typeof(p_item -> 'value') in ('string', 'null'))
    and coalesce(length(p_item ->> 'value'), 0) <= 200
    and (p_item ->> 'op' not in ('gte', 'lte') or coalesce(p_item ->> 'value' ~ '^-?[0-9]+(\.[0-9]+)?$', false));
end;
$$;
revoke all on function app.automation_condition_item_ok(jsonb, boolean) from public, anon, authenticated, service_role;

create or replace function app.automation_conditions_ok(p_conditions jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select jsonb_typeof(p_conditions) = 'array'
     and jsonb_array_length(p_conditions) <= 10
     and not exists (select 1 from jsonb_array_elements(p_conditions) e where not app.automation_condition_item_ok(e, true))
     and (select coalesce(sum(case when jsonb_typeof(e -> 'any') = 'array' then jsonb_array_length(e -> 'any') else 1 end), 0)
            from jsonb_array_elements(p_conditions) e) <= 20
$$;
revoke all on function app.automation_conditions_ok(jsonb) from public, anon, authenticated, service_role;

-- a person's write (a browser session): the conditions must have a shape the engine knows
create or replace function app.automations_conditions_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and (tg_op = 'INSERT' or new.conditions is distinct from old.conditions)
     and not app.automation_conditions_ok(new.conditions) then
    raise exception 'the automation conditions are not valid'
      using errcode = '22023', hint = 'automation:conditions';
  end if;
  return new;
end;
$$;
revoke all on function app.automations_conditions_check() from public, anon;
grant execute on function app.automations_conditions_check() to authenticated;
grant execute on function app.automation_conditions_ok(jsonb) to authenticated;
grant execute on function app.automation_condition_item_ok(jsonb, boolean) to authenticated;

create or replace trigger automations_conditions_check before insert or update of conditions on public.automations
  for each row execute function app.automations_conditions_check();
