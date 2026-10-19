-- =============================================================================
-- The business's activity and task types (TASK-08)
-- =============================================================================
-- SPEC-ADDITIONS TASK-08: activity types the business adds (a visit, a demo), with an icon. Owner's answers
-- (DECISIONS.md, 18 and 19 October 2026): (1) a name of the business under one of the six base kinds; the six
-- kinds keep driving the reports and "last contact"; (2) ONE list for activities and tasks; (3) every plan, no
-- plan key, no limit beyond the managed-list cap; (4) "משימה" and "מעקב" stay two fixed task choices beside the
-- list, not entries in it.
--
-- * public.activity_types: a managed list (12 October rule). base_type (note | call | meeting | whatsapp | email |
--   sms) is set on insert and never changed (no update grant); name 1..60, unique per business ignoring case;
--   icon null (= the base's icon) or a key of the closed list below, mirrored by ACTIVITY_TYPE_ICONS in
--   src/features/activity-types/types.ts (unit test); position; is_active (a hidden type stays on what has it).
--   `key` is server-only: the seed writes the base on the six defaults it made, so an entry logged before the
--   list (activity_type_id empty) is shown by the default of its kind. Members read; owners and admins of a
--   writable business write; at most 50 (trigger activity_types_cap, hint 'activity_types:max', outsider guard
--   first); audited.
-- * activities.activity_type_id (nullable, composite FK, set null of the column when the type is deleted). Trigger
--   activities_activity_type (invoker): the type's base must be the activity's kind, for every writer (hint
--   'activity_type:invalid'); a person may pick only an active type. activities.type is unchanged, so every
--   report, "last contact", the activation rule and the lead score keep reading the six kinds.
-- * tasks.activity_type_id (same FK; column grants, as every tasks column since 0063). Trigger
--   tasks_activity_type_check (invoker): a person picks only an active type; a picked type sets task_type from its
--   base (call -> call, meeting -> meeting, any other -> todo), so automations, filters, imports and the call-back
--   rules that read the four codes keep working; changing task_type alone (an automation's set_field, the fixed
--   "משימה" / "מעקב" choices) clears the type. Trigger tasks_activity_type_carry (definer, before it by name): the
--   next occurrence of a recurring task keeps the type of the one it follows.
-- * Defaults: app.seed_activity_types(org) inserts the six while the list is empty; trigger
--   organizations_seed_activity_types seeds every new business (create_organization is not changed), and existing
--   businesses whose list is empty are seeded at the end (an insert into the new table; no existing row changes).
--   Names mirror DEFAULT_ACTIVITY_TYPES in src/features/activity-types/types.ts (unit test).
-- * public.reorder_positions takes 'activity_types' (FXD-07; its body is otherwise that of 020220).
-- No existing row is changed. No drop, no delete. Safe to run twice.

create table if not exists public.activity_types (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  base_type       text not null check (base_type in ('note', 'call', 'meeting', 'whatsapp', 'email', 'sms')),
  name            text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  icon            text check (icon is null or icon in ('pencil', 'phone', 'calendar', 'chat', 'mail', 'users', 'building',
                                                       'home', 'check', 'tag', 'bolt', 'form', 'bell', 'chart')),
  key             text check (key is null or key in ('note', 'call', 'meeting', 'whatsapp', 'email', 'sms')),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint activity_types_key_base check (key is null or key = base_type)
);

create unique index if not exists activity_types_name_idx on public.activity_types (organization_id, lower(name));
create unique index if not exists activity_types_key_idx on public.activity_types (organization_id, key) where key is not null;
create index if not exists activity_types_org_idx on public.activity_types (organization_id, position);

alter table public.activity_types enable row level security;

revoke all on public.activity_types from anon, authenticated;
grant select, delete on public.activity_types to authenticated;
grant insert (organization_id, base_type, name, icon, position, is_active) on public.activity_types to authenticated;
grant update (name, icon, position, is_active) on public.activity_types to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_types' and policyname = 'activity_types_select') then
    create policy activity_types_select on public.activity_types for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_types' and policyname = 'activity_types_insert') then
    create policy activity_types_insert on public.activity_types for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_types' and policyname = 'activity_types_update') then
    create policy activity_types_update on public.activity_types for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_types' and policyname = 'activity_types_delete') then
    create policy activity_types_delete on public.activity_types for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger activity_types_touch before update on public.activity_types
  for each row execute function app.touch_row();
create or replace trigger activity_types_audit after insert or update or delete on public.activity_types
  for each row execute function app.audit_row();

create or replace function app.activity_types_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider gets RLS's plain refusal and learns nothing about the organization
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('activity_types:' || new.organization_id::text, 0));
  if (select count(*) from public.activity_types t where t.organization_id = new.organization_id) >= 50 then
    raise exception 'too many activity types' using errcode = 'P0001', hint = 'activity_types:max';
  end if;
  return new;
