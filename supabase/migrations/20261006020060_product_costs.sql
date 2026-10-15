-- =============================================================================
-- Product cost and who sees it (PRD-06, wave 2)
-- =============================================================================
-- SPEC-ADDITIONS 4.2: the cost "is kept in a separate table with its own
-- permission, so that whoever is not allowed does not get it, also through the
-- API"; 4.6: "a user without the cost permission does not get the cost, also
-- in a direct read of the database". PRD-06: "owners, admins and team
-- managers" see cost and profit; the catalog is edited by admins (PRM-01 adds
-- the edit_catalog grant, migration member_permissions) and read by everyone.
--
-- * app.can_view_costs(org): owners, admins and managers (role, the rule of
--   app.can_export: a support session is a viewer and sees none), or a manager
--   or member holding the PRM-01 grant 'view_costs' (app.has_grant: active,
--   two-step rule, plan capability granular_permissions). The grant becomes
--   grantable here: app.member_permission_built_keys() adds 'view_costs' (body of
--   automation_permission_answer with that one key added).
-- * public.product_costs: one row per product (unique organization, product),
--   cost_agorot per unit of the product, as typed: before VAT for a business
--   that charges VAT, the amount paid otherwise (the screen says which). The
--   product FK cascades: a product that may be removed takes its cost along;
--   a product on a line can only be archived (PRD-02), and its cost stays.
--   RLS: every verb needs app.can_view_costs; writes also need
--   app.can_edit_catalog of a writable business (insert: and the 'products'
--   capability, like products_insert). The products table itself holds no cost,
--   so nothing else in the API returns it: profit is worked out by the app from
--   rows this table returned under RLS.
-- * Audited (app.audit_row): the audit log is readable by owners and admins
--   only, who see costs anyway. No emit_event: automations do not react to it.
--
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- Who sees cost and profit
-- ----------------------------------------------------------------------------
create or replace function app.can_view_costs(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false) or app.has_grant(p_org, 'view_costs');
$$;
revoke all on function app.can_view_costs(uuid) from public, anon;
grant execute on function app.can_view_costs(uuid) to authenticated, service_role;

-- PRM-01: the cost permission is built now
create or replace function app.member_permission_built_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['export', 'import', 'edit_catalog', 'manage_automations', 'view_costs']::text[]
$$;
revoke all on function app.member_permission_built_keys() from public, anon;
grant execute on function app.member_permission_built_keys() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The cost of a product
-- ----------------------------------------------------------------------------
create table if not exists public.product_costs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id      uuid not null,
  cost_agorot     bigint not null check (cost_agorot between 0 and 1000000000000),
  currency        text not null default 'ILS' check (currency = 'ILS'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint product_costs_one_per_product unique (organization_id, product_id),
  constraint product_costs_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id) on delete cascade
);

alter table public.product_costs enable row level security;

revoke all on public.product_costs from anon, authenticated;
grant select, delete on public.product_costs to authenticated;
grant insert (organization_id, product_id, cost_agorot, currency) on public.product_costs to authenticated;
grant update (cost_agorot, currency) on public.product_costs to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_costs' and policyname = 'product_costs_select') then
    create policy product_costs_select on public.product_costs for select to authenticated
      using (app.can_view_costs(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_costs' and policyname = 'product_costs_insert') then
    create policy product_costs_insert on public.product_costs for insert to authenticated
      with check (app.can_view_costs(organization_id) and app.can_edit_catalog(organization_id)
                  and app.org_writable(organization_id) and app.org_has_feature(organization_id, 'products'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_costs' and policyname = 'product_costs_update') then
    create policy product_costs_update on public.product_costs for update to authenticated
      using (app.can_view_costs(organization_id) and app.can_edit_catalog(organization_id) and app.org_writable(organization_id))
      with check (app.can_view_costs(organization_id) and app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_costs' and policyname = 'product_costs_delete') then
    create policy product_costs_delete on public.product_costs for delete to authenticated
      using (app.can_view_costs(organization_id) and app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger product_costs_touch before insert or update on public.product_costs
  for each row execute function app.touch_row();
create or replace trigger product_costs_audit after insert or update or delete on public.product_costs
  for each row execute function app.audit_row();
