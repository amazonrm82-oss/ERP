-- =============================================================================
-- 0009 Automations: "when ... if ... then ..." rules run by the database
-- =============================================================================
-- * automations: one rule per row. trigger (event or time based), conditions
--   (all must match) and actions, as JSON. Admins manage them.
-- * automation_runs: the log. One row per rule per record per occasion;
--   run_key makes every occasion run at most once.
-- * app.process_outbox(): reads new outbox_events and runs the matching rules.
--   app.run_scheduled_automations(): the time-based rules (no activity, stuck
--   deal, birthday, task due soon). Both are scheduled with pg_cron when the
--   extension exists (Supabase); otherwise nothing is scheduled.
-- * Loop guard: changes made by an automation are marked in the outbox
--   (payload.origin = 'automation') and never trigger automations themselves.
--   On top of that, one rule runs at most 20 times a day for one record.
-- * Actions touch only rows of the rule's own organization: every id in the
--   JSON is looked up together with organization_id before it is used.

create table public.automations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  template_key    text,
  is_active       boolean not null default true,
  entity_type     text not null check (entity_type in ('lead', 'contact', 'company', 'deal', 'task')),
  trigger_type    text not null check (trigger_type in (
                    'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost',
                    'no_activity', 'stuck_in_stage', 'birthday', 'task_due_soon')),
  trigger_config  jsonb not null default '{}'::jsonb check (jsonb_typeof(trigger_config) = 'object'),
  conditions      jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array'),
  actions         jsonb not null check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) between 1 and 10),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create index automations_org_idx on public.automations (organization_id) where is_active;

create table public.automation_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  automation_id   uuid not null,
  entity_type     text not null,
  entity_id       uuid not null,
  -- what this run was for: 'event:<outbox id>', 'stuck:<deal>:<since>', 'manual:<uuid>' ...
  run_key         text not null,
  status          text not null check (status in ('success', 'partial', 'failed', 'skipped')),
  -- [{"action": "create_task", "status": "ok" | "error", "error": "..."}]
  steps           jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (automation_id, run_key),
  foreign key (organization_id, automation_id) references public.automations (organization_id, id) on delete cascade
);

create index automation_runs_automation_idx on public.automation_runs (automation_id, created_at desc);
create index automation_runs_entity_idx on public.automation_runs (automation_id, entity_id, created_at desc);

create trigger automations_touch before insert or update on public.automations
  for each row execute function app.touch_row();
create trigger automations_audit after insert or update or delete on public.automations
  for each row execute function app.audit_row();

-- Plan limit on active automations (max_active_automations), on insert and on re-activation.
create or replace function app.guard_automation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
  v_count bigint;
begin
  if not new.is_active or (tg_op = 'UPDATE' and old.is_active) then
    return new;
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_active_automations');
  if v_limit is not null then
    select count(*) into v_count from public.automations a
     where a.organization_id = new.organization_id and a.is_active and a.id <> new.id;
    if v_count + 1 > v_limit then
      raise exception 'plan limit reached (max_active_automations = %)', v_limit
        using errcode = 'P0001', hint = 'limit:max_active_automations';
    end if;
  end if;
  return new;
end;
$$;

create trigger automations_guard before insert or update of is_active on public.automations
  for each row execute function app.guard_automation();

alter table public.automations enable row level security;
alter table public.automation_runs enable row level security;

revoke all on public.automations, public.automation_runs from anon, authenticated;
grant all on public.automations, public.automation_runs to service_role;
grant select, delete on public.automations to authenticated;
grant insert (organization_id, name, template_key, is_active, entity_type, trigger_type, trigger_config, conditions, actions)
  on public.automations to authenticated;
grant update (name, is_active, trigger_type, trigger_config, conditions, actions) on public.automations to authenticated;
grant select on public.automation_runs to authenticated;

create policy automations_select on public.automations for select to authenticated
  using (app.is_admin(organization_id));
