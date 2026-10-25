-- =============================================================================
-- 020845 Sub-tasks (TASK-06 part B)
-- =============================================================================
-- Owner, 25 October 2026 (answer (ב), small version): a sub-task is an ordinary task with parent_task_id, one level
-- only; it takes the parent's record link; owner, date, reminders, My day, team, lists and export as any task, with a
-- "משימת אב" column. The parent's card shows "הושלמו N מתוך M". Completing a parent with open sub-tasks asks and never
-- blocks (app only: the database refuses nothing). Removing the parent takes its sub-tasks to the bin with it and
-- restoring it brings them all back. A recurring task does not copy its sub-tasks. The checklist stays.
--
-- * tasks.parent_task_id: composite FK (organization_id, parent_task_id) to tasks, so a parent is always of the same
--   business; ON DELETE SET NULL of the column only (a purge that removes a parent leaves a sub-task restored on its
--   own as a plain task; a purge of the bin removes the parent and its sub-tasks together, as they share deleted_at).
--   Full index (test 130). Clients get INSERT and UPDATE grants (owner, 25 October 2026, answer (3) ב): a person makes a
--   sub-task, or picks a parent for an existing task from its edit form, or detaches it. Detaching leaves a plain task that
--   keeps the links it has and its own deleted_at; it may then get its links edited like any task.
-- * Trigger tasks_parent_check (invoker: it reads the parent with the caller's rights and tells a person's write by
--   current_user) for every writer:
--     - one level: a parent may not itself be a sub-task, and a task with sub-tasks may not become one
--       (hint task:subtask_depth);
--     - the parent must exist in the business, be readable and not removed (42501 hint task:parent);
--     - a person needs the right to update the parent (the tasks_update rule of 018700, keep in step:
--       app.task_parent_writable) in a writable business (42501 hint task:parent);
--     - a sub-task does not repeat (hint task:subtask_recurrence): spawn_recurring_task makes the next task with no
--       parent, and a repeating sub-task would leave its parent's count; a recurring PARENT is fine and its next
--       occurrence starts without sub-tasks (app.spawn_recurring_task lists its columns and copies none of them);
--     - the record links (lead, contact, company, deal) are copied from the parent on insert and whenever the parent
--       changes (linking an existing task moves it to the parent's record; the edit form warns first); a person may not
--       change a sub-task's links on their own (hint task:subtask_links);
--     - linking an existing task that repeats is refused (task:subtask_recurrence): the edit form asks to clear the
--       repeat first, nothing is cleared silently;
--     - every change to a parent link takes an advisory lock per business, so two links made at once cannot build two
--       levels (A under B while B goes under C).
-- * tasks_insert (last altered in 007400) also lets a person add a sub-task whose links equal the parent's while they
--   may update that parent (app.subtask_parent_ok), even when they cannot read the linked record: a member handed a
--   task on a manager's own lead may split it. Every other insert is checked as before. Linking an existing task keeps
--   the same rule (lead's decision): the person may update the task (RLS) and may update the parent; nothing more.
-- * A call-back task of a lead (SPD-01, app.intake_callback_tasks) is kept out of families both ways (hint
--   task:subtask_callback): it is neither linked under a parent nor made a parent. It is a server's task: its owner follows
--   the lead's owner silently, team rules skip it, take_task refuses it; a family around it would split one piece of work
--   between owners the call-back rules move and owners they do not.
-- * One family, one record (trigger tasks_family_links, definer, after any change of the links): a parent's change
--   reaches its sub-tasks, and a server write that moves a sub-task on its own (convert_lead moves open tasks only, so an
--   open sub-task of a done parent; or any later server path) carries its parent there, and the parent carries the
--   siblings. A person cannot move a sub-task alone (task:subtask_links), so this only ever runs for server writes. It
--   compares before it writes, and an AFTER row trigger sees the whole statement, so one statement that moves the family
--   together (a merge, a foreign key's set-null on purge) changes nothing more.
-- * The bin: trigger tasks_subtasks_bin (definer). Removing a parent (deleted_at set) removes its live sub-tasks with
--   the same time and marks them (tasks.binned_with_parent, server only); restoring it restores only the marked ones;
--   changing a removed parent's time moves the marked ones' time with it (they are purged together). Any other change of
--   a sub-task's deleted_at, and any change of its parent, clears its mark (trigger tasks_bin_mark), so a sub-task removed
--   on its own never comes back with the parent, whatever times are written. Tasks have no bin screen: removal happens
--   through import undo (and the database's own paths); the rule holds for every writer.
-- * app.sample_untouched and app.import_record_worked (the bodies of 020680, one line each added): a sub-task a person
--   added keeps a sample task, and makes an imported task "worked on". public.undo_import (the body of 020220, one
--   check added) refuses while an imported task has a live sub-task (hint import_undo:subtasks, the count in the detail),
--   instead of taking the sub-tasks a person made to the bin with it; one only in the bin does not block.
-- * Nothing else needed: merge moves tasks by their link columns (parent and sub-tasks together), erasure, the full
--   export (select *), the person export (tasks by link) and purge_links (tasks by link) treat a sub-task as a task.
-- No drop statement, no delete statement. Safe to run twice.

alter table public.tasks add column if not exists parent_task_id uuid;
-- server only (no client grant): true on a sub-task the bin took with its parent; restoring the parent brings back these
alter table public.tasks add column if not exists binned_with_parent boolean;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_parent_fk' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_parent_fk foreign key (organization_id, parent_task_id)
      references public.tasks (organization_id, id) on delete set null (parent_task_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_parent_not_self' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_parent_not_self check (parent_task_id is distinct from id);
  end if;
end;
$$;

create index if not exists tasks_parent_idx on public.tasks (organization_id, parent_task_id);

-- tasks has column-level grants (TASK-04): a sub-task is made as one, or linked and detached from the edit form
grant insert (parent_task_id), update (parent_task_id) on public.tasks to authenticated;

-- ----------------------------------------------------------------------------
-- Rights on the parent
-- ----------------------------------------------------------------------------
-- The tasks_update USING rule (018700) for one task row: keep the two in step. Definer, because the deputy rule reads
-- app tables; it answers only for the caller (auth.uid()).
create or replace function app.task_parent_writable(p_org uuid, p_id uuid, p_owner uuid, p_team uuid, p_created_by uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.can_write(p_org)
     and (app.can_edit_record(p_org, p_owner, p_team)
          or p_created_by = auth.uid()
          or (p_org, p_id) in (select r.organization_id, r.id from app.deputy_readable('task_open') r))
$$;
revoke all on function app.task_parent_writable(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.task_parent_writable(uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- For tasks_insert: the parent is a live top-level task of the business that the caller may update, and the new row
-- carries exactly its links (the trigger copied them).
create or replace function app.subtask_parent_ok(p_org uuid, p_parent uuid, p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tasks p
     where p.organization_id = p_org and p.id = p_parent
       and p.parent_task_id is null and p.deleted_at is null
       and p.lead_id is not distinct from p_lead and p.contact_id is not distinct from p_contact
       and p.company_id is not distinct from p_company and p.deal_id is not distinct from p_deal
       and app.task_parent_writable(p.organization_id, p.id, p.owner_id, p.team_id, p.created_by))
$$;
revoke all on function app.subtask_parent_ok(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.subtask_parent_ok(uuid, uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- Whether a task has sub-tasks, whoever may read them; a person learns it only for a business they belong to (the
-- server, with no session, always)
create or replace function app.task_has_subtasks(p_org uuid, p_id uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (auth.uid() is null or app.is_member(p_org))
     and exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id)
$$;
revoke all on function app.task_has_subtasks(uuid, uuid) from public, anon;
grant execute on function app.task_has_subtasks(uuid, uuid) to authenticated, service_role;

-- For import undo: how many live tasks of an import have a live sub-task (one only in the bin does not count; nothing
-- would go to the bin with it). Same guard.
create or replace function app.import_tasks_with_subtasks(p_org uuid, p_job uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::int from public.tasks t
   where (auth.uid() is null or app.is_member(p_org))
     and t.organization_id = p_org and t.import_job_id = p_job and t.deleted_at is null
     and exists (select 1 from public.tasks c
                  where c.organization_id = p_org and c.parent_task_id = t.id and c.deleted_at is null)
$$;
revoke all on function app.import_tasks_with_subtasks(uuid, uuid) from public, anon;
grant execute on function app.import_tasks_with_subtasks(uuid, uuid) to authenticated, service_role;

-- Whether a task is a lead's call-back task (SPD-01); the same guard
create or replace function app.task_is_callback(p_org uuid, p_id uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (auth.uid() is null or app.is_member(p_org))
     and exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = p_org and ct.task_id = p_id)
$$;
revoke all on function app.task_is_callback(uuid, uuid) from public, anon;
grant execute on function app.task_is_callback(uuid, uuid) to authenticated, service_role;

alter policy tasks_insert on public.tasks
  with check (app.can_write(organization_id)
              and (app.can_read_task_links(lead_id, contact_id, company_id, deal_id)
                   or (parent_task_id is not null
                       and app.subtask_parent_ok(organization_id, parent_task_id, lead_id, contact_id, company_id, deal_id))));

-- ----------------------------------------------------------------------------
-- One level, the parent's rights, its links, no repeat
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER: a person reads the parent with their own rights (a parent they cannot see is "not found"), and
-- current_user tells a person's write from a server's.
create or replace function app.tasks_parent_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_person boolean := current_user in ('authenticated', 'anon');
  v_parent record;
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.parent_task_id is not null;
  else
    v_changed := new.parent_task_id is distinct from old.parent_task_id;
  end if;

  if tg_op = 'UPDATE' and new.parent_task_id is distinct from old.parent_task_id then
    -- a new parent (or none): a mark of the old parent's bin no longer applies
    new.binned_with_parent := null;
  end if;

  if new.parent_task_id is null then
    return new;
  end if;

  if v_changed then
    -- one level, also when two links are made at once. The checks below run after the lock and rely on READ COMMITTED
    -- (each statement of this function takes a fresh snapshot, so it sees a link committed while it waited); under
    -- REPEATABLE READ or SERIALIZABLE the snapshot is the transaction's and the depth check could miss it.
    perform pg_advisory_xact_lock(hashtextextended('task_parent:' || new.organization_id::text, 0));
    if tg_op = 'UPDATE' and app.task_is_callback(new.organization_id, new.id) then
      raise exception 'a call-back task is not a sub-task' using errcode = 'P0001', hint = 'task:subtask_callback';
    end if;
    if tg_op = 'UPDATE' and app.task_has_subtasks(new.organization_id, new.id) then
      raise exception 'a task with sub-tasks cannot become a sub-task' using errcode = 'P0001', hint = 'task:subtask_depth';
    end if;
    select p.id, p.parent_task_id, p.deleted_at, p.owner_id, p.team_id, p.created_by,
           p.lead_id, p.contact_id, p.company_id, p.deal_id
      into v_parent
      from public.tasks p
     where p.organization_id = new.organization_id and p.id = new.parent_task_id;
    if not found or v_parent.deleted_at is not null then
      raise exception 'parent task not found' using errcode = '42501', hint = 'task:parent';
    end if;
    if v_parent.parent_task_id is not null then
      raise exception 'a sub-task cannot have sub-tasks' using errcode = 'P0001', hint = 'task:subtask_depth';
    end if;
    -- asked only of a parent the caller can see
    if app.task_is_callback(new.organization_id, v_parent.id) then
      raise exception 'a call-back task has no sub-tasks' using errcode = 'P0001', hint = 'task:subtask_callback';
    end if;
    if v_person and not app.task_parent_writable(new.organization_id, v_parent.id, v_parent.owner_id, v_parent.team_id, v_parent.created_by) then
      raise exception 'not allowed to add a sub-task to this task' using errcode = '42501', hint = 'task:parent';
    end if;
    new.lead_id := v_parent.lead_id;
    new.contact_id := v_parent.contact_id;
    new.company_id := v_parent.company_id;
    new.deal_id := v_parent.deal_id;
  elsif v_person
        and (new.lead_id is distinct from old.lead_id or new.contact_id is distinct from old.contact_id
             or new.company_id is distinct from old.company_id or new.deal_id is distinct from old.deal_id) then
    raise exception 'a sub-task follows its parent''s record' using errcode = 'P0001', hint = 'task:subtask_links';
  end if;

  if new.recurrence is not null then
    raise exception 'a sub-task does not repeat' using errcode = 'P0001', hint = 'task:subtask_recurrence';
  end if;
  return new;
end;
$$;
revoke all on function app.tasks_parent_check() from public, anon, authenticated;

create or replace trigger tasks_parent_check
  before insert or update of parent_task_id, recurrence, lead_id, contact_id, company_id, deal_id on public.tasks
  for each row execute function app.tasks_parent_check();

-- ----------------------------------------------------------------------------
-- One family, one record
-- ----------------------------------------------------------------------------
-- After any change of a task's links: a parent's links reach its sub-tasks; a sub-task a server write moved alone
-- carries its parent there (and the parent's own firing carries the siblings). Compared before written, and an AFTER row
-- trigger sees the whole statement, so a statement that moved the family together writes nothing more.
create or replace function app.tasks_family_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.parent_task_id is null then
    update public.tasks c
       set lead_id = new.lead_id, contact_id = new.contact_id, company_id = new.company_id, deal_id = new.deal_id
     where c.organization_id = new.organization_id and c.parent_task_id = new.id
       and (c.lead_id is distinct from new.lead_id or c.contact_id is distinct from new.contact_id
            or c.company_id is distinct from new.company_id or c.deal_id is distinct from new.deal_id);
  else
    update public.tasks p
       set lead_id = new.lead_id, contact_id = new.contact_id, company_id = new.company_id, deal_id = new.deal_id
     where p.organization_id = new.organization_id and p.id = new.parent_task_id
       and (p.lead_id is distinct from new.lead_id or p.contact_id is distinct from new.contact_id
            or p.company_id is distinct from new.company_id or p.deal_id is distinct from new.deal_id);
  end if;
  return null;
end;
$$;
revoke all on function app.tasks_family_links() from public, anon, authenticated;

create or replace trigger tasks_family_links
  after update of lead_id, contact_id, company_id, deal_id on public.tasks
  for each row
  when ((new.lead_id is distinct from old.lead_id or new.contact_id is distinct from old.contact_id
             or new.company_id is distinct from old.company_id or new.deal_id is distinct from old.deal_id))
  execute function app.tasks_family_links();

-- ----------------------------------------------------------------------------
-- The bin: sub-tasks go and come back with their parent
-- ----------------------------------------------------------------------------
-- Any change of a task's deleted_at clears its mark, except the bin trigger's own writes (a server setting honoured only
-- outside a person's session). Invoker: current_user tells the two apart.
create or replace function app.tasks_bin_mark() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
     and not (current_user not in ('authenticated', 'anon')
              and coalesce(current_setting('app.task_family_bin', true), '') = 'on') then
    new.binned_with_parent := null;
  end if;
  return new;
end;
$$;
revoke all on function app.tasks_bin_mark() from public, anon, authenticated;

create or replace trigger tasks_bin_mark
  before update of deleted_at on public.tasks
  for each row
  when (old.binned_with_parent is not null)
  execute function app.tasks_bin_mark();

create or replace function app.tasks_subtasks_bin() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev text := current_setting('app.task_family_bin', true);
begin
  perform set_config('app.task_family_bin', 'on', true);
  if old.deleted_at is null then
    -- removed: its live sub-tasks go with it, marked
    update public.tasks c set deleted_at = new.deleted_at, binned_with_parent = true
     where c.organization_id = new.organization_id and c.parent_task_id = new.id and c.deleted_at is null;
  elsif new.deleted_at is null then
    -- restored: only those that went with it; one removed on its own stays removed
    update public.tasks c set deleted_at = null, binned_with_parent = null
     where c.organization_id = new.organization_id and c.parent_task_id = new.id
       and c.binned_with_parent and c.deleted_at is not null;
  else
    -- a removed parent's time changed: those that went with it keep its time (they are purged together)
    update public.tasks c set deleted_at = new.deleted_at
     where c.organization_id = new.organization_id and c.parent_task_id = new.id
       and c.binned_with_parent and c.deleted_at is not null and c.deleted_at is distinct from new.deleted_at;
  end if;
  perform set_config('app.task_family_bin', coalesce(v_prev, ''), true);
  return null;
end;
$$;
revoke all on function app.tasks_subtasks_bin() from public, anon, authenticated;

create or replace trigger tasks_subtasks_bin
  after update of deleted_at on public.tasks
  for each row
  when (new.parent_task_id is null and old.deleted_at is distinct from new.deleted_at)
  execute function app.tasks_subtasks_bin();

-- ----------------------------------------------------------------------------
-- Sample data and import undo: a sub-task is real work (the bodies of 020680, one condition added)
-- ----------------------------------------------------------------------------
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
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id)
       -- TASK-06 part B: a sub-task a person added under it (sample data makes none)
       and not exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
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
       -- ORD-01: sample data makes no orders; one made is real work
       and not exists (select 1 from public.orders od where od.organization_id = p_org and p_id in (od.contact_id, od.delivery_contact_id))
       -- DOC-01: sample data records no documents; one recorded is real work
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.contact_id = p_id)
       -- PAY-01: sample data records no payments; one recorded is real work
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.contact_id = p_id)
       -- COL-05: sample data holds nobody; a hold set is real work
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.contact_id = p_id)
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
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.company_id = p_id)
       -- COL-05
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.deal_id = p_id)
       -- DOC-01
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.deal_id = p_id)
       -- PAY-01
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.deal_id = p_id);
  end if;
end;
$$;

revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

create or replace function app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamptz, p_job uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- RVW-36: an imported task is worked on when a checklist step was added after the import or any step is done
  if p_type = 'task' then
    return exists (select 1 from public.task_checklist_items x
                    where x.organization_id = p_org and x.task_id = p_id
                      and (x.created_at > p_since or x.done_at is not null))
        -- TASK-06 part B: a sub-task added under it (an import makes none)
        or exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- no other records are linked to an imported task; its own row and its steps are the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        -- ORD-01: an order is always made after the import
        or exists (select 1 from public.orders x where x.organization_id = p_org and p_id in (x.contact_id, x.delivery_contact_id))
        -- DOC-01: a document is always recorded after the import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.contact_id = p_id)
        -- PAY-01: a payment is always recorded after the import
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.contact_id = p_id)
        -- COL-05: a hold is always set after the import
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job));
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Import undo: refused while an imported task has a live sub-task (the body of 020220, one check added)
-- ----------------------------------------------------------------------------
create or replace function public.undo_import(p_org uuid, p_job uuid) returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_job public.import_jobs;
  v_table text;
  v_done integer := 0;
  v_n integer;
  v_left integer;
  v_movable integer;
begin
  -- the caller's own import (RLS: import_jobs_update), locked so two undos do not run together
  select * into v_job from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid()
     for update;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if v_job.status not in ('done', 'failed') then
    raise exception 'the import is not finished or already undone' using errcode = '22023', hint = 'import_undo:status';
  end if;
  v_table := case v_job.entity_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                    when 'deal' then 'deals' when 'task' then 'tasks' end;
  if v_table is null then
    raise exception 'this import cannot be undone here' using errcode = '22023', hint = 'import_undo:type';
  end if;
  if v_job.created_at < now() - interval '7 days' then
    raise exception 'an import can be undone only in its first 7 days' using errcode = '22023', hint = 'import_undo:expired';
  end if;

  -- first, whether every live record of the import is the caller's to move to the recycle bin (app.can_delete_record,
  -- the rule guard_soft_delete applies): one they may edit but not delete would otherwise stop the update with a
  -- plain 42501, and one they cannot see at all is counted by app.import_rows_left
  -- TASK-06 part B: an imported task with a live sub-task is worked on (app.import_record_worked); undoing it would take
  -- the sub-tasks a person made to the bin with it, so the undo is refused and says why
  if v_table = 'tasks' then
    v_n := app.import_tasks_with_subtasks(p_org, p_job);
    if v_n > 0 then
      raise exception 'some imported tasks have sub-tasks' using errcode = 'P0001',
        hint = 'import_undo:subtasks', detail = v_n::text;
    end if;
  end if;

  v_left := app.import_rows_left(p_org, p_job);
  execute format(
    'select count(*)::int from public.%I t
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null
        and app.can_delete_record(t.organization_id, t.owner_id, t.team_id)', v_table)
    into v_movable using p_org, p_job;
  if coalesce(v_left, 0) > v_movable then
    raise exception 'some records of this import can no longer be changed by you' using errcode = 'P0001',
      hint = 'import_undo:left', detail = (v_left - v_movable)::text;
  end if;

  execute format(
    'update public.%I t set deleted_at = now()
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null', v_table)
    using p_org, p_job;
  get diagnostics v_done = row_count;

  if v_job.entity_type = 'contact' then
    -- the companies it made that no live contact uses (one from outside this import keeps it)
    update public.companies c set deleted_at = now()
     where c.organization_id = p_org and c.import_job_id = p_job and c.deleted_at is null
       -- one the caller may not delete stays (a company is never counted as left)
       and app.can_delete_record(c.organization_id, c.owner_id, c.team_id)
       and not exists (select 1 from public.contacts k
                        where k.organization_id = p_org and k.company_id = c.id and k.deleted_at is null);
    get diagnostics v_n = row_count;
    v_done := v_done + v_n;
  end if;

  -- a record RLS still kept from the update (it answers no error) stays: then nothing is undone
  v_left := app.import_rows_left(p_org, p_job);
  if coalesce(v_left, 0) > 0 then
    raise exception 'some records of this import can no longer be changed by you' using errcode = 'P0001',
      hint = 'import_undo:left', detail = v_left::text;
  end if;

  update public.import_jobs j set status = 'undone', undone_at = now()
   where j.organization_id = p_org and j.id = p_job;
  return jsonb_build_object('done', v_done);
end;
$$;
revoke all on function public.undo_import(uuid, uuid) from public, anon;
grant execute on function public.undo_import(uuid, uuid) to authenticated;
