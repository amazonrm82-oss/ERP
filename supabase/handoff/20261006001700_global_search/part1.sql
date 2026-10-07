-- 20261006001700_global_search: part 1 of 3. Run the parts in order.
-- =============================================================================
-- 0017 Global search
-- =============================================================================
-- public.search_records(org, query): leads, contacts, companies, deals and timeline
-- notes in one call, for the search box in the top bar (Ctrl+K or /).
-- * Runs with the caller's rights (security invoker): RLS decides what is found,
--   exactly as in the lists.
-- * Forgives Hebrew typing: niqqud, geresh and quotes are ignored, final letters
--   match their regular form (app.search_norm), and a near miss still matches
--   (pg_trgm word similarity). Phones match by digits in any format.
-- * Trigram indexes on the normalized text keep it fast on large tables.
-- Every statement is safe to run twice.

create extension if not exists pg_trgm with schema extensions;

-- lower case, no niqqud, no geresh or quotes, final letters as regular ones
create or replace function app.search_norm(p_text text) returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select translate(lower(regexp_replace(coalesce(p_text, ''), '[֑-ׇ]', '', 'g')), 'ךםןףץ׳״''"', 'כמנפצ');
$$;

create index if not exists leads_search_idx on public.leads
  using gin (app.search_norm(coalesce(full_name, '') || ' ' || coalesce(company_name, '') || ' ' || coalesce(email, '')) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists contacts_search_idx on public.contacts
  using gin (app.search_norm(coalesce(full_name, '') || ' ' || coalesce(email, '')) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists companies_search_idx on public.companies
  using gin (app.search_norm(name || ' ' || coalesce(tax_id, '') || ' ' || coalesce(email, '')) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists deals_search_idx on public.deals
  using gin (app.search_norm(name) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists activities_search_idx on public.activities
  using gin (app.search_norm(body) extensions.gin_trgm_ops)
  where body is not null;
create index if not exists leads_phone_trgm_idx on public.leads using gin (phone_e164 extensions.gin_trgm_ops) where deleted_at is null;
create index if not exists contacts_phone_trgm_idx on public.contacts using gin (phone_e164 extensions.gin_trgm_ops) where deleted_at is null;
create index if not exists companies_phone_trgm_idx on public.companies using gin (phone_e164 extensions.gin_trgm_ops) where deleted_at is null;
