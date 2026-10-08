-- 20261006003200_list_sort_fields: part 1 of 1. Run the parts in order.
-- =============================================================================
-- 0032 Sorting lists by status, source, owner and company (LST-02)
-- =============================================================================
-- Some list columns show the name of a row in another table. PostgREST can
-- order by a "computed field": a function that takes the table's row. These
-- return what the column shows, so `order=sort_owner` sorts by the owner's name:
-- * sort_status(leads): the status's position, the order set in settings
-- * sort_source(leads): the source's name
-- * sort_owner(leads | contacts | companies): the owner's name (else email)
-- * sort_company(contacts): the company's name
-- security invoker: read with the caller's rights, like the list itself.
-- Every statement is safe to run twice.

create or replace function public.sort_status(public.leads) returns integer
language sql stable security invoker
set search_path = ''
as $$
  select s.position from public.lead_statuses s where s.organization_id = $1.organization_id and s.id = $1.status_id;
$$;

create or replace function public.sort_source(public.leads) returns text
language sql stable security invoker
set search_path = ''
as $$
  select s.name from public.lead_sources s where s.organization_id = $1.organization_id and s.id = $1.source_id;
$$;

create or replace function public.sort_owner(public.leads) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.owner_id;
$$;

create or replace function public.sort_owner(public.contacts) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.owner_id;
$$;

create or replace function public.sort_owner(public.companies) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.owner_id;
$$;

create or replace function public.sort_company(public.contacts) returns text
language sql stable security invoker
set search_path = ''
as $$
  select c.name from public.companies c where c.organization_id = $1.organization_id and c.id = $1.company_id;
$$;

revoke all on function public.sort_status(public.leads) from public, anon;
revoke all on function public.sort_source(public.leads) from public, anon;
revoke all on function public.sort_owner(public.leads) from public, anon;
revoke all on function public.sort_owner(public.contacts) from public, anon;
revoke all on function public.sort_owner(public.companies) from public, anon;
revoke all on function public.sort_company(public.contacts) from public, anon;
grant execute on function public.sort_status(public.leads) to authenticated;
grant execute on function public.sort_source(public.leads) to authenticated;
grant execute on function public.sort_owner(public.leads) to authenticated;
grant execute on function public.sort_owner(public.contacts) to authenticated;
grant execute on function public.sort_owner(public.companies) to authenticated;
grant execute on function public.sort_company(public.contacts) to authenticated;

-- the API learns about new computed fields when it reloads its schema cache
notify pgrst, 'reload schema';