end;
$$;
revoke all on function app.activity_types_cap() from public, anon, authenticated;

create or replace trigger activity_types_cap before insert on public.activity_types
  for each row execute function app.activity_types_cap();

-- ----------------------------------------------------------------------------
-- The type of a logged activity
-- ----------------------------------------------------------------------------
alter table public.activities add column if not exists activity_type_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.activities'::regclass and conname = 'activities_activity_type_fk') then
    alter table public.activities add constraint activities_activity_type_fk foreign key (organization_id, activity_type_id)
      references public.activity_types (organization_id, id) on delete set null (activity_type_id);
  end if;
end;
$$;

create index if not exists activities_activity_type_idx on public.activities (organization_id, activity_type_id)
  where activity_type_id is not null;

create or replace function app.activity_type_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_base   text;
  v_active boolean;
begin
  if new.activity_type_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.activity_type_id is not distinct from old.activity_type_id and new.type is not distinct from old.type then
    return new;
  end if;
  select t.base_type, t.is_active into v_base, v_active
    from public.activity_types t where t.organization_id = new.organization_id and t.id = new.activity_type_id;
  -- not found: a type of another business (the foreign key refuses it next) or one the caller cannot read
  if v_base is null or v_base <> new.type then
    raise exception 'this type does not fit the activity' using errcode = 'P0001', hint = 'activity_type:invalid';
  end if;
  -- security invoker on purpose: current_user tells a person's pick from a server write
  if current_user = 'authenticated' and not v_active
     and (tg_op = 'INSERT' or new.activity_type_id is distinct from old.activity_type_id) then
    raise exception 'this type is not on the list' using errcode = 'P0001', hint = 'activity_type:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.activity_type_check() from public, anon, authenticated;

create or replace trigger activities_activity_type before insert or update of activity_type_id, type on public.activities
  for each row execute function app.activity_type_check();

-- ----------------------------------------------------------------------------
-- The type of a task
-- ----------------------------------------------------------------------------
alter table public.tasks add column if not exists activity_type_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_activity_type_fk') then
    alter table public.tasks add constraint tasks_activity_type_fk foreign key (organization_id, activity_type_id)
      references public.activity_types (organization_id, id) on delete set null (activity_type_id);
  end if;
end;
$$;

create index if not exists tasks_activity_type_idx on public.tasks (organization_id, activity_type_id)
  where activity_type_id is not null;

-- tasks has column-level insert/update grants (0063)
grant insert (activity_type_id), update (activity_type_id) on public.tasks to authenticated;

create or replace function app.task_activity_type_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_base   text;
  v_active boolean;
