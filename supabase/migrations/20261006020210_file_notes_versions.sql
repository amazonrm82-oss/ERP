-- =============================================================================
-- Files on a note, and versions of a file (REC-07)
-- =============================================================================
-- * files.activity_id: a file may be attached to a timeline entry of the same record (composite foreign key; the
--   file goes with the entry when the entry is deleted, and its object is queued for the nightly cleanup like any
--   deleted file). From the browser only the entry's author attaches, to an entry a person logged (not a system
--   entry), on the same record (hint 'file:note'). A file on a note is seen only by whoever sees the note: the
--   files policies ask the activities policies, so a private note's files stay with the note (GAP-05), and Storage
--   follows public.files as before.
-- * files.previous_id: a new version of a file (same record, same note or none). A version is added by whoever may
--   add a file to the record and reads the earlier one; each file has at most one newer version (hint
--   'file:version_taken' when someone added one first; a deferred unique constraint catches a race as 23505).
--   Deleting a version links the newer one to the nearest earlier version that is kept, so the history stays one
--   line (also when one statement deletes several versions, a whole note or a whole business). Every version is a
--   file of its own: it counts against the plan's storage and keeps its own uploader and date.
-- * Both columns are written once, on insert (the table has no client update grant).
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.files add column if not exists activity_id uuid;
alter table public.files add column if not exists previous_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_activity_fk') then
    alter table public.files add constraint files_activity_fk
      foreign key (organization_id, activity_id) references public.activities (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_previous_fk') then
    alter table public.files add constraint files_previous_fk
      foreign key (organization_id, previous_id) references public.files (organization_id, id) on delete set null (previous_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_one_newer') then
    alter table public.files add constraint files_one_newer unique (previous_id) deferrable initially deferred;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_not_own_version') then
    alter table public.files add constraint files_not_own_version check (previous_id is null or previous_id <> id);
  end if;
end;
$$;

create index if not exists files_activity_idx on public.files (organization_id, activity_id) where activity_id is not null;

grant insert (activity_id, previous_id) on public.files to authenticated;

-- A file on a note is seen, added and removed only by whoever sees the note (the sub-select runs under the
-- activities policies). Every policy repeats it, so a DELETE with no WHERE reaches no hidden file.
alter policy files_select on public.files
  using (app.is_member(organization_id) and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
         and (activity_id is null
              or exists (select 1 from public.activities a
                          where a.organization_id = files.organization_id and a.id = files.activity_id)));
alter policy files_insert on public.files
  with check (app.can_write(organization_id) and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
              and uploaded_by = (select auth.uid())
              and (activity_id is null
                   or exists (select 1 from public.activities a
                               where a.organization_id = files.organization_id and a.id = files.activity_id)));
alter policy files_delete on public.files
  using (app.can_write(organization_id) and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
         and (uploaded_by = (select auth.uid()) or app.is_admin(organization_id))
         and (activity_id is null
              or exists (select 1 from public.activities a
                          where a.organization_id = files.organization_id and a.id = files.activity_id)));

-- The note and the earlier version must belong to the same record. Security invoker: a person's insert reads the
-- note and the earlier version under RLS (current_user tells a person's write from the server's).
create or replace function app.files_links_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_note public.activities;
  v_prev public.files;
  v_person boolean := current_user in ('authenticated', 'anon');
begin
  -- a person who may not write here gets RLS's plain refusal right after
  if v_person and not app.can_write(new.organization_id) then
    return new;
  end if;
  if new.activity_id is not null then
    select * into v_note from public.activities a where a.organization_id = new.organization_id and a.id = new.activity_id;
    if not found
       or v_note.lead_id is distinct from new.lead_id or v_note.contact_id is distinct from new.contact_id
       or v_note.company_id is distinct from new.company_id or v_note.deal_id is distinct from new.deal_id
       or (v_person and (v_note.type not in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
                         or v_note.created_by is distinct from auth.uid())) then
      raise exception 'a file is attached only to an entry of the same record, by its author'
        using errcode = 'P0001', hint = 'file:note';
    end if;
  end if;
  if new.previous_id is not null then
    select * into v_prev from public.files f where f.organization_id = new.organization_id and f.id = new.previous_id;
    if not found
       or v_prev.lead_id is distinct from new.lead_id or v_prev.contact_id is distinct from new.contact_id
       or v_prev.company_id is distinct from new.company_id or v_prev.deal_id is distinct from new.deal_id
       or v_prev.activity_id is distinct from new.activity_id then
      raise exception 'a new version belongs to the same record and note as the earlier one'
        using errcode = 'P0001', hint = 'file:version';
    end if;
    if exists (select 1 from public.files f where f.previous_id = new.previous_id) then
      raise exception 'this file already has a newer version' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.files_links_check() from public, anon;
grant execute on function app.files_links_check() to authenticated, service_role;

create or replace trigger files_links_check before insert on public.files
  for each row execute function app.files_links_check();

-- Deleting a version keeps the history in one line: the newer version now follows the nearest earlier version that
-- survives. This runs AFTER the delete, never before it: a BEFORE trigger that updates the newer version breaks a
-- statement that deletes that version too (27000, a row the command already changed), which is what deleting a note
-- with versions on it, or a whole business, does. By then every row the statement deletes is gone, so an update
-- touches only survivors, and the deleted rows (the transition table) let the walk skip earlier versions removed in
-- the same statement. Named "A_..." so that, among the AFTER triggers of each row, it runs before the foreign key's
-- own "RI_ConstraintTrigger_..." (set null), which then finds nothing left pointing at the deleted row.
-- Security definer: the newer version may be a file the deleter cannot see (another uploader's, same record).
create or replace function app.files_relink_versions() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev uuid := old.previous_id;
  v_steps integer := 0;
begin
  -- nothing newer survives (the common case, and every row of a deleted business): nothing to do
  if not exists (select 1 from public.files f where f.organization_id = old.organization_id and f.previous_id = old.id) then
    return null;
  end if;
  -- the nearest earlier version this statement keeps
  while v_prev is not null and v_steps < 1000 loop
    exit when not exists (select 1 from gone g where g.id = v_prev);
    select g.previous_id into v_prev from gone g where g.id = v_prev;
    v_steps := v_steps + 1;
  end loop;
  update public.files f
     set previous_id = v_prev
   where f.organization_id = old.organization_id and f.previous_id = old.id;
  return null;
end;
$$;
revoke all on function app.files_relink_versions() from public, anon, authenticated;

create or replace trigger "A_files_relink_versions" after delete on public.files
  referencing old table as gone
  for each row execute function app.files_relink_versions();

notify pgrst, 'reload schema';
