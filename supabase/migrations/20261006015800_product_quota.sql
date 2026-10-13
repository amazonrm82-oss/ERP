-- =============================================================================
-- Products: plan quota and capability (PRD-08, wave 2)
-- =============================================================================
-- SPEC-ADDITIONS 15.5 and the owner's pricing of 13 October 2026: the catalog
-- holds at most app.org_limit(org, 'max_products') products (100 / 500 / 5,000 /
-- 50,000; a per-business override on subscriptions.limit_overrides wins), and
-- the module needs the capability 'products' (on in every sold plan; a plan
-- without the key falls back to app.plan_key_defaults(), which is off).
--
-- What counts: EVERY row of public.products of the organization, active,
-- inactive and archived alike. An archived product is still in the catalog (it
-- stays on the list under the "archived" filter, and documents point at it), and
-- counting it closes the loop "archive, add, bring back". A product that no
-- document uses can be removed, which frees its place.
--
-- products_quota (before insert, security definer so the count sees every row
-- whatever the caller may read) takes a per-organization advisory lock first, so
-- two inserts at the same moment cannot both pass the count (like
-- product_units_cap). It runs for every writer, the import included (PRD-05),
-- so an import stops at the quota row by row.
--
-- The capability is checked in the same trigger (hint 'feature:products', which
-- the app turns into a Hebrew message) and also in the products_insert policy,
-- so a write without the capability is refused even if the trigger is ever
-- replaced. A before-row trigger runs before the policy check, so the person
-- sees the message, not a bare permission error.
--
-- public.org_plan_usage() lists max_products, so /settings/plan shows it.
-- Its body is that of 0046 with one row added.
--
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.products_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  if not app.org_has_feature(new.organization_id, 'products') then
    raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_products');
  if v_limit is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('products:' || new.organization_id::text, 0));
  if (select count(*) from public.products p where p.organization_id = new.organization_id) + 1 > v_limit then
    raise exception 'plan limit reached (max_products = %)', v_limit using errcode = 'P0001', hint = 'limit:max_products';
  end if;
  return new;
end;
$$;
revoke all on function app.products_quota() from public, anon, authenticated;

create or replace trigger products_quota before insert on public.products
  for each row execute function app.products_quota();

alter policy products_insert on public.products
  with check (app.is_admin(organization_id) and app.org_writable(organization_id)
              and app.org_has_feature(organization_id, 'products'));

create or replace function public.org_plan_usage(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not app.is_member(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'plan_key', s.plan_key,
    'plan_name', p.name_he,
    'status', s.status,
    'trial_ends_at', s.trial_ends_at,
    'seats', s.seats,
    'usage', jsonb_build_array(
      jsonb_build_object('key', 'max_users', 'limit', app.org_limit(p_org, 'max_users'),
        'used', (select count(*) from public.memberships m
                  where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full')),
      jsonb_build_object('key', 'max_records', 'limit', app.org_limit(p_org, 'max_records'),
        'used', coalesce((select u.records_count from public.org_usage u where u.organization_id = p_org), 0)),
      jsonb_build_object('key', 'max_pipelines', 'limit', app.org_limit(p_org, 'max_pipelines'),
        'used', (select count(*) from public.pipelines pl where pl.organization_id = p_org and pl.deleted_at is null)),
      jsonb_build_object('key', 'max_forms', 'limit', app.org_limit(p_org, 'max_forms'),
        'used', (select count(*) from public.forms f where f.organization_id = p_org and f.kind = 'form')),
      jsonb_build_object('key', 'max_active_automations', 'limit', app.org_limit(p_org, 'max_active_automations'),
        'used', (select count(*) from public.automations a where a.organization_id = p_org and a.is_active)),
      jsonb_build_object('key', 'storage_gb', 'limit', app.org_limit(p_org, 'storage_gb'),
        'used', round(coalesce((select sum(fl.size_bytes) from public.files fl where fl.organization_id = p_org), 0) / 1073741824.0, 3)),
      jsonb_build_object('key', 'max_products', 'limit', app.org_limit(p_org, 'max_products'),
        'used', (select count(*) from public.products pr where pr.organization_id = p_org))
    )
  )
  into v_result
  from public.subscriptions s
  join public.plans p on p.key = s.plan_key
  where s.organization_id = p_org;

  return v_result;
end;
$$;
revoke all on function public.org_plan_usage(uuid) from public, anon;
grant execute on function public.org_plan_usage(uuid) to authenticated;
