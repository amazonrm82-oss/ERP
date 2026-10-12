-- =============================================================================
-- Registration number of a company outside Israel (CON-04)
-- =============================================================================
-- Owner's decision, 12 October 2026: a company's number (companies.tax_id) is
-- optional in Israel and abroad, and the field is shown for every country.
-- * country = 'IL': unchanged from migration israeli_ids (0064). A number a browser
--   session sets must pass app.valid_israeli_id() (hint 'tax_id:invalid') and is
--   stored as 9 digits.
-- * any other country: until now not checked at all. A number a browser session
--   sets is now trimmed and must be 2 to 30 characters of Latin letters, digits,
--   spaces, '-', '.' and '/' (hint 'tax_id:invalid_foreign'). It is stored trimmed,
--   as typed (no padding). Mirrors foreignCompanyNumber() in
--   src/features/companies/tax-id.ts.
-- As before: only browser writes (authenticated / anon) are checked, and only when
-- the number or the country is being changed, so a row saved earlier never blocks
-- an unrelated update. Moving a company between countries checks its number
-- against the new country's rule (an Israeli 9-digit number also passes abroad).
-- Only the function is replaced; trigger companies_tax_id_check (before insert or
-- update of tax_id, country) stays as 0064 created it.
-- * companies.country: new check constraint companies_country_code, two capital
--   letters (ISO 3166-1 alpha-2), so a lowercase 'il' cannot slip past the Israeli
--   check. Added NOT VALID, then validated only when every existing row passes
--   (the app never wrote country before, so rows hold the default 'IL'). If some
--   row does not pass it stays NOT VALID: new and changed rows are still checked,
--   and the lead is told to fix those rows with a later migration.
-- Safe to run twice.

create or replace function app.check_company_tax_id() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user not in ('authenticated', 'anon') or new.tax_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.tax_id is not distinct from old.tax_id and new.country is not distinct from old.country then
    return new;
  end if;
  if new.country is distinct from 'IL' then
    new.tax_id := btrim(new.tax_id, E' \t\r\n');
    if new.tax_id !~ '^[A-Za-z0-9 ./-]{2,30}$' then
      raise exception 'invalid company number' using errcode = 'P0001', hint = 'tax_id:invalid_foreign';
    end if;
    return new;
  end if;
  if not app.valid_israeli_id(new.tax_id) then
    raise exception 'invalid company number' using errcode = 'P0001', hint = 'tax_id:invalid';
  end if;
  new.tax_id := lpad(new.tax_id, 9, '0');
  return new;
end;
$$;
revoke all on function app.check_company_tax_id() from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'companies_country_code' and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies add constraint companies_country_code check (country ~ '^[A-Z]{2}$') not valid;
  end if;
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'companies_country_code' and conrelid = 'public.companies'::regclass and not convalidated
  ) and not exists (select 1 from public.companies where country !~ '^[A-Z]{2}$') then
    alter table public.companies validate constraint companies_country_code;
  end if;
end;
$$;
