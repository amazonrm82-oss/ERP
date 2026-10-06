-- =============================================================================
-- 0012 Imports: import jobs, and records that remember which import made them
-- =============================================================================
-- * import_jobs: one row per file imported (who, what, how many, status).
--   Owners, admins and team managers may import (app.can_import).
-- * leads / contacts / companies get import_job_id. A record may be tagged only
--   with a running job of the same user and type, and the tag cannot be changed
--   later. Undoing an import moves the records it created to the recycle bin.
-- * Imported records do not start automations and do not send "assigned to you"
--   notifications: a file of 5,000 leads must not create 5,000 tasks. Their
--   outbox events carry payload.origin = 'import'.
-- Every statement is safe to run twice.

create or replace function app.can_import(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.org_writable(p_org) and coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false);
$$;

create table if not exists public.import_jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  entity_type     text not null check (entity_type in ('lead', 'contact', 'company')),
  file_name       text not null check (char_length(file_name) between 1 and 255),
  duplicate_mode  text not null check (duplicate_mode in ('skip', 'update', 'create')),
  status          text not null default 'running' check (status in ('running', 'done', 'failed', 'undone')),
  total_rows      integer not null default 0 check (total_rows between 0 and 50000),
  created_count   integer not null default 0 check (created_count >= 0),
  updated_count   integer not null default 0 check (updated_count >= 0),
  skipped_count   integer not null default 0 check (skipped_count >= 0),
  failed_count    integer not null default 0 check (failed_count >= 0),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  undone_at       timestamptz,
  unique (organization_id, id)
);

create index if not exists import_jobs_org_idx on public.import_jobs (organization_id, created_at desc);

alter table public.leads add column if not exists import_job_id uuid;
alter table public.contacts add column if not exists import_job_id uuid;
alter table public.companies add column if not exists import_job_id uuid;

do $$
declare
  t text;
begin
  foreach t in array array['leads', 'contacts', 'companies'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_import_job_fk') then
      execute format(
        'alter table public.%1$I add constraint %1$s_import_job_fk foreign key (organization_id, import_job_id)
           references public.import_jobs (organization_id, id) on delete set null (import_job_id)', t);
    end if;
    execute format('create index if not exists %1$s_import_job_idx on public.%1$I (import_job_id) where import_job_id is not null', t);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- Access
-- ----------------------------------------------------------------------------
alter table public.import_jobs enable row level security;
revoke all on public.import_jobs from anon, authenticated;
grant all on public.import_jobs to service_role;
grant select on public.import_jobs to authenticated;
grant insert (organization_id, entity_type, file_name, duplicate_mode, total_rows) on public.import_jobs to authenticated;
grant update (status, created_count, updated_count, skipped_count, failed_count, finished_at, undone_at)
  on public.import_jobs to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'import_jobs' and policyname = 'import_jobs_select') then
    create policy import_jobs_select on public.import_jobs for select to authenticated
      using (app.is_member(organization_id) and (created_by = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'import_jobs' and policyname = 'import_jobs_insert') then
    create policy import_jobs_insert on public.import_jobs for insert to authenticated
      with check (app.can_import(organization_id) and created_by = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'import_jobs' and policyname = 'import_jobs_update') then
    create policy import_jobs_update on public.import_jobs for update to authenticated
      using (app.can_import(organization_id) and created_by = (select auth.uid()))
      with check (app.can_import(organization_id) and created_by = (select auth.uid()));
  end if;
end;
$$;

-- touch_row: created_by is the session's user, organization_id cannot change
create or replace trigger import_jobs_touch before insert or update on public.import_jobs
  for each row execute function app.touch_row();

-- ----------------------------------------------------------------------------
-- A record may carry only a running import of the same user and type, set on insert
-- ----------------------------------------------------------------------------
create or replace function app.guard_import_tag() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.import_job_id is distinct from old.import_job_id and auth.uid() is not null then
      raise exception 'import_job_id cannot be changed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.import_job_id is not null and auth.uid() is not null and not exists (
    select 1 from public.import_jobs j
     where j.organization_id = new.organization_id and j.id = new.import_job_id
       and j.created_by = auth.uid() and j.status = 'running' and j.entity_type = tg_argv[0]) then
    raise exception 'not a running import of this user' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger leads_import_tag before insert or update of import_job_id on public.leads
  for each row execute function app.guard_import_tag('lead');
create or replace trigger contacts_import_tag before insert or update of import_job_id on public.contacts
  for each row execute function app.guard_import_tag('contact');
create or replace trigger companies_import_tag before insert or update of import_job_id on public.companies
  for each row execute function app.guard_import_tag('company');

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

-- Event rules skip events made by automations and by imports.
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
      if coalesce(v_event.payload ->> 'origin', '') not in ('automation', 'import') and app.org_writable(v_event.organization_id) then
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

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
revoke all on function app.can_import(uuid) from public, anon;
grant execute on function app.can_import(uuid) to authenticated, service_role;
revoke all on function app.guard_import_tag() from public, anon;
grant execute on function app.guard_import_tag() to authenticated, service_role;
