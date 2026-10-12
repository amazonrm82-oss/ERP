-- =============================================================================
-- A lead import may carry the "not relevant" reason (RVW-9, owner's answer of 12 October 2026)
-- =============================================================================
-- Until now app.check_disqualify_reason() (0090) gave every row inserted by a running
-- import (import_job_id set) an empty reason: an import file had no reason column.
-- The owner decided that a lead import has an optional reason column:
-- * a row in a "not relevant" status without a reason is imported with an empty
--   reason, not refused (as before);
-- * a reason that equals, after trimming, a name in the organization's active list
--   is kept, stored as that name;
-- * any other reason is not stored (the import screen says so for the row); an
--   import never brings free text, even while the list is empty.
-- Everything else is unchanged: a person's own insert or change into a "not
-- relevant" status still needs a reason from the list; server writes as in 0090.
-- An import's update of an existing lead carries no import_job_id (it is set on
-- insert only), so it is checked like any change a person makes; the import screen
-- fails such a row before writing when it would move the lead in without a reason.
-- Only the trigger function is replaced (still security invoker: current_user tells
-- a browser write from a server one). No rows are rewritten. Safe to run twice.

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

  -- a row of a running import: a reason from the active list, or none
  if tg_op = 'INSERT' and new.import_job_id is not null then
    if v_reason <> '' and exists (select 1 from public.disqualify_reasons r
                                   where r.organization_id = new.organization_id and r.is_active and r.name = v_reason) then
      new.disqualify_reason := v_reason;
    else
      new.disqualify_reason := null;
    end if;
    return new;
  end if;

  -- a person
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
