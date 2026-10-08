-- =============================================================================
-- 0042 Custom fields and tags are merged in the database (FXD-04)
-- =============================================================================
-- The app read a record's custom_fields, changed them and wrote the whole object
-- back. A read that failed once wrote back only the visible fields (values of
-- hidden fields were lost), and two people editing at once overwrote each other.
-- Tags were the same: the picker wrote the whole list.
-- * custom_fields: an update may send {"$merge": {key: value | null}}. A trigger
--   merges it into the row as it is now (a null removes the key), inside the
--   same statement and row lock. It runs before the *_custom_fields_check
--   trigger (names sort "cf_merge" < "custom_fields_check"), which then checks
--   the merged result as before.
-- * change_record_tags(): adds and removes tags in one statement, with the
--   caller's rights (RLS decides), and only tags of the record's organization.
-- Every statement is safe to run twice.

create or replace function app.merge_custom_fields() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_patch jsonb;
  v_remove text[];
begin
  if jsonb_typeof(new.custom_fields) = 'object' and new.custom_fields ? '$merge' then
    v_patch := new.custom_fields -> '$merge';
    if jsonb_typeof(v_patch) <> 'object' then
      raise exception 'custom field patch must be an object' using errcode = '22023';
    end if;
    select coalesce(array_agg(e.key), '{}') into v_remove from jsonb_each(v_patch) e where e.value = 'null'::jsonb;
    new.custom_fields := (coalesce(old.custom_fields, '{}'::jsonb) || jsonb_strip_nulls(v_patch)) - v_remove;
  end if;
  return new;
end;
$$;
revoke all on function app.merge_custom_fields() from public, anon;
grant execute on function app.merge_custom_fields() to authenticated, service_role;

create or replace trigger leads_cf_merge before update of custom_fields on public.leads
  for each row execute function app.merge_custom_fields();
create or replace trigger contacts_cf_merge before update of custom_fields on public.contacts
  for each row execute function app.merge_custom_fields();
create or replace trigger companies_cf_merge before update of custom_fields on public.companies
  for each row execute function app.merge_custom_fields();
create or replace trigger deals_cf_merge before update of custom_fields on public.deals
  for each row execute function app.merge_custom_fields();

-- Adds and removes tags on one record. Returns false when the record was not
-- changed (gone, or not the caller's to edit: RLS hides it).
create or replace function public.change_record_tags(p_table text, p_org uuid, p_id uuid, p_add uuid[], p_remove uuid[])
returns boolean
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_table not in ('leads', 'contacts', 'companies', 'deals') then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format(
    'update public.%I t
        set tag_ids = coalesce(array(
              select distinct x from unnest(t.tag_ids || coalesce($3, ''{}''::uuid[])) x
               where not (x = any (coalesce($4, ''{}''::uuid[])))
                 and (x = any (t.tag_ids) or x in (select g.id from public.tags g where g.organization_id = $1))
               order by x), ''{}'')
      where t.organization_id = $1 and t.id = $2 and t.deleted_at is null', p_table)
    using p_org, p_id, p_add, p_remove;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.change_record_tags(text, uuid, uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.change_record_tags(text, uuid, uuid, uuid[], uuid[]) to authenticated;
