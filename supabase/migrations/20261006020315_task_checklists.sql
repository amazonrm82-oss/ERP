-- =============================================================================
-- 020315 Task checklists and checklist templates (TASK-06)
-- =============================================================================
-- "תת-משימות ורשימת תיוג בתוך משימה; תבניות רשימה כמו 'קליטת לקוח'."
--
-- * public.task_checklist_items: the steps inside one task (title, done, position). A child record follows its
--   parent (spec 22.9): a person sees an item only with its task (the task's own RLS decides) and writes items of a
--   task they may update (the rule of the tasks_update policy, 018700: keep the two in step), in a writable
--   business, while the task is not removed. done_at / done_by are set by trigger. At most 100 per task (hint
--   task_checklist:max), counted after RLS let the row in, so the count tells an outsider nothing. Cascades with the
--   task. Not audited (ticking a box is not a change of business data the log must keep).
-- * A recurring task (TASK-04) hands its checklist on: the next task gets the same steps, unticked (trigger on the
--   insert of a task with recurrence_source_id; app.spawn_recurring_task is not changed).
-- * public.checklist_templates: a managed list (12 October rule) of named step lists. Members read; owners and admins
--   of a writable business write; names unique ignoring case; 1..50 steps of 1..200 characters; at most 50 per
--   business (hint checklist_templates:max). Audited. Seeded with two defaults (mirrored by DEFAULT_CHECKLIST_TEMPLATES
--   in src/features/task-checklists/templates.ts) for new businesses and for existing ones whose list is empty.
--   Applying a template copies its steps into the task; a later change to the template changes no task.
-- * app.sample_untouched (last redefined in 020150): steps a person added keep a sample task, and its record, on removal.
-- Core CRM (no plan key) until the owner says otherwise. No drop statement, no delete statement. Safe to run twice.

-- ----------------------------------------------------------------------------
-- Checklist items
-- ----------------------------------------------------------------------------
create table if not exists public.task_checklist_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  task_id         uuid not null,
  title           text not null check (char_length(title) between 1 and 200 and title = btrim(title)),
  done            boolean not null default false,
  done_at         timestamptz,
  done_by         uuid references auth.users (id) on delete set null,
  position        integer not null default 0 check (position between 0 and 100000),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint task_checklist_items_done_shape check (done = (done_at is not null)),
  constraint task_checklist_items_task_fk foreign key (organization_id, task_id)
    references public.tasks (organization_id, id) on delete cascade
);
create index if not exists task_checklist_items_task_idx on public.task_checklist_items (organization_id, task_id, position);

