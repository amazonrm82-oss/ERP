-- =============================================================================
-- Conditional fields (FLD-09, wave 2)
-- =============================================================================
-- A custom field shows, or becomes required, depending on the value of another
-- field of the same record. One nullable column on public.field_definitions,
-- written like the other settings (members read; owners/admins of a writable
-- organization write; table grants, audited by field_definitions_audit):
--
--   condition = {"field": <controlling field>, "op": <op>, "value": <value>, "effect": "show" | "require"}
--
-- * field: the key of another custom field of the same organization and record
--   type, or a built-in field written "builtin:<name>": lead "builtin:status"
--   (lead_statuses id), lead "builtin:source" (lead_sources id), deal
--   "builtin:stage" (stages id), contact / company "builtin:type"
--   (record_type_options id of that object type). Mirrored by BUILTIN_CONDITION_FIELDS
--   in src/features/custom-fields/conditions.ts.
-- * op: equals | not_equals | in | filled | empty.
--   - equals / not_equals: one value. Controlling custom field of type select,
--     multi_select (= holds / does not hold that choice), checkbox (true/false) or rating.
--   - in: a list of 1 to 50 distinct values. select, multi_select (any of them), rating,
--     or a built-in field.
--   - filled / empty: no value (the key is removed). Any controlling type but checkbox
--     (false and "not ticked" are the same there; use equals).
--   Every value must fit the controlling field's type and options
--   (app.custom_value_ok, a choice of a multi_select as of a select); a built-in
--   value must be an id of that list in the same organization.
-- * effect: show (the field shows only while the condition holds) or require (the
--   field is required while it holds).
-- * At most one condition per field (one column). No chains: the controlling field
--   may not have a condition itself, and a field another field depends on may not get
--   one. Not itself. The controlling field must exist and be active when the
--   condition is written. Refusals: P0001, hint 'custom_field:condition'.
-- * Checked only when the condition is written (insert, a changed condition, or a changed
--   key or record type of the row, so a rename cannot make a chain or a cross-type pointer): a
--   controlling field that is later hidden, deleted or given other options is not
--   refused. The app then ignores the condition (the field always shows and is
--   required only by its own "required" box) and the settings page shows a reminder.
--   Two owners writing conditions at the same moment are serialized by an advisory
--   lock per organization and record type, so a chain cannot slip in between.
--
-- What the condition does is app-only, like "required" today:
-- * "show" is display only: a hidden field keeps its stored value; the forms leave
--   it out (an edit does not clear it, a create leaves its default to the database).
-- * "require" is checked by the record forms only. Never in the database: public
--   forms, imports, conversions, automations and server paths are never refused.
--   app.check_custom_fields() is unchanged.
--
-- A person who is not an owner or admin of the row's organization gets no condition
-- check at all (the policies refuse them right after, with nothing learned about
-- that organization's fields or lists). Security invoker: owners and admins read
-- the fields and lists of their organization. Safe to run twice; no drops, no deletes.

alter table public.field_definitions add column if not exists condition jsonb;

create or replace function app.field_condition_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_cond jsonb := new.condition;
  v_field text;
  v_op text;
  v_effect text;
  v_value jsonb;
  v_items jsonb;
  v_item jsonb;
  v_builtin text;
  v_id uuid;
  v_ok boolean;
  v_ctrl record;
begin
  if v_cond is not null and jsonb_typeof(v_cond) = 'null' then
    new.condition := null;
    v_cond := null;
  end if;
  -- unchanged condition, key and record type: nothing new to check (a renamed key or a moved field
  -- is checked again, both its own condition and the fields that depend on its new key)
  if tg_op = 'UPDATE' and new.condition is not distinct from old.condition
     and new.key = old.key and new.object_type = old.object_type then
    return new;
  end if;
  -- an outsider is answered by RLS (42501), learning nothing about this organization
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- conditions of one organization and record type are written one transaction at a time
  perform pg_advisory_xact_lock(hashtextextended('field_condition:' || new.organization_id::text || ':' || new.object_type, 0));

  if v_cond is null then
    return new;
  end if;

  -- the shape
  if jsonb_typeof(v_cond) <> 'object'
     or exists (select 1 from jsonb_object_keys(v_cond) k where k not in ('field', 'op', 'value', 'effect'))
     or jsonb_typeof(v_cond -> 'field') is distinct from 'string'
     or jsonb_typeof(v_cond -> 'op') is distinct from 'string'
     or jsonb_typeof(v_cond -> 'effect') is distinct from 'string' then
    raise exception 'invalid field condition' using errcode = 'P0001', hint = 'custom_field:condition';
  end if;
  v_field := v_cond ->> 'field';
  v_op := v_cond ->> 'op';
  v_effect := v_cond ->> 'effect';
  v_value := v_cond -> 'value';
  if v_effect not in ('show', 'require') or v_op not in ('equals', 'not_equals', 'in', 'filled', 'empty') then
    raise exception 'invalid field condition' using errcode = 'P0001', hint = 'custom_field:condition';
  end if;
  if v_op in ('filled', 'empty') then
    if v_value is not null and jsonb_typeof(v_value) <> 'null' then
      raise exception 'this condition takes no value' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    new.condition := v_cond - 'value';
    v_items := '[]'::jsonb;
  elsif v_op = 'in' then
    if v_value is null or jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) not between 1 and 50
       or (select count(distinct e.value) from jsonb_array_elements(v_value) e) <> jsonb_array_length(v_value) then
      raise exception 'invalid list of values' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    v_items := v_value;
  else
    if v_value is null or jsonb_typeof(v_value) in ('null', 'array', 'object') then
      raise exception 'invalid condition value' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    v_items := jsonb_build_array(v_value);
  end if;

  if v_field like 'builtin:%' then
    v_builtin := substr(v_field, 9);
    if (new.object_type, v_builtin) not in (('lead', 'status'), ('lead', 'source'), ('deal', 'stage'), ('contact', 'type'), ('company', 'type')) then
      raise exception 'unknown built-in field' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    for v_item in select e.value from jsonb_array_elements(v_items) e loop
      if jsonb_typeof(v_item) <> 'string'
         or (v_item #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        raise exception 'invalid condition value' using errcode = 'P0001', hint = 'custom_field:condition';
      end if;
      v_id := (v_item #>> '{}')::uuid;
      v_ok := case v_builtin
        when 'status' then exists (select 1 from public.lead_statuses s where s.organization_id = new.organization_id and s.id = v_id)
        when 'source' then exists (select 1 from public.lead_sources s where s.organization_id = new.organization_id and s.id = v_id)
        when 'stage' then exists (select 1 from public.stages s where s.organization_id = new.organization_id and s.id = v_id)
        else exists (select 1 from public.record_type_options t
                      where t.organization_id = new.organization_id and t.object_type = new.object_type and t.id = v_id)
      end;
      if not v_ok then
        raise exception 'condition value not found' using errcode = 'P0001', hint = 'custom_field:condition';
      end if;
    end loop;
  else
    if v_field = new.key then
      raise exception 'a field cannot depend on itself' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    select f.field_type, f.options, f.is_active, f.condition into v_ctrl
      from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = new.object_type and f.key = v_field;
    if not found or not v_ctrl.is_active then
      raise exception 'the controlling field does not exist' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    if v_ctrl.condition is not null then
      raise exception 'the controlling field has a condition itself' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    if (v_op in ('equals', 'not_equals') and v_ctrl.field_type not in ('select', 'multi_select', 'checkbox', 'rating'))
       or (v_op = 'in' and v_ctrl.field_type not in ('select', 'multi_select', 'rating'))
       or (v_op in ('filled', 'empty') and v_ctrl.field_type = 'checkbox') then
      raise exception 'this condition does not fit the controlling field' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    for v_item in select e.value from jsonb_array_elements(v_items) e loop
      if not app.custom_value_ok(case when v_ctrl.field_type = 'multi_select' then 'select' else v_ctrl.field_type end, v_ctrl.options, v_item) then
        raise exception 'the value does not fit the controlling field' using errcode = 'P0001', hint = 'custom_field:condition';
      end if;
    end loop;
  end if;

  -- no chains: another field depends on this one
  if exists (select 1 from public.field_definitions f
              where f.organization_id = new.organization_id and f.object_type = new.object_type
                and f.id <> new.id and f.condition ->> 'field' = new.key) then
    raise exception 'another field depends on this field' using errcode = 'P0001', hint = 'custom_field:condition';
  end if;
  return new;
end;
$$;
revoke all on function app.field_condition_check() from public, anon, authenticated;

create or replace trigger field_definitions_condition_check before insert or update on public.field_definitions
  for each row execute function app.field_condition_check();
