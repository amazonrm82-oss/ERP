-- =============================================================================
-- 0179 log_export records the format of a report export (RPT-02)
-- =============================================================================
-- A report is exported as CSV or, since RPT-02, as Excel (.xlsx). public.log_export()
-- (0050) wrote 'csv' for every report. It gains p_format text default 'csv',
-- checked against ('csv', 'xlsx') (22023 otherwise), and the report's audit entry
-- records it. The full export still records 'zip'; p_format means nothing for it,
-- but must still be a known value. Everything else, every permission check
-- included, is the 0050 body unchanged.
-- * One function, not two overloads: the old four-argument call (log_export(org,
--   kind, report, rows)) keeps working through the default. Adding an argument is a
--   new signature, and a migration here may not start a statement with drop, so the
--   0050 function is first moved out of the API (renamed and moved into schema app,
--   all grants revoked). Nothing calls it there; it is only kept, never used.
-- * Grants as before: revoke from public and anon, execute to authenticated.
-- * Safe to run twice: the move happens only while the four-argument function exists.

do $$
begin
  if to_regprocedure('public.log_export(uuid, text, text, integer)') is not null then
    alter function public.log_export(uuid, text, text, integer) rename to log_export_0050_retired;
    alter function public.log_export_0050_retired(uuid, text, text, integer) set schema app;
    revoke all on function app.log_export_0050_retired(uuid, text, text, integer) from public, anon, authenticated, service_role;
  end if;
end;
$$;

create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if v_role is null or v_role not in ('owner', 'admin', 'manager') then
      raise exception 'export is for owners, admins and team managers' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;

revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;

notify pgrst, 'reload schema';
