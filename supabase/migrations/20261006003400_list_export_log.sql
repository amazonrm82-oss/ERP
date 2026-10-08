-- =============================================================================
-- 0034 Exporting a list is written to the audit log (LST-08)
-- =============================================================================
-- public.log_list_export(): the app calls it before it hands over a file of a
-- list (the filtered list, or the rows picked in it). It checks that the caller
-- may export (owner, admin or team manager, as for reports) and writes one
-- audit_log row: action 'export', entity_type the list's table, and in changes
-- the format, the number of rows, what was exported and the list's filters.
-- The rows themselves are read by the app with the user's session (RLS), so an
-- export never holds more than the user sees on screen.
-- * Read-only organizations may still export: the data is the customer's.
-- * Every statement is safe to run twice.

create or replace function public.log_list_export(
  p_org uuid,
  p_object text,
  p_format text,
  p_rows integer,
  p_scope text,
  p_filters jsonb
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
  v_table text := case p_object when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies' end;
begin
  if v_role is null or v_role not in ('owner', 'admin', 'manager') then
    raise exception 'export is for owners, admins and team managers' using errcode = '42501';
  end if;
  if v_table is null or p_format not in ('csv', 'xlsx') or p_scope not in ('filtered', 'selected')
     or p_rows is null or p_rows < 0 or p_rows > 1000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export', v_table, null,
    jsonb_build_object('format', p_format, 'rows', p_rows, 'scope', p_scope)
      -- the filters as the list had them; left out when they are not an object or too large to keep
      || case when jsonb_typeof(p_filters) = 'object' and pg_column_size(p_filters) <= 8192
              then jsonb_build_object('filters', p_filters) else '{}'::jsonb end
  );
end;
$$;

revoke all on function public.log_list_export(uuid, text, text, integer, text, jsonb) from public, anon;
grant execute on function public.log_list_export(uuid, text, text, integer, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
