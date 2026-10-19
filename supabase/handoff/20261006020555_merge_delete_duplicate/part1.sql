-- =============================================================================
-- Removing a merged duplicate (RVW-26), pasted by hand
-- =============================================================================
-- Holds the one delete of public.merge_records (20261006020560_merge_more_picks.sql, connector), which
-- calls it; pasted before that one goes in, so merges never meet a missing helper. Definer, no grants for any role; the table must be one of the
-- three merge tables before it reaches format(). Safe to run twice.

create or replace function app.merge_delete_duplicate(p_org uuid, p_table text, p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_table is null or p_table not in ('leads', 'contacts', 'companies') then
    raise exception 'not a merge table' using errcode = '22023';
  end if;
  execute format('delete from public.%I where organization_id = $1 and id = $2', p_table) using p_org, p_id;
end;
$$;
revoke all on function app.merge_delete_duplicate(uuid, text, uuid) from public, anon, authenticated, service_role;
