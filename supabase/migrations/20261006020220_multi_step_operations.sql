-- =============================================================================
-- One database call for each multi-step operation (FXD-07)
-- =============================================================================
-- The review of 8 October 2026 (FXD-07): a few operations were several separate commands from the app, so a failure
-- half way left the data half changed: the default pipeline (and the default lead status) cleared but not moved, a
-- list half reordered, and an import marked "undone" although a record it made was still there. Each is now one
-- function, so it happens whole or not at all. All are security invoker: the caller's own rights (RLS, column
-- grants) decide every row, exactly as the app's separate commands did.
-- * public.set_default_pipeline(org, pipeline) and public.set_default_lead_status(org, status): clear the old
--   default and set the new one in one transaction; a pipeline must be live, a status open (hint
--   'lead_status:default_open'); nothing set = not found or not permitted (42501), and nothing changes.
-- * public.reorder_positions(table, org, ids): writes position 0..n-1 in the given order, on one of the managed lists
--   a closed list names (hint 'reorder:table'); every id must be a row the caller may change, or nothing moves
--   (42501).
-- * public.undo_import(org, job): the undo of one's own import, for those who undo it whole (owners, admins,
--   managers; members use undo_own_import): the records it made go to the recycle bin, and for a contacts import the
--   companies it made that no live contact uses; the import is marked undone only when none of its records is left.
--   A record the caller may no longer move to the recycle bin (not visible, or app.can_delete_record false) means nothing
--   is undone (hint 'import_undo:left', the number in DETAIL), checked before and after the move. app.import_rows_left(org, job) counts the live records of the caller's own import, whatever RLS shows.
--   Products are left to the app (their undo deletes rows; see the CLAUDE.md note on delete statements).
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function public.set_default_pipeline(p_org uuid, p_pipeline uuid) returns void
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  -- one default per organization (unique index): the old one is cleared first, in the same transaction
  update public.pipelines p set is_default = false
   where p.organization_id = p_org and p.is_default and p.id <> p_pipeline;
  update public.pipelines p set is_default = true
   where p.organization_id = p_org and p.id = p_pipeline and p.deleted_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'pipeline not found or not permitted' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.set_default_pipeline(uuid, uuid) from public, anon;
grant execute on function public.set_default_pipeline(uuid, uuid) to authenticated;

create or replace function public.set_default_lead_status(p_org uuid, p_status uuid) returns void
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_kind text;
  v_n integer;
begin
  select s.kind::text into v_kind from public.lead_statuses s where s.organization_id = p_org and s.id = p_status;
  if v_kind is not null and v_kind <> 'open' then
    raise exception 'only an open status can be the default' using errcode = 'P0001', hint = 'lead_status:default_open';
  end if;
  update public.lead_statuses s set is_default = false
   where s.organization_id = p_org and s.is_default and s.id <> p_status;
  update public.lead_statuses s set is_default = true
   where s.organization_id = p_org and s.id = p_status;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'status not found or not permitted' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.set_default_lead_status(uuid, uuid) from public, anon;
grant execute on function public.set_default_lead_status(uuid, uuid) to authenticated;

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
       'contact_relation_types') then
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

-- How many records of the caller's own import are still live, whatever the caller may still read. Only the
-- import's creator gets a number; anyone else gets null.
create or replace function app.import_rows_left(p_org uuid, p_job uuid) returns integer
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs;
  v_table text;
  v_left integer;
begin
  select * into v_job from public.import_jobs j where j.organization_id = p_org and j.id = p_job;
  if not found or v_job.created_by is distinct from auth.uid() then
    return null;
  end if;
  v_table := case v_job.entity_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                    when 'deal' then 'deals' when 'task' then 'tasks' end;
  if v_table is null then
    return null;
  end if;
  execute format('select count(*)::int from public.%I t where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null', v_table)
    into v_left using p_org, p_job;
  return v_left;
end;
$$;
revoke all on function app.import_rows_left(uuid, uuid) from public, anon;
grant execute on function app.import_rows_left(uuid, uuid) to authenticated;

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

notify pgrst, 'reload schema';
