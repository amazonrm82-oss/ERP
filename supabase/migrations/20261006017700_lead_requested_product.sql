-- =============================================================================
-- Requested product on a lead (LEAD-04, wave 2)
-- =============================================================================
-- SPEC-ADDITIONS LEAD-04: "a 'requested product' field, linked to the product catalog".
--
-- leads.requested_product_id: the product the lead asked about, nullable. A composite
-- foreign key to public.products (organization_id, id), so it can only point into the
-- same organization; when the product is removed only this column is cleared (a
-- product used on a document line cannot be removed, only archived, PRD-01).
--
-- Trigger leads_requested_product_check (security invoker on purpose: current_user
-- tells a browser write from a server one). A person (authenticated / anon) who sets
-- the product on insert, or changes it on update, must pick a product they can read
-- that is offerable (is_active and not archived, isOfferable() in
-- src/features/products/schema.ts) and the organization must have the plan flag
-- 'products' (hint 'feature:products'); otherwise hint 'lead:requested_product'. The
-- readability check comes first, so an outsider learns nothing about another
-- organization's plan. A product archived or deactivated later stays on the lead and is
-- shown as it is; an update that leaves the column unchanged is never checked. A writer
-- who is not a member is let through to RLS, which refuses with a plain 42501. Server
-- writers (intake, merge, imports' definer helpers) are trusted. The app hides the field
-- when the organization has no 'products' flag.
--
-- leads has column-level insert/update grants (0038), so the column gets its own.
-- Nullable, so app.sample_row() needs nothing (0121). Not part of merge picks
-- (app.merge_columns() is shared ground; follow-up). The conversion does not carry it:
-- deals have no product field yet (DLI-01 adds deal lines).
--
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.leads add column if not exists requested_product_id uuid;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'leads_requested_product_fk' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_requested_product_fk
      foreign key (organization_id, requested_product_id) references public.products (organization_id, id)
      on delete set null (requested_product_id);
  end if;
end;
$$;

-- the foreign key's lookup when a product is removed, and "leads that asked for this product"
create index if not exists leads_requested_product_idx on public.leads (organization_id, requested_product_id)
  where requested_product_id is not null;

grant insert (requested_product_id), update (requested_product_id) on public.leads to authenticated;

create or replace function app.check_lead_requested_product() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user not in ('authenticated', 'anon') or new.requested_product_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.requested_product_id is not distinct from old.requested_product_id then
    return new;
  end if;
  -- a writer who is not a member of this business is refused by RLS (plain 42501) right after
  -- this trigger; answering here would tell an outsider about the business's products or plan
  if not app.is_member(new.organization_id) then
    return new;
  end if;
  -- read with the caller's rights (products: members read)
  if not exists (
    select 1 from public.products p
    where p.organization_id = new.organization_id
      and p.id = new.requested_product_id
      and p.is_active
      and p.archived_at is null
  ) then
    raise exception 'the requested product is not available' using errcode = 'P0001', hint = 'lead:requested_product';
  end if;
  if not app.org_has_feature(new.organization_id, 'products') then
    raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
  end if;
  return new;
end;
$$;
revoke all on function app.check_lead_requested_product() from public, anon, authenticated;

create or replace trigger leads_requested_product_check before insert or update of requested_product_id on public.leads
  for each row execute function app.check_lead_requested_product();

comment on column public.leads.requested_product_id is
  'LEAD-04: the product the lead asked about (public.products); a person may pick only an offerable product.';

-- The lead list's "requested product" column sorts by the product's name: a computed field
-- PostgREST orders by (order=sort_requested_product), like sort_source (0032). Security
-- invoker: RLS on products decides (members read every product).
create or replace function public.sort_requested_product(public.leads) returns text
language sql stable security invoker
set search_path = ''
as $$
  select p.name from public.products p where p.organization_id = $1.organization_id and p.id = $1.requested_product_id;
$$;
revoke all on function public.sort_requested_product(public.leads) from public, anon;
grant execute on function public.sort_requested_product(public.leads) to authenticated;

-- the API learns about new computed fields when it reloads its schema cache
notify pgrst, 'reload schema';
