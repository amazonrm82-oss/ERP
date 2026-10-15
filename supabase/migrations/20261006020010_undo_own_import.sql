-- =============================================================================
-- PRM-01 follow-up: a member with the import permission undoes their own import
-- =============================================================================
-- Owner, 15 October 2026 (DECISIONS.md, PRM-01 question 2): a manager or member who
-- holds the extra permission 'import' may undo an import they ran themselves, within
-- 7 days of starting it. The undo moves to the recycle bin only the records of that
-- import that have not changed since and that nobody has worked on since; the rest stay
-- and are counted.
--
-- Why a function and not a wider guard: the recycle bin is guarded twice for a
-- person's write: app.guard_soft_delete() (app.can_delete_record: owners, admins and
-- team managers) and the update policies of each table (a member edits only what they
-- own, and an import may give records to other owners). Widening both for this case
-- would widen every update path. Instead, public.undo_own_import() (security definer)
-- does exactly this one thing after checking every condition itself; the guard, the
-- policies and every other path stay as they are. Owners, admins and team managers
-- keep undoing as before (the app's existing path, through the guard and RLS).
--
-- "Unchanged" marker: updated_at = created_at. Both default to now() on insert, and
-- now() is the transaction's start time, so everything the import's own chunk does
-- (insert triggers, same-transaction follow-ups) keeps them equal. Every later update,
-- by a person or by the server (an automation, a stamp from a logged call, a merge, a
-- recompute), goes through the BEFORE trigger *_touch (app.touch_row), which sets
-- updated_at = now() of a later transaction. It needs no audit lookup (the audit log
-- skips some columns and has its own retention), and it is the same for all five
-- tables. A record a later chunk of the same import updated (a duplicate row inside the
-- file, mode "update") counts as changed and stays: the safe side.
--
-- Worked-on marker (owner, 15 October 2026): a record someone has worked on since the import
-- counts as changed even when its own row did not change. app.import_record_worked() looks at
-- the link tables app.sample_untouched (0185) checks for real work: timeline entries
-- (activities), tasks, meetings, files, deal lines, further phones and emails (contact_channels),
-- followers, consents, deal contacts, and (owner's review, 15 October 2026) records from
-- outside this import that point at it: deals on a contact or company, contacts and child
-- companies on a company, follow-up deals on a deal, whenever they were linked. A company a
-- contacts import created also stays while a contact of that import that was kept points at it. Other links count only when made AFTER the record: created_at later than the
-- record's own created_at. Entries the import's own transaction wrote at insert time (server
-- triggers, the same chunk) carry the same now() and are left out. A record with such a link
-- stays and is counted in "kept", like an edited one.
--
-- Conditions (all checked here, in this order; anything else is refused):
-- * the job belongs to the organization and to the caller (created_by), else P0002;
-- * the caller holds the grant (app.has_grant(org, 'import'): an active manager or
--   member with the key, plan capability on; not owners/admins, who use the existing
--   path; not viewers or support sessions), and the organization is writable, else 42501;
-- * the job is finished (done or failed), not undone, of a record type with a recycle
--   bin (lead, contact, company, deal, task; products need the catalog rules), and
--   started less than 7 days ago, else 22023 with hint import_undo:status / :type / :expired.
-- Companies a contacts import created go too when unchanged and no live contact from
-- outside that import uses them (the rule of the app's existing undo).
-- The job is marked undone; the answer is {"done": n, "kept": m}.
--
-- Every statement is safe to run twice. No drops, no row removal.

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
  -- an imported task has no records linked to it; its own row is the whole story
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
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job);
  elsif p_type = 'deal' then
    return exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

create or replace function public.undo_own_import(p_org uuid, p_job uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs;
  v_table text;
  v_done integer := 0;
  v_kept integer := 0;
  v_n integer;
begin
  select * into v_job from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job
     for update;
  if not found or v_job.created_by is distinct from auth.uid() then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if not app.has_grant(p_org, 'import') or not app.org_writable(p_org) then
    raise exception 'not allowed to undo this import' using errcode = '42501';
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

  execute format(
    'update public.%I t set deleted_at = now()
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null
        and t.updated_at = t.created_at
        and not app.import_record_worked($1, $3, t.id, t.created_at, $2)', v_table)
    using p_org, p_job, v_job.entity_type;
  get diagnostics v_done = row_count;
  execute format(
    'select count(*)::int from public.%I t
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null', v_table)
    into v_kept using p_org, p_job;

  if v_job.entity_type = 'contact' then
    update public.companies c set deleted_at = now()
     where c.organization_id = p_org and c.import_job_id = p_job and c.deleted_at is null
       and c.updated_at = c.created_at
       and not app.import_record_worked(p_org, 'company', c.id, c.created_at, p_job)
       -- no live contact points at it: one from outside this import, or one of this import that was
       -- kept above (changed or worked on); the contacts are decided first
       and not exists (select 1 from public.contacts k
                        where k.organization_id = p_org and k.company_id = c.id and k.deleted_at is null);
    get diagnostics v_n = row_count;
    v_done := v_done + v_n;
    select v_kept + count(*)::int into v_kept from public.companies c
     where c.organization_id = p_org and c.import_job_id = p_job and c.deleted_at is null;
  end if;

  update public.import_jobs j set status = 'undone', undone_at = now()
   where j.organization_id = p_org and j.id = p_job;
  return jsonb_build_object('done', v_done, 'kept', v_kept);
end;
$$;
revoke all on function public.undo_own_import(uuid, uuid) from public, anon;
grant execute on function public.undo_own_import(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
