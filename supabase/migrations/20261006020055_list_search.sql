-- =============================================================================
-- One normalized search for the lists (FXC-11)
-- =============================================================================
-- The global search (migration global_search) folds niqqud, geresh and quotes and final letters
-- with app.search_norm(); the list search box compared the text as typed (ilike), so "דן" did not
-- find "דָּן" in a list although the top-bar search did. The lists now search the same normalized
-- text through one computed field per record type, public.search_text(<table>), filtered from the
-- app as `search_text=like.*<term>*` with the term normalized by searchNorm()
-- (src/lib/search-norm.ts, the mirror of app.search_norm; test 122 compares the two).
-- * leads, contacts and deals: exactly the expression of the global search's trigram index
--   (leads_search_idx, contacts_search_idx, deals_search_idx), so the planner can use it.
-- * companies: the index expression plus the city, which the list already searched, with its own trigram
--   index companies_list_search_idx on exactly that expression.
-- * tasks: the title; products: name, SKU and barcode (the fields the lists searched).
-- Lists match an exact substring after normalization; the near misses of the global search (pg_trgm)
-- stay in the top bar only (owner's lead, 15 October 2026: fuzzy rows confuse a paginated, sorted list).
-- Phones keep matching as typed and by digits (phone, phone_e164) in the app's filter.
-- Security invoker, plain SQL and no SET clause, with schema-qualified names, so the planner inlines
-- them (the advisor's function_search_path_mutable warning on them is expected, as for completeness).
-- They only read the row they are given, which the caller already reads. Safe to run twice.

create or replace function public.search_text(public.leads) returns text
language sql stable
as $$
  select app.search_norm(coalesce(($1).full_name, '') || ' ' || coalesce(($1).company_name, '') || ' ' || coalesce(($1).email, ''))
$$;

create or replace function public.search_text(public.contacts) returns text
language sql stable
as $$
  select app.search_norm(coalesce(($1).full_name, '') || ' ' || coalesce(($1).email, ''))
$$;

create or replace function public.search_text(public.companies) returns text
language sql stable
as $$
  select app.search_norm(($1).name || ' ' || coalesce(($1).tax_id, '') || ' ' || coalesce(($1).email, '') || ' ' || coalesce(($1).city, ''))
$$;

create or replace function public.search_text(public.deals) returns text
language sql stable
as $$
  select app.search_norm(($1).name)
$$;

create or replace function public.search_text(public.tasks) returns text
language sql stable
as $$
  select app.search_norm(($1).title)
$$;

create or replace function public.search_text(public.products) returns text
language sql stable
as $$
  select app.search_norm(($1).name || ' ' || coalesce(($1).sku, '') || ' ' || coalesce(($1).barcode, ''))
$$;

-- the companies list searches the city too, so its expression is not the global search's; its own trigram index
-- (the list and the picker read live companies only, like companies_search_idx)
create index if not exists companies_list_search_idx on public.companies
  using gin (app.search_norm(name || ' ' || coalesce(tax_id, '') || ' ' || coalesce(email, '') || ' ' || coalesce(city, '')) extensions.gin_trgm_ops)
  where deleted_at is null;

revoke all on function public.search_text(public.leads) from public, anon;
revoke all on function public.search_text(public.contacts) from public, anon;
revoke all on function public.search_text(public.companies) from public, anon;
revoke all on function public.search_text(public.deals) from public, anon;
revoke all on function public.search_text(public.tasks) from public, anon;
revoke all on function public.search_text(public.products) from public, anon;
grant execute on function public.search_text(public.leads) to authenticated;
grant execute on function public.search_text(public.contacts) to authenticated;
grant execute on function public.search_text(public.companies) to authenticated;
grant execute on function public.search_text(public.deals) to authenticated;
grant execute on function public.search_text(public.tasks) to authenticated;
grant execute on function public.search_text(public.products) to authenticated;

notify pgrst, 'reload schema';
