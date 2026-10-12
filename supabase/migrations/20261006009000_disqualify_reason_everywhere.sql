-- =============================================================================
-- The "not relevant" reason follows the status everywhere (RVW-9, LEAD-03)
-- =============================================================================
-- Until now trigger leads_disqualify_reason (0058) checked only updates made by a
-- person, so a reason could be lost or left behind by other writers:
-- * merge: status_id could be picked from the duplicate without its reason;
-- * automation set_lead_status, conversion and any server change: moving a lead
--   out of a "not relevant" status left the old reason on the card;
-- * a new lead (the new-lead form, a direct API insert) could start "not relevant"
--   without a reason.
--
-- app.check_disqualify_reason() (still security invoker: current_user tells a
-- browser write from a server one) now runs on insert too, for every writer:
-- * the new status is not of kind 'disqualified' -> the reason is cleared;
-- * a server write (automation, merge, conversion, intake) that moves a lead into
--   a 'disqualified' status from one that is not, without changing the reason ->
--   the reason is cleared (an automation has no reason to give; it is left empty
--   rather than showing a stale one);
-- * a person (role authenticated) inserting or changing a lead into a
--   'disqualified' status: the reason must come from the organization's active
--   list, or be non-empty while the list is empty (hint 'lead:disqualify_reason'),
--   as before for updates and now also for inserts. Rows written by a running
--   import (import_job_id set) are not checked and get no reason: an import file has no reason column.
-- * app.merge_columns('lead') lists disqualify_reason, so a merge can take the
--   duplicate's reason together with its status; the merge screen sends both
--   whenever the status is picked (src/features/merge/fields.ts, MERGE_COMPANIONS).
-- No existing rows are rewritten here. Every statement is safe to run twice.

create or replace function app.check_disqualify_reason() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_kind     public.lead_status_kind;
  v_old_kind public.lead_status_kind;
  v_reason   text := btrim(coalesce(new.disqualify_reason, ''));
begin
  if tg_op = 'UPDATE'
     and new.status_id is not distinct from old.status_id
     and new.disqualify_reason is not distinct from old.disqualify_reason then
    return new;
  end if;
  select s.kind into v_kind from public.lead_statuses s
   where s.organization_id = new.organization_id and s.id = new.status_id;

  -- the reason belongs to a "not relevant" status only, whoever writes
  if v_kind is distinct from 'disqualified' then
    new.disqualify_reason := null;
    return new;
  end if;

  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user <> 'authenticated' then
    if tg_op = 'UPDATE' and new.disqualify_reason is not distinct from old.disqualify_reason then
      select s.kind into v_old_kind from public.lead_statuses s
       where s.organization_id = old.organization_id and s.id = old.status_id;
      if v_old_kind is distinct from 'disqualified' then
        new.disqualify_reason := null;
      end if;
    end if;
    return new;
  end if;

  -- a person; an import has no reason to give
  if tg_op = 'INSERT' and new.import_job_id is not null then
    new.disqualify_reason := null;
    return new;
  end if;
  if exists (select 1 from public.disqualify_reasons r where r.organization_id = new.organization_id and r.is_active) then
    if not exists (select 1 from public.disqualify_reasons r
                    where r.organization_id = new.organization_id and r.is_active and r.name = v_reason) then
      raise exception 'pick a reason from the list' using errcode = 'P0001', hint = 'lead:disqualify_reason';
    end if;
  elsif v_reason = '' then
    raise exception 'a reason is required' using errcode = 'P0001', hint = 'lead:disqualify_reason';
  end if;
  return new;
end;
$$;
revoke all on function app.check_disqualify_reason() from public, anon, authenticated;

create or replace trigger leads_disqualify_reason before insert or update of status_id, disqualify_reason on public.leads
  for each row execute function app.check_disqualify_reason();

-- the reason can be taken from the duplicate in a merge (with the status; see above)
-- merge_records applies picks in jsonb_each_text order (status_id before disqualify_reason); that order keeps the reason.
create or replace function app.merge_columns(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['full_name', 'email', 'phone', 'company_name', 'job_title', 'status_id', 'disqualify_reason',
                           'source_id', 'campaign', 'message', 'budget_agorot', 'owner_id']
    when 'contact' then array['first_name', 'last_name', 'email', 'phone', 'job_title', 'company_id', 'source_id',
                              'address_line', 'city', 'birth_date', 'owner_id']
    when 'company' then array['name', 'tax_id', 'industry', 'website', 'email', 'phone', 'address_line', 'city', 'owner_id']
  end;
$$;
revoke all on function app.merge_columns(text) from public, anon;
grant execute on function app.merge_columns(text) to authenticated;