alter table public.task_checklist_items enable row level security;
revoke all on public.task_checklist_items from anon, authenticated;
grant select, delete on public.task_checklist_items to authenticated;
grant insert (organization_id, task_id, title, position) on public.task_checklist_items to authenticated;
grant update (title, done, position) on public.task_checklist_items to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_checklist_items' and policyname = 'task_checklist_items_select') then
    -- seen with its task: the subquery runs under the task's own select policy
    create policy task_checklist_items_select on public.task_checklist_items for select to authenticated
      using (app.is_member(organization_id)
             and exists (select 1 from public.tasks t
                          where t.organization_id = task_checklist_items.organization_id and t.id = task_checklist_items.task_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_checklist_items' and policyname = 'task_checklist_items_insert') then
    -- the tasks_update rule (018700), on a task that is not removed
    create policy task_checklist_items_insert on public.task_checklist_items for insert to authenticated
      with check (app.can_write(organization_id)
                  and exists (select 1 from public.tasks t
                               where t.organization_id = task_checklist_items.organization_id and t.id = task_checklist_items.task_id
                                 and t.deleted_at is null
                                 and (app.can_edit_record(t.organization_id, t.owner_id, t.team_id)
                                      or t.created_by = (select auth.uid())
                                      or (t.organization_id, t.id) in (select r.organization_id, r.id from app.deputy_readable('task_open') r))));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_checklist_items' and policyname = 'task_checklist_items_update') then
    create policy task_checklist_items_update on public.task_checklist_items for update to authenticated
      using (app.can_write(organization_id)
             and exists (select 1 from public.tasks t
                          where t.organization_id = task_checklist_items.organization_id and t.id = task_checklist_items.task_id
                            and t.deleted_at is null
                            and (app.can_edit_record(t.organization_id, t.owner_id, t.team_id)
                                 or t.created_by = (select auth.uid())
                                 or (t.organization_id, t.id) in (select r.organization_id, r.id from app.deputy_readable('task_open') r))))
      with check (app.can_write(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_checklist_items' and policyname = 'task_checklist_items_delete') then
    create policy task_checklist_items_delete on public.task_checklist_items for delete to authenticated
      using (app.can_write(organization_id)
             and exists (select 1 from public.tasks t
                          where t.organization_id = task_checklist_items.organization_id and t.id = task_checklist_items.task_id
                            and t.deleted_at is null
                            and (app.can_edit_record(t.organization_id, t.owner_id, t.team_id)
                                 or t.created_by = (select auth.uid())
                                 or (t.organization_id, t.id) in (select r.organization_id, r.id from app.deputy_readable('task_open') r))));
  end if;
end;
$$;

create or replace trigger task_checklist_items_touch before update on public.task_checklist_items
  for each row execute function app.touch_row();

-- When and by whom a step was ticked; cleared when it is unticked
create or replace function app.task_checklist_items_done() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at := now();
    new.done_by := auth.uid();
  elsif not new.done then
    new.done_at := null;
    new.done_by := null;
  else
    new.done_at := old.done_at;
    new.done_by := old.done_by;
  end if;
  return new;
end;
$$;
revoke all on function app.task_checklist_items_done() from public, anon, authenticated;

create or replace trigger task_checklist_items_done before insert or update on public.task_checklist_items
  for each row execute function app.task_checklist_items_done();

-- At most 100 steps in a task. AFTER the insert, so only a row RLS let in is counted; a lock per task, and the count
-- runs with a fresh snapshot after it, so two inserts at once cannot both pass.
create or replace function app.task_checklist_items_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('task_checklist:' || new.task_id::text, 0));
  if (select count(*) from public.task_checklist_items i
       where i.organization_id = new.organization_id and i.task_id = new.task_id) > 100 then
    raise exception 'at most 100 steps in a task' using errcode = 'P0001', hint = 'task_checklist:max';
  end if;
  return null;
end;
$$;
revoke all on function app.task_checklist_items_cap() from public, anon, authenticated;

create or replace trigger task_checklist_items_cap after insert on public.task_checklist_items
  for each row execute function app.task_checklist_items_cap();

-- A recurring task's next occurrence gets the same steps, unticked
create or replace function app.task_checklist_carry() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.task_checklist_items (organization_id, task_id, title, position, created_by)
  select i.organization_id, new.id, i.title, i.position, i.created_by
    from public.task_checklist_items i
   where i.organization_id = new.organization_id and i.task_id = new.recurrence_source_id
     and not exists (select 1 from public.task_checklist_items x where x.organization_id = new.organization_id and x.task_id = new.id)
   order by i.position, i.created_at, i.id;
  return null;
end;
$$;
revoke all on function app.task_checklist_carry() from public, anon, authenticated;

create or replace trigger tasks_checklist_carry after insert on public.tasks
  for each row when (new.recurrence_source_id is not null)
  execute function app.task_checklist_carry();

-- ----------------------------------------------------------------------------
-- Checklist templates (managed list)
-- ----------------------------------------------------------------------------
create or replace function app.checklist_steps_ok(p_steps text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(cardinality(p_steps), 0) between 1 and 50
     and not exists (select 1 from unnest(p_steps) s where s is null or s <> btrim(s) or char_length(s) not between 1 and 200)
$$;
revoke all on function app.checklist_steps_ok(text[]) from public, anon;
grant execute on function app.checklist_steps_ok(text[]) to authenticated, service_role;

create table if not exists public.checklist_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  steps           text[] not null check (app.checklist_steps_ok(steps)),
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index if not exists checklist_templates_name_idx on public.checklist_templates (organization_id, lower(name));

alter table public.checklist_templates enable row level security;
revoke all on public.checklist_templates from anon, authenticated;
grant select, delete on public.checklist_templates to authenticated;
grant insert (organization_id, name, steps, position) on public.checklist_templates to authenticated;
grant update (name, steps, position) on public.checklist_templates to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'checklist_templates' and policyname = 'checklist_templates_select') then
    create policy checklist_templates_select on public.checklist_templates for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'checklist_templates' and policyname = 'checklist_templates_insert') then
    create policy checklist_templates_insert on public.checklist_templates for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'checklist_templates' and policyname = 'checklist_templates_update') then
    create policy checklist_templates_update on public.checklist_templates for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'checklist_templates' and policyname = 'checklist_templates_delete') then
    create policy checklist_templates_delete on public.checklist_templates for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger checklist_templates_touch before update on public.checklist_templates
  for each row execute function app.touch_row();
