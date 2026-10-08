-- =============================================================================
-- 0041 A task reminder is not a change to the task (FXD-03)
-- =============================================================================
-- app.send_task_reminders() stamps tasks.reminded_at when it sends a reminder.
-- That update was written to the audit log ("task updated", with no name) and
-- queued as a task.updated event. reminded_at joins the columns that the audit
-- log and the event queue ignore. Both functions are otherwise as before
-- (audit_row as in 0008, emit_event as in 0012).
-- Every statement is safe to run twice.

create or replace function app.audit_row() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_org uuid;
  v_entity uuid;
  v_action text;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164', 'last_lead_assigned_at', 'reminded_at'];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_table_name = 'organizations' then
    v_org := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  else
    v_org := coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid;
  end if;
  v_entity := nullif(coalesce(v_new ->> 'id', v_old ->> 'id'), '')::uuid;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'DELETE' then
    -- nothing to attach the entry to when the organization itself is going away
    if not app.org_exists(v_org) then
      return null;
    end if;
    v_action := 'delete';
    v_changes := v_old;
  else
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> all (v_ignored) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    v_action := case
      when v_changes ? 'deleted_at' and (v_new ->> 'deleted_at') is not null then 'trash'
      when v_changes ? 'deleted_at' then 'restore'
      else 'update'
    end;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_changes);
  return null;
end;
$$;

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
  v_event text;
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164', 'reminded_at'];
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
