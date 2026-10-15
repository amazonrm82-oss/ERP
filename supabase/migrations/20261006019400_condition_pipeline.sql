-- =============================================================================
-- Conditional fields: the pipeline as a controlling field (FLD-09 follow-up)
-- =============================================================================
-- Owner, 15 October 2026: "pipeline" joins "stage" as a built-in field that can make a
-- deal field show or be required. A condition on a pipeline holds in every stage of it,
-- stages added later included (the app reads deals.pipeline_id). When one field has both
-- a pipeline condition and a stage condition, it is enough that one of them holds.
-- Deleting a pipeline removes the conditions based on it (the app warns in the delete window).
--
-- The shape of field_definitions.condition stays as in migration conditional_fields, with:
-- * a new built-in field for deals, "builtin:pipeline" (pipelines id of the same organization,
--   not deleted when the condition is written). Mirrored by BUILTIN_CONDITION_FIELDS in
--   src/features/custom-fields/conditions.ts.
-- * one optional key "or" = {"field", "op", "value"} (no effect of its own; the condition's
--   effect applies), allowed only on a deal field whose condition is on "builtin:stage" or
--   "builtin:pipeline" and whose "or" is on the other one. The field's state is then
--   "main holds OR the 'or' part holds". Each part is checked like a condition by itself.
--   Old rows (no "or") are unchanged and stay valid.
--
-- Deleting a pipeline (pipelines.deleted_at set, the app's way; or a hard delete of a live
-- pipeline, trigger pipelines_condition_cleanup_delete) runs
-- app.pipeline_conditions_cleanup() (trigger pipelines_condition_cleanup), which, for every
-- deal field of the organization, takes out of each condition part the deleted pipeline's id
-- (a "builtin:pipeline" part) and the ids of its stages (a "builtin:stage" part): a list
-- ("in") keeps its other values; a part with one value on it (equals / not_equals) or a list
-- left empty is removed; filled / empty parts stay. When one part is left it becomes the
-- condition (with the field's effect); when none is left the condition is cleared. Pure rule
-- app.condition_without_pipeline(), mirrored by conditionWithoutPipeline() (test 108 compares
-- them). Clearing a jsonb key is an UPDATE of the row (audited by field_definitions_audit).
-- The cleanup writes what is left without checking it again (a value removed from a list
-- earlier must not stop a pipeline from being deleted): app.field_condition_check() skips
-- rows while the transaction-local setting app.condition_cleanup is 'on', which only the
-- cleanup function sets and resets, and only when current_user is not 'authenticated' (inside the
-- definer cleanup it is the owner), so a person who sets the value by hand is still checked.
-- Restoring a deleted pipeline (deleted_at cleared) does not bring its conditions back: they are
-- gone, and the fields are set again by hand if needed.
-- A stage value must be a stage of a live pipeline (a deleted pipeline's stages are refused).
--
-- Safe to run twice; no drops, no deletes.

create or replace function app.field_condition_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_cond jsonb := new.condition;
  v_effect text;
  v_or jsonb;
  v_parts jsonb;
  v_part jsonb;
  v_out jsonb := '[]'::jsonb;
  v_field text;
  v_op text;
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
  -- the pipeline cleanup writes what is left of a condition without checking it again
  if current_setting('app.condition_cleanup', true) = 'on' and current_user <> 'authenticated' then
    return new;
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
     or exists (select 1 from jsonb_object_keys(v_cond) k where k not in ('field', 'op', 'value', 'effect', 'or'))
     or jsonb_typeof(v_cond -> 'field') is distinct from 'string'
     or jsonb_typeof(v_cond -> 'op') is distinct from 'string'
     or jsonb_typeof(v_cond -> 'effect') is distinct from 'string' then
    raise exception 'invalid field condition' using errcode = 'P0001', hint = 'custom_field:condition';
  end if;
  v_effect := v_cond ->> 'effect';
  if v_effect not in ('show', 'require') then
    raise exception 'invalid field condition' using errcode = 'P0001', hint = 'custom_field:condition';
  end if;
  v_or := v_cond -> 'or';
  if v_or is not null and jsonb_typeof(v_or) = 'null' then
    v_or := null;
  end if;
  v_parts := jsonb_build_array(v_cond - 'effect' - 'or');
  if v_or is not null then
    -- the second part: only a deal's pipeline beside its stage (either order), field / op / value only
    if jsonb_typeof(v_or) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_or) k where k not in ('field', 'op', 'value'))
       or jsonb_typeof(v_or -> 'field') is distinct from 'string'
       or jsonb_typeof(v_or -> 'op') is distinct from 'string'
       or new.object_type <> 'deal'
       or not ((v_cond ->> 'field' = 'builtin:stage' and v_or ->> 'field' = 'builtin:pipeline')
            or (v_cond ->> 'field' = 'builtin:pipeline' and v_or ->> 'field' = 'builtin:stage')) then
      raise exception 'invalid second condition' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    v_parts := v_parts || jsonb_build_array(v_or);
  end if;

  for v_part in select e.value from jsonb_array_elements(v_parts) e loop
    v_field := v_part ->> 'field';
    v_op := v_part ->> 'op';
    v_value := v_part -> 'value';
    if v_op not in ('equals', 'not_equals', 'in', 'filled', 'empty') then
      raise exception 'invalid field condition' using errcode = 'P0001', hint = 'custom_field:condition';
    end if;
    if v_op in ('filled', 'empty') then
      if v_value is not null and jsonb_typeof(v_value) <> 'null' then
        raise exception 'this condition takes no value' using errcode = 'P0001', hint = 'custom_field:condition';
      end if;
      v_part := v_part - 'value';
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
      if (new.object_type, v_builtin) not in (('lead', 'status'), ('lead', 'source'), ('deal', 'stage'), ('deal', 'pipeline'), ('contact', 'type'), ('company', 'type')) then
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
          when 'stage' then exists (select 1 from public.stages s
                                     join public.pipelines p on p.organization_id = s.organization_id and p.id = s.pipeline_id
                                    where s.organization_id = new.organization_id and s.id = v_id and p.deleted_at is null)
          when 'pipeline' then exists (select 1 from public.pipelines p
                                        where p.organization_id = new.organization_id and p.id = v_id and p.deleted_at is null)
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
    v_out := v_out || jsonb_build_array(v_part);
  end loop;

  -- the stored shape: the main part with the effect, then "or" when there is one
  new.condition := (v_out -> 0) || jsonb_build_object('effect', v_effect)
    || case when jsonb_array_length(v_out) > 1 then jsonb_build_object('or', v_out -> 1) else '{}'::jsonb end;

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

