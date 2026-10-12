-- =============================================================================
-- 0050 Every export is written to the audit log (IMP-02)
-- =============================================================================
-- Lists already log through log_list_export (0034/0035). public.log_export()
-- covers the other two files a user can take away: a report as CSV (owner,
-- admin or team manager, as the report screen) and the full export ZIP (the
-- owner only). One audit_log row each: action 'export', who, what and how many.
-- * Read-only organizations may still export: the data is the customer's.
-- * Every statement is safe to run twice.

create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer
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
    if p_report is null or p_report !~ '^[a-z_]{1,40}$' then
      raise exception 'invalid export' using errcode = '22023';
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'organizations' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else 'csv' end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;

revoke all on function public.log_export(uuid, text, text, integer) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer) to authenticated;

notify pgrst, 'reload schema';
