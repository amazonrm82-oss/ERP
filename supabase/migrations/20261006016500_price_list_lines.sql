-- =============================================================================
-- Price list lines and quantity tiers (PL-02, wave 2)
-- =============================================================================
-- SPEC-ADDITIONS 4.3: "a price list line: a product with a fixed price, or a
-- percentage off the base price. Quantity tiers: from 10 units, another price."
--
-- public.price_list_lines: one row per (price list, product, minimum quantity).
--
--   min_quantity         the tier starts at this quantity (inclusive). 0 = any
--                        quantity. Up to three decimals, like a quantity of
--                        hours or kilos. For a quantity, the line with the
--                        largest min_quantity not above it applies; when no
--                        line of the list fits (say only "from 10" and the
--                        quantity is 3), the product's own price applies.
--                        Unique per (list, product, min_quantity)
--                        (price_list_lines_tier).
--   price_agorot,        a fixed price, stored as typed with the mode it was
--   price_includes_vat   typed in, exactly like products.price_agorot /
--                        price_includes_vat (TAX-04): a document line takes it
--                        into its own mode with productPriceFor() at the
--                        document's rate. Only a fixed price carries a mode
--                        (price_list_lines_vat_mode); whether the product is
--                        taxable is the product's, read at use, so "including
--                        VAT" on a product that is exempt is read as its net
--                        price (the rule of productPriceFor()).
--   discount_bp          or a percentage off the product's own price, in basis
--                        points (1 = 0.01%, 10000 = 100%). The result keeps the
--                        product's mode and is rounded half up to the agora.
--                        Exactly one of price_agorot and discount_bp is set
--                        (price_list_lines_one_rule).
--   currency             ILS only until DEAL-12 (TAX-06), like every amount.
--
-- The rule that picks a unit price for (product, list, quantity, day) is
-- unitPriceFor() in src/features/price-lists/price.ts (unit tested). The
-- database does not compute it yet; PL-03 (documents pulling the price) decides
-- whether it needs a mirror in SQL, and then a test compares the two.
--
-- References:
--   price_list_id        composite FK, ON DELETE CASCADE: the lines belong to
--                        their list, and removing a list (asked and confirmed
--                        on screen) removes its prices with it.
--   product_id           composite FK with NO on delete action, like document
--                        lines (PRD-02): removing a product that a price list
--                        still uses fails with 23503, and the app says to take
--                        it out of the price lists or archive it. Cascade would
--                        lose the business's prices without a word; set null
--                        is impossible (a line without a product means
--                        nothing). An archived or inactive product keeps its
--                        lines: they come back with it, and documents never
--                        offer it anyway (isOfferable()).
--
-- At most 20 tiers per product in one list (hint 'price_list_lines:tiers'), a
-- sanity limit checked by a definer trigger under a per-list-and-product
-- advisory lock; the same trigger refuses a new line without the plan's
-- capability 'price_lists' (hint 'feature:price_lists'), which is also in the
-- insert policy. The number of price lists is the plan's quota (PL-01); lines
-- have no plan quota.
--
-- Every member reads; owners and admins of a writable organization write.
-- Clients set the list and the product once (column grants); moving a price to
-- another product is a new line. Audited like the lists. Exported in the full
-- export.
--
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.price_list_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  price_list_id      uuid not null,
  product_id         uuid not null,
  min_quantity       numeric(12, 3) not null default 0 check (min_quantity >= 0),
  price_agorot       bigint check (price_agorot is null or price_agorot between 0 and 1000000000000),
  price_includes_vat boolean not null default false,
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint price_list_lines_list_fk foreign key (organization_id, price_list_id)
    references public.price_lists (organization_id, id) on delete cascade,
  -- no action: a product a price list uses cannot be removed, only archived
  constraint price_list_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint price_list_lines_one_rule check ((price_agorot is null) <> (discount_bp is null)),
  constraint price_list_lines_vat_mode check (price_agorot is not null or not price_includes_vat),
  constraint price_list_lines_tier unique (organization_id, price_list_id, product_id, min_quantity)
);

-- removing a product looks up its lines
create index if not exists price_list_lines_product_idx on public.price_list_lines (organization_id, product_id);

alter table public.price_list_lines enable row level security;

revoke all on public.price_list_lines from anon, authenticated;
grant select, delete on public.price_list_lines to authenticated;
grant insert (organization_id, price_list_id, product_id, min_quantity, price_agorot, price_includes_vat, discount_bp, currency)
  on public.price_list_lines to authenticated;
grant update (min_quantity, price_agorot, price_includes_vat, discount_bp, currency)
  on public.price_list_lines to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_list_lines' and policyname = 'price_list_lines_select') then
    create policy price_list_lines_select on public.price_list_lines for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_list_lines' and policyname = 'price_list_lines_insert') then
    create policy price_list_lines_insert on public.price_list_lines for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'price_lists'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_list_lines' and policyname = 'price_list_lines_update') then
    create policy price_list_lines_update on public.price_list_lines for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_list_lines' and policyname = 'price_list_lines_delete') then
    create policy price_list_lines_delete on public.price_list_lines for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger price_list_lines_touch before update on public.price_list_lines
  for each row execute function app.touch_row();
create or replace trigger price_list_lines_audit after insert or update or delete on public.price_list_lines
  for each row execute function app.audit_row();

-- The capability and the tier limit, for every writer.
create or replace function app.price_list_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- A person who is not an owner or admin of this business is refused by RLS
  -- (42501) right after this trigger; answering here would tell an outsider
  -- the business's plan state. auth.uid(), not current_user: inside a definer
  -- current_user is the owner. Server writers without a session are checked.
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'price_lists') then
    raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('price_list_lines:' || new.price_list_id::text || ':' || new.product_id::text, 0));
  if (select count(*) from public.price_list_lines l
       where l.organization_id = new.organization_id and l.price_list_id = new.price_list_id
         and l.product_id = new.product_id) >= 20 then
    raise exception 'at most 20 quantity tiers per product in a price list' using errcode = 'P0001', hint = 'price_list_lines:tiers';
  end if;
  return new;
end;
$$;
revoke all on function app.price_list_lines_check() from public, anon, authenticated;

create or replace trigger price_list_lines_check before insert on public.price_list_lines
  for each row execute function app.price_list_lines_check();