create policy automations_insert on public.automations for insert to authenticated
  with check (app.is_admin(organization_id) and app.org_writable(organization_id));
create policy automations_update on public.automations for update to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id))
  with check (app.is_admin(organization_id));
create policy automations_delete on public.automations for delete to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id));
create policy automation_runs_select on public.automation_runs for select to authenticated
  using (app.is_admin(organization_id));

-- Events caused by automation actions are marked (see the loop guard above).
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

-- ----------------------------------------------------------------------------
-- Engine helpers
-- ----------------------------------------------------------------------------
create or replace function app.automation_table(p_entity text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_entity
    when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
    when 'deal' then 'deals' when 'task' then 'tasks' end
$$;

-- The current row of a record, as JSON, or null.
create or replace function app.automation_record(p_entity text, p_org uuid, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_table text := app.automation_table(p_entity);
  v_row jsonb;
begin
  if v_table is null then
    return null;
  end if;
  execute format('select to_jsonb(t) from public.%I t where t.organization_id = $1 and t.id = $2', v_table)
    into v_row using p_org, p_id;
  return v_row;
end;
$$;

-- An active, non-viewer member of the organization, or null.
create or replace function app.automation_member(p_org uuid, p_user uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.user_id from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active' and m.role <> 'viewer'
$$;

-- All conditions must hold. [{"field": "source_id", "op": "eq", "value": "..."}]
create or replace function app.automation_conditions_match(p_record jsonb, p_conditions jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_cond jsonb;
  v_field text;
  v_op text;
  v_value text;
  v_actual jsonb;
  v_text text;
  v_ok boolean;
begin
  for v_cond in select * from jsonb_array_elements(coalesce(p_conditions, '[]'::jsonb)) loop
    v_field := v_cond ->> 'field';
    v_op := v_cond ->> 'op';
    v_value := v_cond ->> 'value';
    if v_field is null or v_field !~ '^[a-z_]{1,40}$' then
      return false;
    end if;
    v_actual := p_record -> v_field;
    v_text := case when v_actual is null or jsonb_typeof(v_actual) = 'null' then null else v_actual #>> '{}' end;
    v_ok := case v_op
      when 'eq' then v_text is not distinct from v_value
      when 'neq' then v_text is distinct from v_value
      when 'empty' then v_text is null or v_text = '' or v_text = '[]'
      when 'not_empty' then not (v_text is null or v_text = '' or v_text = '[]')
      when 'gte' then v_text ~ '^-?[0-9.]+$' and v_value ~ '^-?[0-9.]+$' and v_text::numeric >= v_value::numeric
      when 'lte' then v_text ~ '^-?[0-9.]+$' and v_value ~ '^-?[0-9.]+$' and v_text::numeric <= v_value::numeric
      when 'has_tag' then jsonb_typeof(v_actual) = 'array' and v_actual ? v_value
      else false
    end;
    if not coalesce(v_ok, false) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function app.automation_display_name(p_record jsonb) returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(nullif(p_record ->> 'full_name', ''), nullif(p_record ->> 'name', ''), nullif(p_record ->> 'title', ''),
                  nullif(p_record ->> 'email', ''), nullif(p_record ->> 'phone', ''), 'רשומה')
$$;

-- ----------------------------------------------------------------------------
-- Actions. Each one in its own sub-transaction: a failing step is logged and
-- the next one still runs.
-- ----------------------------------------------------------------------------
create or replace function app.run_automation_actions(p_auto public.automations, p_entity text, p_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := p_auto.organization_id;
  v_table text := app.automation_table(p_entity);
  v_record jsonb;
  v_action jsonb;
  v_type text;
  v_steps jsonb := '[]'::jsonb;
  v_name text;
  v_title text;
  v_user uuid;
  v_id uuid;
  v_due timestamptz;
  v_task_type text;
  v_count integer;
begin
  for v_action in select * from jsonb_array_elements(p_auto.actions) loop
    v_type := v_action ->> 'type';
    v_record := app.automation_record(p_entity, v_org, p_id);
    v_name := app.automation_display_name(v_record);
    begin
      if v_record is null then
        raise exception 'the record no longer exists';
      end if;

      if v_type = 'create_task' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'משימה'), '{{name}}', v_name), 300);
        if v_action ? 'due_in_minutes' or v_action ? 'due_in_days' then
          v_due := now()
            + make_interval(mins => coalesce((v_action ->> 'due_in_minutes')::int, 0))
            + make_interval(days => coalesce((v_action ->> 'due_in_days')::int, 0));
        else
          v_due := null;
        end if;
        v_user := case when v_action ->> 'assign' = 'user'
                       then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                       else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
        v_task_type := case when v_action ->> 'task_type' in ('todo', 'call', 'meeting', 'follow_up')
                            then v_action ->> 'task_type' else 'todo' end;
        insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id, contact_id, company_id, deal_id)
        values (
          v_org, v_title, v_task_type, v_due, v_user,
          case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end,
          case when p_entity = 'contact' then p_id when p_entity in ('task', 'deal') then (v_record ->> 'contact_id')::uuid end,
          case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end,
          case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end);

      elsif v_type = 'notify' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'עדכון מאוטומציה'), '{{name}}', v_name), 200);
        if v_action ->> 'to' = 'admins' then
          insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
          select v_org, m.user_id, 'automation', v_title, p_entity, p_id
            from public.memberships m
           where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'admin');
          get diagnostics v_count = row_count;
        else
          v_user := case when v_action ->> 'to' = 'user'
                         then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                         else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
          v_count := 0;
          if v_user is not null then
            insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
            values (v_org, v_user, 'automation', v_title, p_entity, p_id);
            v_count := 1;
          end if;
        end if;
        if v_count = 0 then
          raise exception 'nobody to notify';
        end if;

      elsif v_type = 'assign_owner' then
        if v_action ->> 'mode' = 'round_robin' then
          if (v_action ->> 'team_id') is not null and not exists (
            select 1 from public.teams t where t.organization_id = v_org and t.id = (v_action ->> 'team_id')::uuid) then
            raise exception 'the team no longer exists';
          end if;
          v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          if v_user is null then
            raise exception 'nobody is available';
          end if;
        else
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
        end if;
        execute format('update public.%I set owner_id = $1 where organization_id = $2 and id = $3', v_table)
          using v_user, v_org, p_id;

      elsif v_type = 'add_tag' then
        if p_entity = 'task' then
          raise exception 'tasks have no tags';
        end if;
        select t.id into v_id from public.tags t where t.organization_id = v_org and t.id = (v_action ->> 'tag_id')::uuid;
        if v_id is null then
          raise exception 'the tag no longer exists';
        end if;
        execute format(
          'update public.%I set tag_ids = case when $1 = any (tag_ids) then tag_ids else array_append(tag_ids, $1) end
            where organization_id = $2 and id = $3', v_table)
          using v_id, v_org, p_id;

      elsif v_type = 'set_lead_status' then
        if p_entity <> 'lead' then
          raise exception 'only for leads';
        end if;
        select s.id into v_id from public.lead_statuses s
         where s.organization_id = v_org and s.id = (v_action ->> 'status_id')::uuid and s.kind <> 'converted';
        if v_id is null then
          raise exception 'the status no longer exists';
        end if;
        update public.leads set status_id = v_id where organization_id = v_org and id = p_id;

      elsif v_type = 'move_deal_stage' then
        if p_entity <> 'deal' then
          raise exception 'only for deals';
        end if;
        select s.id into v_id from public.stages s
         where s.organization_id = v_org and s.id = (v_action ->> 'stage_id')::uuid
           and s.pipeline_id = (v_record ->> 'pipeline_id')::uuid;
        if v_id is null then
          raise exception 'the stage is not in this deal''s pipeline';
        end if;
        update public.deals set stage_id = v_id where organization_id = v_org and id = p_id;

      else
        raise exception 'unknown action %', coalesce(v_type, '(none)');
      end if;

      v_steps := v_steps || jsonb_build_array(jsonb_build_object('action', v_type, 'status', 'ok'));
    exception when others then
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('action', v_type, 'status', 'error', 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return v_steps;
end;
$$;

-- One run of a rule on a record, at most once per run_key. Returns the run's status, or null when nothing ran.
create or replace function app.execute_automation(
  p_auto public.automations, p_entity_id uuid, p_run_key text, p_check_conditions boolean default true
) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_record jsonb := app.automation_record(p_auto.entity_type, p_auto.organization_id, p_entity_id);
  v_run uuid;
  v_steps jsonb;
  v_status text;
  v_ok integer;
  v_total integer;
begin
  if v_record is null or (v_record ->> 'deleted_at') is not null then
    return null;
  end if;
  if p_check_conditions and not app.automation_conditions_match(v_record, p_auto.conditions) then
    return null;
  end if;

  -- loop guard: at most 20 runs of one rule on one record a day
  if (select count(*) from public.automation_runs r
       where r.automation_id = p_auto.id and r.entity_id = p_entity_id and r.created_at > now() - interval '1 day') >= 20 then
    insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status, steps)
    values (p_auto.organization_id, p_auto.id, p_auto.entity_type, p_entity_id, p_run_key, 'skipped',
            jsonb_build_array(jsonb_build_object('action', null, 'status', 'error', 'error', 'daily limit for this record reached')))
    on conflict (automation_id, run_key) do nothing;
    return 'skipped';
  end if;

  insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status)
  values (p_auto.organization_id, p_auto.id, p_auto.entity_type, p_entity_id, p_run_key, 'success')
  on conflict (automation_id, run_key) do nothing
  returning id into v_run;
  if v_run is null then
    return null; -- this occasion already ran
  end if;

  perform set_config('app.automation_running', 'on', true);
  v_steps := app.run_automation_actions(p_auto, p_auto.entity_type, p_entity_id);
  perform set_config('app.automation_running', 'off', true);

  select count(*) filter (where s ->> 'status' = 'ok'), count(*) into v_ok, v_total from jsonb_array_elements(v_steps) s;
  v_status := case when v_ok = v_total then 'success' when v_ok = 0 then 'failed' else 'partial' end;
  update public.automation_runs set status = v_status, steps = v_steps where id = v_run;
  return v_status;
