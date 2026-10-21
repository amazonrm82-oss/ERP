-- =============================================================================
-- A business's currency is shekels only, until DEAL-12 (TAX-06 follow-up)
-- =============================================================================
-- organizations.currency (char(3), default 'ILS', since foundation) is open to owners and admins through the API
-- (column grant in rls), though no screen writes it. Every amount table is ILS-only (TAX-06), so a business set to
-- another currency could no longer add sample data: public.sample_data_add makes its deal in the business's currency
-- and deals_currency_ils refuses it. The same check on the business closes that gap; sample_data_add is unchanged.
-- DEAL-12 (wave 6) lifts this check together with the others.
-- Hosted held 3 businesses, all ILS, when checked read-only on 21 October 2026, so the check validates.
-- Added only when missing, so the file is safe to run twice. No drops, no row changes.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.organizations'::regclass and conname = 'organizations_currency_ils'
  ) then
    alter table public.organizations add constraint organizations_currency_ils check (currency = 'ILS');
  end if;
end;
$$;