create or replace trigger checklist_templates_audit after insert or update or delete on public.checklist_templates
  for each row execute function app.audit_row();

create or replace function app.checklist_templates_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider gets RLS's plain refusal and learns nothing about the organization
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checklist_templates:' || new.organization_id::text, 0));
  if (select count(*) from public.checklist_templates t where t.organization_id = new.organization_id) >= 50 then
    raise exception 'too many checklist templates' using errcode = 'P0001', hint = 'checklist_templates:max';
  end if;
  return new;
end;
$$;
revoke all on function app.checklist_templates_cap() from public, anon, authenticated;

create or replace trigger checklist_templates_cap before insert on public.checklist_templates
  for each row execute function app.checklist_templates_cap();

-- Defaults: an organization starts with these and renames, changes or deletes them
create or replace function app.seed_checklist_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.checklist_templates (organization_id, name, steps, position)
  select p_org, d.name, d.steps, d.pos
    from (values
      ('קליטת לקוח', array['שיחת היכרות ותיאום ציפיות', 'שליחת הסכם או הצעה חתומה', 'קבלת פרטי חיוב',
                          'פתיחת הלקוח במערכות ובכלים', 'שיחת מעקב אחרי שבוע'], 0),
      ('הכנה לפגישה', array['בדיקת ההיסטוריה עם הלקוח', 'הכנת הצעה או מצגת', 'אישור מועד ומקום',
                           'שליחת תזכורת ללקוח'], 1)
    ) as d(name, steps, pos)
   where not exists (select 1 from public.checklist_templates t where t.organization_id = p_org)
   order by d.pos;
end;
$$;
revoke all on function app.seed_checklist_templates(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_checklist_templates() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_checklist_templates(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_checklist_templates() from public, anon, authenticated;

create or replace trigger organizations_seed_checklist_templates after insert on public.organizations
  for each row execute function app.organizations_seed_checklist_templates();

-- existing organizations whose list is empty (managed lists rule)
select app.seed_checklist_templates(o.id) from public.organizations o;

-- Sample data (USR-04): a sample task with steps, or a sample record whose task has steps, is kept. The body of 020150
-- (SEG-01) with the step checks.
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    -- TASK-06: a sample task a person gave steps to is real work
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id);
  end if;
  -- notes, files and meetings are never sample data
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task, or one a person gave steps to (TASK-06; removing the record would
  -- take such a task with it)
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and (not app.sample_pristine($1, ''task'', t.id)
                          or exists (select 1 from public.task_checklist_items i
                                      where i.organization_id = t.organization_id and i.task_id = t.id)))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id);
  end if;
end;
$$;

revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
