-- =============================================================================
-- Products: import from Excel/CSV and list export (PRD-05, wave 2)
-- =============================================================================
-- The import wizard (src/features/imports/) learns a fourth object, 'product',
-- the same way leads, contacts and companies work since 0012:
--
-- * import_jobs.entity_type also takes 'product'.
-- * products.import_job_id remembers which import created a product. It is set
--   on insert only, to a running job of the same user and type
--   (app.guard_import_tag('product'), the function of 0012/0044 unchanged), and
--   never changed (no update grant; the guard refuses a change too). Undoing an
--   import removes the products it created, and only those; a product a
--   document uses by then is archived instead (the app does it, with the user's
--   session; products have no recycle bin).
-- * public.product_sku_matches(org, skus) finds the products whose SKU (without
--   case) is already taken; a row with such a SKU is skipped.
-- * The plan quota (products_quota, PRD-08) runs for every imported row, so an
--   import stops at the quota row by row.
-- * app.fail_stale_imports() counts the products of a stale product import
--   (its body is that of 0045 with the 'product' branch added).
-- * public.log_list_export() accepts 'product' (audited as entity 'products'),
--   so the product list export is written to the audit log first like the
--   other lists (its body is that of 0085 with one more case).
--
-- Products carry no outbox event and no assignment notification, so there is
-- nothing to mark as 'import' there.
--
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.import_jobs drop constraint if exists import_jobs_entity_type_check;
alter table public.import_jobs add constraint import_jobs_entity_type_check
  check (entity_type in ('lead', 'contact', 'company', 'product'));

alter table public.products add column if not exists import_job_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_import_job_fk') then
    alter table public.products add constraint products_import_job_fk foreign key (organization_id, import_job_id)
      references public.import_jobs (organization_id, id) on delete set null (import_job_id);
  end if;
end;
$$;
create index if not exists products_import_job_idx on public.products (import_job_id) where import_job_id is not null;

-- set on insert by the import; never updated by a client
grant insert (import_job_id) on public.products to authenticated;

create or replace trigger products_import_tag before insert or update of import_job_id on public.products
  for each row execute function app.guard_import_tag('product');

-- The products of the organization whose SKU equals one of the given ones,
-- ignoring case (as products_sku_idx does). Security invoker: RLS decides, like
-- import_find_duplicates. The import checks a chunk's SKUs with one call; the
-- unique index still has the last word when two imports race.
create or replace function public.product_sku_matches(p_org uuid, p_skus text[])
returns table (id uuid, sku text)
language sql stable
set search_path = ''
as $$
  select p.id, p.sku
    from public.products p
   where p.organization_id = p_org
     and p.sku is not null
     and lower(p.sku) = any (select lower(btrim(s)) from unnest(coalesce(p_skus, '{}'::text[])) as s)
$$;
revoke all on function public.product_sku_matches(uuid, text[]) from public, anon;
grant execute on function public.product_sku_matches(uuid, text[]) to authenticated;

create or replace function app.fail_stale_imports() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.import_jobs j
     set status = 'failed',
         finished_at = now(),
         created_count = case j.entity_type
           when 'lead' then (select count(*) from public.leads l where l.organization_id = j.organization_id and l.import_job_id = j.id)
           when 'contact' then (select count(*) from public.contacts c where c.organization_id = j.organization_id and c.import_job_id = j.id)
           when 'product' then (select count(*) from public.products p where p.organization_id = j.organization_id and p.import_job_id = j.id)
           else (select count(*) from public.companies o where o.organization_id = j.organization_id and o.import_job_id = j.id)
         end
   where j.status = 'running' and j.updated_at < now() - interval '10 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.fail_stale_imports() from public, anon, authenticated;
grant execute on function app.fail_stale_imports() to service_role;

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
                                when 'deal' then 'deals' when 'task' then 'tasks' when 'product' then 'products' end;
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
      -- the filters as the list had them, without typed text; left out when they
      -- are not an object or too large to keep
      || case when jsonb_typeof(p_filters) = 'object' and pg_column_size(p_filters) <= 8192
              then jsonb_build_object('filters', app.export_filters(p_filters)) else '{}'::jsonb end
  );
end;
$$;

revoke all on function public.log_list_export(uuid, text, text, integer, text, jsonb) from public, anon;
grant execute on function public.log_list_export(uuid, text, text, integer, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