begin
  -- a new task_type alone (the fixed "משימה" / "מעקב", an automation's set_field) leaves the list's type
  if tg_op = 'UPDATE' and new.activity_type_id is not distinct from old.activity_type_id
     and new.task_type is distinct from old.task_type then
    new.activity_type_id := null;
  end if;
  if new.activity_type_id is null then
    return new;
  end if;
  select t.base_type, t.is_active into v_base, v_active
    from public.activity_types t where t.organization_id = new.organization_id and t.id = new.activity_type_id;
  if v_base is null then
    raise exception 'this type is not on the list' using errcode = 'P0001', hint = 'activity_type:invalid';
  end if;
  -- security invoker on purpose: current_user tells a person's pick from a server write
  if current_user = 'authenticated' and not v_active
     and (tg_op = 'INSERT' or new.activity_type_id is distinct from old.activity_type_id) then
    raise exception 'this type is not on the list' using errcode = 'P0001', hint = 'activity_type:invalid';
  end if;
  -- the four codes stay the truth for automations, filters, imports and the call-back rules
  new.task_type := case v_base when 'call' then 'call' when 'meeting' then 'meeting' else 'todo' end;
  return new;
end;
$$;
revoke all on function app.task_activity_type_check() from public, anon, authenticated;

create or replace trigger tasks_activity_type_check before insert or update of activity_type_id, task_type on public.tasks
  for each row execute function app.task_activity_type_check();

-- the next occurrence of a recurring task (app.spawn_recurring_task) keeps the type of the one it follows
create or replace function app.task_activity_type_carry() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.recurrence_source_id is not null and new.activity_type_id is null then
    select s.activity_type_id into new.activity_type_id
      from public.tasks s
     where s.organization_id = new.organization_id and s.id = new.recurrence_source_id
       and s.task_type = new.task_type;
  end if;
  return new;
end;
$$;
revoke all on function app.task_activity_type_carry() from public, anon, authenticated;

create or replace trigger tasks_activity_type_carry before insert on public.tasks
  for each row execute function app.task_activity_type_carry();

-- ----------------------------------------------------------------------------
-- Default types: a business starts with the six kinds under today's names, and renames, hides or deletes them
-- ----------------------------------------------------------------------------
create or replace function app.seed_activity_types(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.activity_types (organization_id, base_type, name, key, position)
  select p_org, d.base, d.name, d.base, d.pos
    from (values ('note', 'הערה', 0),
                 ('call', 'שיחה', 1),
                 ('meeting', 'פגישה', 2),
                 ('whatsapp', 'WhatsApp', 3),
                 ('email', 'אימייל', 4),
                 ('sms', 'SMS', 5)) as d(base, name, pos)
   where not exists (select 1 from public.activity_types t where t.organization_id = p_org)
   order by d.pos;
end;
$$;
revoke all on function app.seed_activity_types(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_activity_types() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_activity_types(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_activity_types() from public, anon, authenticated;

create or replace trigger organizations_seed_activity_types after insert on public.organizations
  for each row execute function app.organizations_seed_activity_types();

-- ----------------------------------------------------------------------------
-- Ordering the list in one call (FXD-07): the body of 020220 with 'activity_types' added
-- ----------------------------------------------------------------------------
create or replace function public.reorder_positions(p_table text, p_org uuid, p_ids uuid[]) returns integer
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_seen integer;
  v_due integer;
  v_done integer;
begin
  if p_table is null or p_table not in (
       'stages', 'lead_statuses', 'field_definitions', 'disqualify_reasons', 'deal_loss_reasons', 'record_type_options',
       'whatsapp_templates', 'product_categories', 'product_units', 'deal_contact_roles', 'lead_routing_rules',
       'contact_relation_types', 'activity_types') then
    raise exception 'this list cannot be reordered here' using errcode = '22023', hint = 'reorder:table';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'invalid order' using errcode = '22023', hint = 'reorder:table';
  end if;
  -- every id must be a row of this business the caller sees
  execute format('select count(*)::int from public.%I t where t.organization_id = $1 and t.id = any($2)', p_table)
    into v_seen using p_org, p_ids;
  if v_seen <> cardinality(p_ids) then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;
  execute format(
    'select count(*)::int from public.%I t join unnest($2::uuid[]) with ordinality as o(id, n) on o.id = t.id
      where t.organization_id = $1 and t.position is distinct from (o.n - 1)::integer', p_table)
    into v_due using p_org, p_ids;
  execute format(
    'update public.%I t set position = (o.n - 1)::integer
       from unnest($2::uuid[]) with ordinality as o(id, n)
      where t.organization_id = $1 and t.id = o.id and t.position is distinct from (o.n - 1)::integer', p_table)
    using p_org, p_ids;
  get diagnostics v_done = row_count;
  -- an update RLS filtered out answers no error: refuse the whole order instead of half of it
  if v_done < v_due then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_done;
end;
$$;
revoke all on function public.reorder_positions(text, uuid, uuid[]) from public, anon;
grant execute on function public.reorder_positions(text, uuid, uuid[]) to authenticated;

-- existing organizations whose list is empty: once. A re-run seeds again only a list that is empty then
-- (managed lists rule).
select app.seed_activity_types(o.id) from public.organizations o;

notify pgrst, 'reload schema';
