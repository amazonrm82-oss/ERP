-- 20261006001200_imports: part 3 of 4. Run the parts in order.
-- ----------------------------------------------------------------------------
-- Imported records: outbox events marked origin 'import', no assignment notifications
-- (same functions as in 0009 and 0003, with the import checks added)
-- ----------------------------------------------------------------------------
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
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164'];
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

create or replace function app.notify_assignment() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_title text := tg_argv[1];
begin
  if new.owner_id is null or new.owner_id is not distinct from auth.uid() then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.owner_id is not distinct from old.owner_id then
    return null;
  end if;
  -- an imported file is not "assigned to you" one record at a time
  if tg_op = 'INSERT' and to_jsonb(new) ->> 'import_job_id' is not null then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  values (new.organization_id, new.owner_id, 'assigned', v_title, v_entity, new.id);
  return null;
end;
$$;
