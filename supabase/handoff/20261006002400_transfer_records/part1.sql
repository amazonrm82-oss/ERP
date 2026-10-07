-- 20261006002400_transfer_records: part 1 of 2. Run the parts in order.
-- =============================================================================
-- 0024 Handing a person's records to someone else
-- =============================================================================
-- public.transfer_records(org, from, to): when someone leaves or goes on long
-- leave, an owner or admin moves everything they own to another user: leads,
-- contacts, companies and deals (the recycle bin too) and tasks. Afterwards the
-- person can be removed, which their owned records used to prevent.
-- * The new owner gets one notification with the totals, not one per record
--   (app.notify_assignment skips while 'app.bulk_transfer' is on).
-- * The moves do not start automations: they are marked like the changes an
--   automation makes ('app.automation_running'), which automations skip.
-- * Every row change is in the audit log, as usual.
-- Every statement is safe to run twice.

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
  -- neither is a handover of someone's records (one summary notification instead)
  if current_setting('app.bulk_transfer', true) = 'on' then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  values (new.organization_id, new.owner_id, 'assigned', v_title, v_entity, new.id);
  return null;
end;
$$;
