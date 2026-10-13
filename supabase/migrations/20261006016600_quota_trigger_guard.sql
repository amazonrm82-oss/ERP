-- =============================================================================
-- Products quota: no plan state for outsiders (PRD-08 follow-up)
-- =============================================================================
-- app.products_quota (migration product_quota) is a security definer before
-- insert trigger, so it runs before RLS checks the row. A signed-in person who
-- is not an owner or admin of the business (an outsider who sends another
-- business's id, or a member) got the hint 'feature:products' or
-- 'limit:max_products' instead of the plain 42501 of the products_insert
-- policy, and so learned that business's plan state.
--
-- The body is that of migration product_quota with one guard first: when the
-- write comes from a session (auth.uid() is set; not current_user, which is
-- the owner inside a definer) and the caller is not an owner or admin of the
-- business, the trigger lets the row through to RLS, which refuses it. Server
-- writers without a session (imports run with the person's session and are
-- owners or admins) are still counted. The same guard is in
-- app.price_lists_quota and app.price_list_lines_check (PL-01, PL-02).
--
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.products_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  -- RLS refuses this writer right after; answer nothing about the plan
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
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
