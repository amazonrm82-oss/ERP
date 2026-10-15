-- =============================================================================
-- Conditional fields: what deleting a pipeline leaves behind (FLD-09 pipeline, part B)
-- =============================================================================
-- Owner, 15 October 2026 (DECISIONS.md "מחיקת צנרת ותנאי שלב"): deleting a pipeline also removes
-- the conditions on its stages (as migration condition_pipeline already does), and:
-- (1) the delete window counts the conditions and names the fields (app only: the settings page
--     runs conditionWithoutPipeline() over the deal fields the person reads);
-- (2) the deletion is in the audit log with the fields. Every changed field_definitions row is
--     already audited by field_definitions_audit (an 'update' with the old and new condition);
--     app.pipeline_conditions_cleanup() now adds one entry on top, action 'conditions_removed',
--     entity 'pipelines' (the deleted pipeline's id), changes = {"fields": [{"key", "label",
--     "removed"}]} ("removed" = the condition is gone, false = it only shrank). None when no field
--     changed. The actor is the person who deleted the pipeline.
-- (3) field_definitions.condition_removed_at (null by default): set to now() by the cleanup only
--     on a field whose condition became null; a condition that only shrank gets no mark. Server
--     only: field_definitions has table-level grants, so the column cannot be kept from clients by
--     a grant; trigger field_definitions_condition_mark (invoker) keeps it instead. Any write that
--     is not the cleanup cannot set it: an insert starts with null, and an update keeps the old
--     value when no column but position and is_active changed (moving it up or down, hiding,
--     showing, also a hide that sends the same value) and clears it on any real edit, also one
--     made together with a move (a person saving the field or its condition). The settings
--     list shows "התנאי הוסר (צנרת נמחקה)" while it is set.
--
-- app.pipeline_conditions_cleanup() is redefined from migration condition_pipeline, changing only
-- the update (it also sets the mark and returns the changed fields) and the audit entry.
-- app.field_condition_check() is unchanged. Safe to run twice; no drops, no deletes.

alter table public.field_definitions add column if not exists condition_removed_at timestamptz;

create or replace function app.field_condition_mark() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- the pipeline cleanup sets it (only from inside the definer cleanup, never a person's session)
  if current_setting('app.condition_cleanup', true) = 'on' and current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.condition_removed_at := null;
  elsif (to_jsonb(new) - array['position', 'is_active', 'updated_at', 'updated_by', 'condition_removed_at'])
        = (to_jsonb(old) - array['position', 'is_active', 'updated_at', 'updated_by', 'condition_removed_at']) then
    -- nothing but the field's place or visibility changed (moving, hiding, showing, or a save that changes
    -- nothing): not an edit, the mark stays
    new.condition_removed_at := old.condition_removed_at;
  else
    new.condition_removed_at := null;
  end if;
  return new;
end;
$$;
revoke all on function app.field_condition_mark() from public, anon, authenticated;

create or replace trigger field_definitions_condition_mark before insert or update on public.field_definitions
  for each row execute function app.field_condition_mark();

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
  v_fields jsonb;
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
  with changed as (
    update public.field_definitions f
       set condition = app.condition_without_pipeline(f.condition, v_pipeline::text, v_stages),
           condition_removed_at = case when app.condition_without_pipeline(f.condition, v_pipeline::text, v_stages) is null
                                       then now() else f.condition_removed_at end
     where f.organization_id = v_org
       and f.object_type = 'deal'
       and f.condition is not null
       and app.condition_without_pipeline(f.condition, v_pipeline::text, v_stages) is distinct from f.condition
    returning f.key, f.label, f.condition is null as removed, f.position
  )
  select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'removed', c.removed) order by c.position, c.key)
    into v_fields
    from changed c;
  perform set_config('app.condition_cleanup', '', true);
  if v_fields is not null then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (v_org, auth.uid(), 'conditions_removed', 'pipelines', v_pipeline, jsonb_build_object('fields', v_fields));
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;
revoke all on function app.pipeline_conditions_cleanup() from public, anon, authenticated;
