-- =============================================================================
-- A task may link only records the user can see (RVW-10)
-- =============================================================================
-- * Until now tasks_insert and tasks_update checked only app.can_write(), so a
--   member who knew the id of a lead, contact, company or deal they cannot see
--   could hang a task on it. 0060 closed this for activities; meetings check it
--   in app.meetings_check_links(). Tasks follow the same rule now.
-- * Insert: tasks_insert also asks app.can_read_task_links(): every record the
--   new task links must be visible to the caller. A task with no link is fine.
-- * Update: only a link that is set or changed is checked, by the trigger
--   tasks_check_links (like meetings_check_links). A WITH CHECK on every link
--   would be wrong here: a manager may hand a member a task on the manager's own
--   lead (tasks_insert: "any writer may hand a task to a colleague"), and with
--   'own' visibility the member cannot see that lead, yet must still be able to
--   complete, snooze or edit the task. The policy cannot see OLD, the trigger can.
--   Everything tasks_insert / tasks_update checked before stays as it was.
-- * Server-side writers (automations, recurring tasks, convert_lead,
--   transfer_records, merge, purge) are security definer or run as the table
--   owner: they bypass RLS, and the trigger skips any role but
--   authenticated/anon. The app's task forms link only the record of the page
--   (which the user sees) and never change a link on update.
-- Every statement is safe to run twice.

create or replace function app.can_read_task_links(
  p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid
) returns boolean
language sql stable
set search_path = ''
as $$
  -- SECURITY INVOKER on purpose: each sub-select is filtered by the caller's own
  -- select policies, so "can see" means exactly what it means on the record's page.
  -- Unlike app.can_read_every_activity_subject(), no link at all is allowed.
  select (p_lead is null or exists (select 1 from public.leads l where l.id = p_lead))
     and (p_contact is null or exists (select 1 from public.contacts c where c.id = p_contact))
     and (p_company is null or exists (select 1 from public.companies co where co.id = p_company))
     and (p_deal is null or exists (select 1 from public.deals d where d.id = p_deal))
$$;
revoke all on function app.can_read_task_links(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.can_read_task_links(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- alter policy: the policy exists since 0004 (rls.sql)
alter policy tasks_insert on public.tasks
  with check (app.can_write(organization_id)
              and app.can_read_task_links(lead_id, contact_id, company_id, deal_id));

-- SECURITY INVOKER: it tells a browser write from a server write by current_user,
-- and app.can_read_task_links() must run with the caller's rights.
create or replace function app.tasks_check_links() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- only the links this update sets or changes; an unchanged link stays even when
  -- the caller cannot see its record
  if not app.can_read_task_links(
       case when new.lead_id is distinct from old.lead_id then new.lead_id end,
       case when new.contact_id is distinct from old.contact_id then new.contact_id end,
       case when new.company_id is distinct from old.company_id then new.company_id end,
       case when new.deal_id is distinct from old.deal_id then new.deal_id end) then
    raise exception 'task linked to a record the user cannot see' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.tasks_check_links() from public, anon, authenticated;

create or replace trigger tasks_check_links
  before update of lead_id, contact_id, company_id, deal_id on public.tasks
  for each row execute function app.tasks_check_links();