-- One condition part without the given ids: null when nothing is left of it. Pure.
create or replace function app.condition_part_without(p_part jsonb, p_ids text[]) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case
    when p_part is null or jsonb_typeof(p_part) <> 'object' then p_part
    when p_part ->> 'op' = 'in' and jsonb_typeof(p_part -> 'value') = 'array' then
      (select case when count(*) = 0 then null
                   else jsonb_set(p_part, '{value}', jsonb_agg(e.value order by e.ord)) end
         from jsonb_array_elements(p_part -> 'value') with ordinality e(value, ord)
        where not (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') = any (p_ids)))
    when p_part ->> 'op' in ('equals', 'not_equals') and jsonb_typeof(p_part -> 'value') = 'string'
         and (p_part ->> 'value') = any (p_ids) then null
    else p_part
  end;
$$;
revoke all on function app.condition_part_without(jsonb, text[]) from public, anon, authenticated;

-- A deal field's condition without the parts based on a deleted pipeline and its stages
-- (mirrored by conditionWithoutPipeline() in src/features/custom-fields/conditions.ts). Pure.
create or replace function app.condition_without_pipeline(p_condition jsonb, p_pipeline text, p_stages text[]) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_main jsonb;
  v_or jsonb;
  v_effect jsonb;
begin
  if p_condition is null or jsonb_typeof(p_condition) <> 'object' then
    return p_condition;
  end if;
  v_effect := p_condition -> 'effect';
  v_main := p_condition - 'effect' - 'or';
  v_or := p_condition -> 'or';
  if v_or is not null and jsonb_typeof(v_or) = 'null' then
    v_or := null;
  end if;
  v_main := case v_main ->> 'field'
    when 'builtin:pipeline' then app.condition_part_without(v_main, array[p_pipeline])
    when 'builtin:stage' then app.condition_part_without(v_main, coalesce(p_stages, '{}'))
    else v_main end;
  if v_or is not null then
    v_or := case v_or ->> 'field'
      when 'builtin:pipeline' then app.condition_part_without(v_or, array[p_pipeline])
      when 'builtin:stage' then app.condition_part_without(v_or, coalesce(p_stages, '{}'))
      else v_or end;
  end if;
  if v_main is null and v_or is null then
    return null;
  end if;
  if v_main is null then
    return v_or || jsonb_build_object('effect', v_effect);
  end if;
  return v_main || jsonb_build_object('effect', v_effect)
    || case when v_or is null then '{}'::jsonb else jsonb_build_object('or', v_or) end;
end;
$$;
revoke all on function app.condition_without_pipeline(jsonb, text, text[]) from public, anon, authenticated;

-- Deleting a pipeline (deleted_at set) removes the conditions based on it from the organization's
-- deal fields. Security definer: the person who deletes a pipeline may write it, and every
-- condition based on it goes, whoever wrote it.
create or replace function app.pipeline_conditions_cleanup() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_pipeline uuid;
  v_stages text[];
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_pipeline := old.id;
    -- a pipeline deleted before was cleaned then; an organization being deleted takes its fields with it
    if old.deleted_at is not null or not exists (select 1 from public.organizations o where o.id = v_org) then
      return old;
    end if;
  else
    v_org := new.organization_id;
    v_pipeline := new.id;
  end if;
  -- serialized with condition writes of the organization's deal fields (field_condition_check)
  perform pg_advisory_xact_lock(hashtextextended('field_condition:' || v_org::text || ':deal', 0));
  select coalesce(array_agg(s.id::text), '{}') into v_stages
    from public.stages s
   where s.organization_id = v_org and s.pipeline_id = v_pipeline;
  perform set_config('app.condition_cleanup', 'on', true);
  update public.field_definitions f
     set condition = app.condition_without_pipeline(f.condition, v_pipeline::text, v_stages)
   where f.organization_id = v_org
     and f.object_type = 'deal'
     and f.condition is not null
     and app.condition_without_pipeline(f.condition, v_pipeline::text, v_stages) is distinct from f.condition;
  perform set_config('app.condition_cleanup', '', true);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;
revoke all on function app.pipeline_conditions_cleanup() from public, anon, authenticated;

create or replace trigger pipelines_condition_cleanup after update of deleted_at on public.pipelines
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function app.pipeline_conditions_cleanup();

-- a hard delete of a live pipeline cleans too (before its stages go with it)
create or replace trigger pipelines_condition_cleanup_delete before delete on public.pipelines
  for each row execute function app.pipeline_conditions_cleanup();