end;
$$;

create or replace function app.automation_event_matches(p_auto public.automations, p_event public.outbox_events, p_record jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_auto.entity_type = p_event.entity_type and case p_auto.trigger_type
    when 'created' then p_event.event_type = p_auto.entity_type || '.created'
    when 'field_changed' then p_event.event_type = p_auto.entity_type || '.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? (p_auto.trigger_config ->> 'field')
      and ((p_auto.trigger_config ->> 'to') is null or p_record ->> (p_auto.trigger_config ->> 'field') = p_auto.trigger_config ->> 'to')
    when 'task_completed' then p_event.event_type = 'task.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'done'
    when 'deal_won' then p_event.event_type = 'deal.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'won'
    when 'deal_lost' then p_event.event_type = 'deal.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'lost'
    else false
  end
$$;

-- ----------------------------------------------------------------------------
-- The two jobs
-- ----------------------------------------------------------------------------

-- New outbox events -> event-based rules. Returns how many events it handled.
create or replace function app.process_outbox(p_limit integer default 500) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_event public.outbox_events%rowtype;
  v_auto public.automations%rowtype;
  v_record jsonb;
  v_count integer := 0;
begin
  for v_event in
    select * from public.outbox_events e where e.processed_at is null order by e.id limit p_limit for update skip locked
  loop
    begin
      if coalesce(v_event.payload ->> 'origin', '') <> 'automation' and app.org_writable(v_event.organization_id) then
        for v_auto in
          select * from public.automations a
           where a.organization_id = v_event.organization_id and a.is_active and a.entity_type = v_event.entity_type
             and a.trigger_type in ('created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost')
        loop
          v_record := app.automation_record(v_event.entity_type, v_event.organization_id, v_event.entity_id);
          if v_record is not null and app.automation_event_matches(v_auto, v_event, v_record) then
            perform app.execute_automation(v_auto, v_event.entity_id, 'event:' || v_event.id);
          end if;
        end loop;
      end if;
      update public.outbox_events set processed_at = now(), attempts = attempts + 1 where id = v_event.id;
    exception when others then
      update public.outbox_events
         set attempts = attempts + 1, last_error = left(sqlerrm, 500),
             processed_at = case when attempts + 1 >= 5 then now() end
       where id = v_event.id;
    end;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Time-based rules, and housekeeping. Returns how many runs it started.
create or replace function app.run_scheduled_automations() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_row record;
  v_days integer;
  v_minutes integer;
  v_table text;
  v_fk text;
  v_extra text;
  v_count integer := 0;
begin
  for v_auto in
    select a.* from public.automations a
     where a.is_active and a.trigger_type in ('no_activity', 'stuck_in_stage', 'birthday', 'task_due_soon')
       and app.org_writable(a.organization_id)
  loop
    begin
      if v_auto.trigger_type = 'no_activity' and v_auto.entity_type in ('lead', 'contact', 'company', 'deal') then
        v_days := greatest(coalesce((v_auto.trigger_config ->> 'days')::int, 3), 1);
        v_table := app.automation_table(v_auto.entity_type);
        v_fk := v_auto.entity_type || '_id';
        v_extra := case v_auto.entity_type when 'lead' then ' and t.converted_at is null'
                                           when 'deal' then ' and t.status = ''open''' else '' end;
        for v_row in execute format(
          'select t.id, coalesce((select max(a.occurred_at) from public.activities a where a.%I = t.id), t.created_at) as last_at
             from public.%I t
            where t.organization_id = $1 and t.deleted_at is null %s
              and coalesce((select max(a.occurred_at) from public.activities a where a.%I = t.id), t.created_at) < now() - make_interval(days => $2)
            limit 200', v_fk, v_table, v_extra, v_fk)
          using v_auto.organization_id, v_days
        loop
          if app.execute_automation(v_auto, v_row.id, 'noact:' || v_row.id || ':' || v_row.last_at) is not null then
            v_count := v_count + 1;
          end if;
        end loop;

      elsif v_auto.trigger_type = 'stuck_in_stage' and v_auto.entity_type = 'deal' then
        v_days := greatest(coalesce((v_auto.trigger_config ->> 'days')::int, 14), 1);
        for v_row in
          select d.id, d.stage_entered_at from public.deals d
           where d.organization_id = v_auto.organization_id and d.deleted_at is null and d.status = 'open'
             and d.stage_entered_at < now() - make_interval(days => v_days)
           limit 200
        loop
          if app.execute_automation(v_auto, v_row.id, 'stuck:' || v_row.id || ':' || v_row.stage_entered_at) is not null then
            v_count := v_count + 1;
          end if;
        end loop;

      elsif v_auto.trigger_type = 'birthday' and v_auto.entity_type = 'contact' then
        for v_row in
          select c.id, to_char(now() at time zone o.timezone, 'YYYY') as year
            from public.contacts c join public.organizations o on o.id = c.organization_id
           where c.organization_id = v_auto.organization_id and c.deleted_at is null and c.birth_date is not null
             and to_char(c.birth_date, 'MM-DD') = to_char(now() at time zone o.timezone, 'MM-DD')
           limit 500
        loop
          if app.execute_automation(v_auto, v_row.id, 'bday:' || v_row.id || ':' || v_row.year) is not null then
            v_count := v_count + 1;
          end if;
        end loop;

      elsif v_auto.trigger_type = 'task_due_soon' and v_auto.entity_type = 'task' then
        v_minutes := least(greatest(coalesce((v_auto.trigger_config ->> 'minutes')::int, 60), 5), 10080);
        for v_row in
          select t.id, t.due_at from public.tasks t
           where t.organization_id = v_auto.organization_id and t.deleted_at is null and t.status = 'open'
             and t.due_at between now() and now() + make_interval(mins => v_minutes)
           limit 500
        loop
          if app.execute_automation(v_auto, v_row.id, 'due:' || v_row.id || ':' || v_row.due_at) is not null then
            v_count := v_count + 1;
          end if;
        end loop;
      end if;
    exception when others then
      raise warning 'scheduled automation % failed: %', v_auto.id, sqlerrm;
    end;
  end loop;

  delete from public.outbox_events where processed_at < now() - interval '30 days';
  delete from public.automation_runs where created_at < now() - interval '90 days';
  return v_count;
end;
$$;

-- ----------------------------------------------------------------------------
-- Test run from the screen: one rule on one record, now, conditions ignored.
-- ----------------------------------------------------------------------------
create or replace function public.run_automation_now(p_automation_id uuid, p_entity_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_status text;
  v_steps jsonb;
begin
  select * into v_auto from public.automations a where a.id = p_automation_id;
  if not found or not app.is_admin(v_auto.organization_id) then
    raise exception 'automation not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_auto.organization_id) then
    raise exception 'the organization is read-only' using errcode = '42501';
  end if;
  if app.automation_record(v_auto.entity_type, v_auto.organization_id, p_entity_id) is null then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  v_status := app.execute_automation(v_auto, p_entity_id, 'manual:' || gen_random_uuid(), false);
  select r.steps into v_steps from public.automation_runs r
   where r.automation_id = v_auto.id and r.entity_id = p_entity_id
   order by r.created_at desc limit 1;
  return jsonb_build_object('status', v_status, 'steps', coalesce(v_steps, '[]'::jsonb));
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: the engine is for the database's own jobs, never for clients.
-- ----------------------------------------------------------------------------
revoke all on function app.automation_table(text) from public, anon, authenticated;
revoke all on function app.automation_record(text, uuid, uuid) from public, anon, authenticated;
revoke all on function app.automation_member(uuid, uuid) from public, anon, authenticated;
revoke all on function app.automation_conditions_match(jsonb, jsonb) from public, anon, authenticated;
revoke all on function app.automation_display_name(jsonb) from public, anon, authenticated;
revoke all on function app.run_automation_actions(public.automations, text, uuid) from public, anon, authenticated;
revoke all on function app.execute_automation(public.automations, uuid, text, boolean) from public, anon, authenticated;
revoke all on function app.automation_event_matches(public.automations, public.outbox_events, jsonb) from public, anon, authenticated;
revoke all on function app.process_outbox(integer) from public, anon, authenticated;
revoke all on function app.run_scheduled_automations() from public, anon, authenticated;
revoke all on function app.guard_automation() from public, anon;
grant execute on function app.guard_automation() to authenticated, service_role;
grant execute on function app.process_outbox(integer) to service_role;
grant execute on function app.run_scheduled_automations() to service_role;

revoke all on function public.run_automation_now(uuid, uuid) from public, anon;
grant execute on function public.run_automation_now(uuid, uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Schedule (Supabase has pg_cron; a plain PostgreSQL without it is left alone)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('crm-process-outbox', '* * * * *', 'select app.process_outbox(500)');
    perform cron.schedule('crm-scheduled-automations', '*/15 * * * *', 'select app.run_scheduled_automations()');
  end if;
end;
$$;
