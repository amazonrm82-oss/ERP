-- GAP-12 (opening balance), the import undo part: kept in its own file so app.import_record_worked / undo_import /
-- undo_own_import merge against one small file (import_record_worked carries WAB-07's null-safe notes line from 021070
-- unchanged), and a test that re-runs these functions re-runs only this file. Needs 20261006021076_opening_balance.sql
-- (accounting_documents.import_job_id and the undo branch of app.accounting_documents_check). Safe to run twice.

-- ----------------------------------------------------------------------------
-- Undoing an import (the lead's interim decision, 27 October 2026): the job's own active opening balances on the records the
-- undo moves to the recycle bin are cancelled (an owner's or admin's undo only; see app.import_opening_cancel)
-- ("בוטל עם ביטול הייבוא"; the cancel releases their payments and offsets as any cancel does). A balance the import replaced
-- stays cancelled (not restored). The job's own balances and their timeline entries are not "work" on the imported record
-- (app.import_record_worked). Bodies copied from their latest definitions (undo_import, undo_own_import: 020985;
-- import_record_worked: 021070, WAB-07), changed only where marked GAP-12.
-- ----------------------------------------------------------------------------
-- definer: the caller's own undone job (the rule of app.import_consents_cancel); answers how many were cancelled.
-- Only an owner or admin cancels (an opening balance is theirs to record and cancel, document:opening_admin): a manager's or
-- member's undo leaves every balance alone. Only the balances on a contact or company THIS undo moved to the recycle bin
-- (a record of this job binned now, in this transaction) are cancelled; a balance on a record the undo keeps (worked on,
-- or an existing customer an update-mode import wrote to) stays active.
create or replace function app.import_opening_cancel(p_org uuid, p_job uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or p_org is null or p_job is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform 1 from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'undone';
  if not found then
    raise exception 'not an undone import of this user' using errcode = '42501';
  end if;
  if not coalesce(app.is_admin(p_org), false) then
    return 0;
  end if;
  perform set_config('app.document_server', 'undo', true);
  update public.accounting_documents d
     set status = 'cancelled', cancel_reason = 'בוטל עם ביטול הייבוא', cancelled_at = now(), cancelled_by = auth.uid()
   where d.organization_id = p_org and d.import_job_id = p_job and d.doc_type = 'opening_balance' and d.status = 'active'
     and (exists (select 1 from public.contacts c
                   where c.organization_id = p_org and c.id = d.contact_id
                     and c.import_job_id = p_job and c.deleted_at = now())
          or exists (select 1 from public.companies co
                      where co.organization_id = p_org and co.id = d.company_id
                        and co.import_job_id = p_job and co.deleted_at = now()));
  get diagnostics v_count = row_count;
  perform set_config('app.document_server', '', true);
  return v_count;
end;
$$;
revoke all on function app.import_opening_cancel(uuid, uuid) from public, anon;
grant execute on function app.import_opening_cancel(uuid, uuid) to authenticated;

CREATE OR REPLACE FUNCTION app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamp with time zone, p_job uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3
                                          and not (x.type = ''import_note'' and coalesce(x.metadata ->> ''import_job_id'' = $4::text, false))
                                          -- GAP-12: the timeline entries of the opening balances of this import
                                          -- (null-safe like the line above: a system entry without a kind stays work)
                                          and not coalesce(x.type = ''system'' and x.metadata ->> ''kind'' in (''document_recorded'', ''document_cancelled'')
                                                   and exists (select 1 from public.accounting_documents ad
                                                                where ad.organization_id = $1 and ad.id::text = x.metadata ->> ''document_id''
                                                                  and ad.import_job_id = $4), false))
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since, p_job;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    -- CNS-05: the import's own consents are part of the import, not work on the record
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since
                    and x.import_job_id is distinct from p_job)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        -- ORD-01: an order is always made after the import
        or exists (select 1 from public.orders x where x.organization_id = p_org and p_id in (x.contact_id, x.delivery_contact_id))
        -- DOC-01: a document is always recorded after the import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.contact_id = p_id
                     -- GAP-12: the job's own opening balance is part of the import
                     and x.import_job_id is distinct from p_job)
        -- PAY-01: a payment is always recorded after the import
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.contact_id = p_id)
        -- COL-05: a hold is always set after the import
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since
                     and x.import_job_id is distinct from p_job)
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
        -- GAP-12: a company's opening balance recorded outside this import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
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
$function$
;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

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
  v_consents integer;
  v_openings integer;
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
  -- CNS-05 (owner, 26 October 2026): the import's consents are cancelled by new entries (append-only); fail-safe until
  -- the owner answers: its 'granted' entries only
  v_consents := app.import_consents_cancel(p_org, p_job);
  -- GAP-12: the job's own opening balances are cancelled (a balance the import replaced is not restored)
  v_openings := app.import_opening_cancel(p_org, p_job);
  return jsonb_build_object('done', v_done)
         || case when v_consents > 0 then jsonb_build_object('consents', v_consents) else '{}'::jsonb end
         || case when v_openings > 0 then jsonb_build_object('opening_balances', v_openings) else '{}'::jsonb end;
end;
$$;
revoke all on function public.undo_import(uuid, uuid) from public, anon;
grant execute on function public.undo_import(uuid, uuid) to authenticated;

create or replace function public.undo_own_import(p_org uuid, p_job uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs;
  v_table text;
  v_done integer := 0;
  v_kept integer := 0;
  v_openings integer;
  v_n integer;
  v_consents integer;
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
  -- CNS-05 (owner, 26 October 2026): the import's 'granted' entries are cancelled (fail-safe), also on a kept record
  v_consents := app.import_consents_cancel(p_org, p_job);
  -- GAP-12: the job's own opening balances are cancelled (a balance the import replaced is not restored)
  v_openings := app.import_opening_cancel(p_org, p_job);
  return jsonb_build_object('done', v_done, 'kept', v_kept)
         || case when v_consents > 0 then jsonb_build_object('consents', v_consents) else '{}'::jsonb end
         || case when v_openings > 0 then jsonb_build_object('opening_balances', v_openings) else '{}'::jsonb end;
end;
$$;
revoke all on function public.undo_own_import(uuid, uuid) from public, anon;
grant execute on function public.undo_own_import(uuid, uuid) to authenticated;

