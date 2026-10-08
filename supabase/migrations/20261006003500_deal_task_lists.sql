-- =============================================================================
-- 0035 Deals and tasks as lists, like leads, contacts and companies (LST-09)
-- =============================================================================
-- * list_preferences: a user's columns may now be saved for the deals table and
--   the tasks table too (object_type 'deal' and 'task').
-- * Computed fields for sorting (as in 0032), with the caller's rights:
--   sort_owner(deals | tasks), sort_stage(deals) (the stage's position in its
--   pipeline), sort_contact(deals) and sort_company(deals) (the names shown).
-- * log_list_export(): exporting the deals or tasks list is logged too.
-- Every statement is safe to run twice.

alter table public.list_preferences drop constraint if exists list_preferences_object_type_check;
alter table public.list_preferences add constraint list_preferences_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task'));

create or replace function public.sort_owner(public.deals) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.owner_id;
$$;

create or replace function public.sort_owner(public.tasks) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.owner_id;
$$;

create or replace function public.sort_stage(public.deals) returns integer
language sql stable security invoker
set search_path = ''
as $$
  select s.position from public.stages s where s.organization_id = $1.organization_id and s.id = $1.stage_id;
$$;

create or replace function public.sort_contact(public.deals) returns text
language sql stable security invoker
set search_path = ''
as $$
  select c.full_name from public.contacts c where c.organization_id = $1.organization_id and c.id = $1.contact_id;
$$;

create or replace function public.sort_company(public.deals) returns text
language sql stable security invoker
set search_path = ''
as $$
  select c.name from public.companies c where c.organization_id = $1.organization_id and c.id = $1.company_id;
$$;

revoke all on function public.sort_owner(public.deals) from public, anon;
revoke all on function public.sort_owner(public.tasks) from public, anon;
revoke all on function public.sort_stage(public.deals) from public, anon;
revoke all on function public.sort_contact(public.deals) from public, anon;
revoke all on function public.sort_company(public.deals) from public, anon;
grant execute on function public.sort_owner(public.deals) to authenticated;
grant execute on function public.sort_owner(public.tasks) to authenticated;
grant execute on function public.sort_stage(public.deals) to authenticated;
grant execute on function public.sort_contact(public.deals) to authenticated;
grant execute on function public.sort_company(public.deals) to authenticated;

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
  v_table text := case p_object when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                when 'deal' then 'deals' when 'task' then 'tasks' end;
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
