-- =============================================================================
-- 0003 audit log, outbox events, notifications
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Audit log: append-only. Clients can read (admins) but never write or change.
-- ----------------------------------------------------------------------------
create table public.audit_log (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- no foreign key: the trail must survive the deletion of the user
  actor_id        uuid,
  -- insert | update | delete | trash | restore
  action          text not null,
  entity_type     text not null,
  entity_id       uuid,
  -- update: { field: { "old": .., "new": .. } }   delete: the full old row
  changes         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index audit_log_org_time_idx on public.audit_log (organization_id, created_at desc);
create index audit_log_entity_idx on public.audit_log (organization_id, entity_type, entity_id);

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
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164'];
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

create trigger organizations_audit after update on public.organizations for each row execute function app.audit_row();
create trigger memberships_audit after insert or update or delete on public.memberships for each row execute function app.audit_row();
create trigger teams_audit after insert or update or delete on public.teams for each row execute function app.audit_row();
create trigger team_members_audit after insert or update or delete on public.team_members for each row execute function app.audit_row();
create trigger invitations_audit after insert or update or delete on public.invitations for each row execute function app.audit_row();
create trigger subscriptions_audit after insert or update on public.subscriptions for each row execute function app.audit_row();
create trigger pipelines_audit after insert or update or delete on public.pipelines for each row execute function app.audit_row();
create trigger stages_audit after insert or update or delete on public.stages for each row execute function app.audit_row();
create trigger field_definitions_audit after insert or update or delete on public.field_definitions for each row execute function app.audit_row();
create trigger companies_audit after insert or update or delete on public.companies for each row execute function app.audit_row();
create trigger contacts_audit after insert or update or delete on public.contacts for each row execute function app.audit_row();
create trigger leads_audit after insert or update or delete on public.leads for each row execute function app.audit_row();
create trigger deals_audit after insert or update or delete on public.deals for each row execute function app.audit_row();
create trigger tasks_audit after insert or update or delete on public.tasks for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- Outbox: every change to a business record becomes an event. A background
-- worker reads unprocessed rows and drives automations, webhooks and
-- notifications. No client access at all (RLS on, no policies).
-- ----------------------------------------------------------------------------
create table public.outbox_events (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- lead.created | lead.updated | lead.deleted | deal.created | ...
  event_type      text not null,
  entity_type     text not null,
  entity_id       uuid not null,
  actor_id        uuid,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz,
  attempts        integer not null default 0,
  last_error      text
);

create index outbox_events_pending_idx on public.outbox_events (id) where processed_at is null;

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
begin
  if tg_op = 'DELETE' then
    if not app.org_exists(old.organization_id) then
      return null;
    end if;
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id)
    values (old.organization_id, v_entity || '.purged', v_entity, old.id, auth.uid());
    return null;
  end if;

  if tg_op = 'INSERT' then
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id)
    values (new.organization_id, v_entity || '.created', v_entity, new.id, auth.uid());
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
          jsonb_build_object('changed', to_jsonb(v_changed)));
  return null;
end;
$$;

create trigger companies_emit after insert or update or delete on public.companies for each row execute function app.emit_event('company');
create trigger contacts_emit after insert or update or delete on public.contacts for each row execute function app.emit_event('contact');
create trigger leads_emit after insert or update or delete on public.leads for each row execute function app.emit_event('lead');
create trigger deals_emit after insert or update or delete on public.deals for each row execute function app.emit_event('deal');
create trigger tasks_emit after insert or update or delete on public.tasks for each row execute function app.emit_event('task');

-- ----------------------------------------------------------------------------
-- Notifications (in-app bell). Each user sees only their own.
-- ----------------------------------------------------------------------------
create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id         uuid not null,
  -- assigned | mention | task_due | lead_new | system ...
  type            text not null,
  title           text not null,
  body            text,
  entity_type     text,
  entity_id       uuid,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- Tell a user when a lead, deal or task is assigned to them by someone else.
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
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  values (new.organization_id, new.owner_id, 'assigned', v_title, v_entity, new.id);
  return null;
end;
$$;

create trigger leads_notify_assignment after insert or update of owner_id on public.leads
  for each row execute function app.notify_assignment('lead', 'ליד חדש הוקצה לך');
create trigger deals_notify_assignment after insert or update of owner_id on public.deals
  for each row execute function app.notify_assignment('deal', 'עסקה הוקצתה לך');
create trigger tasks_notify_assignment after insert or update of owner_id on public.tasks
  for each row execute function app.notify_assignment('task', 'משימה חדשה הוקצתה לך');
