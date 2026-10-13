-- =============================================================================
-- Business details printed on documents (TAX-02, wave 2)
-- =============================================================================
-- More columns on public.org_document_settings (TAX-01), the details a quote
-- and a payment request show about the business itself:
--   legal_name          the registered name (שם רשמי), 1..120 characters
--   tax_id              מספר עוסק / ח.פ.: 9 digits whose last is a check digit
--                       (app.valid_israeli_id(), CON-04; the app pads and strips
--                       spaces and dashes first, src/lib/israeli-id.ts)
--   address_line, city, postal_code (5 or 7 digits)
--   phone, email        for documents; may differ from organizations.phone.
--                       The email is also the ORGANIZER of meeting invite files
--                       (CAL-07), so it may hold no control character or quote.
--   bank_name, bank_branch, bank_account, bank_account_name
--                       for a bank transfer; an account number needs the bank
--                       and the branch
-- The logo is the business logo of FLD-04 (organizations.logo_path); it is not
-- copied here. All columns are optional; a document that needs one (a tax
-- invoice needs tax_id) checks it when it is made, in a later wave.
-- Plain CHECK constraints: the table is new, so no older row can fail them.
-- Same rights as TAX-01: members read, owners/admins of a writable
-- organization write (column grants below), audited.
-- Every statement is safe to run twice.

alter table public.org_document_settings add column if not exists legal_name text;
alter table public.org_document_settings add column if not exists tax_id text;
alter table public.org_document_settings add column if not exists address_line text;
alter table public.org_document_settings add column if not exists city text;
alter table public.org_document_settings add column if not exists postal_code text;
alter table public.org_document_settings add column if not exists phone text;
alter table public.org_document_settings add column if not exists email text;
alter table public.org_document_settings add column if not exists bank_name text;
alter table public.org_document_settings add column if not exists bank_branch text;
alter table public.org_document_settings add column if not exists bank_account text;
alter table public.org_document_settings add column if not exists bank_account_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.org_document_settings'::regclass and conname = 'org_document_settings_details_check') then
    alter table public.org_document_settings add constraint org_document_settings_details_check check (
      (legal_name is null or char_length(btrim(legal_name)) between 1 and 120)
      and (tax_id is null or (tax_id ~ '^[0-9]{9}$' and app.valid_israeli_id(tax_id)))
      and (address_line is null or char_length(btrim(address_line)) between 1 and 200)
      and (city is null or char_length(btrim(city)) between 1 and 100)
      and (postal_code is null or postal_code ~ '^([0-9]{5}|[0-9]{7})$')
      and (phone is null or phone ~ '^\+?[0-9[:space:]().*-]{3,24}$')
      and (email is null or (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                             and email !~ '[[:cntrl:]"]'))
      and (bank_name is null or char_length(btrim(bank_name)) between 1 and 80)
      and (bank_branch is null or bank_branch ~ '^[0-9]{1,4}$')
      and (bank_account is null or bank_account ~ '^[0-9]{2,20}$')
      and (bank_account_name is null or char_length(btrim(bank_account_name)) between 1 and 120));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.org_document_settings'::regclass and conname = 'org_document_settings_bank_check') then
    alter table public.org_document_settings add constraint org_document_settings_bank_check
      check (bank_account is null or (bank_name is not null and bank_branch is not null));
  end if;
end;
$$;

comment on column public.org_document_settings.tax_id is
  'TAX-02: מספר עוסק / ח.פ., 9 digits with a valid check digit (app.valid_israeli_id); null = not given.';

grant insert (legal_name, tax_id, address_line, city, postal_code, phone, email,
              bank_name, bank_branch, bank_account, bank_account_name)
  on public.org_document_settings to authenticated;
grant update (legal_name, tax_id, address_line, city, postal_code, phone, email,
              bank_name, bank_branch, bank_account, bank_account_name)
  on public.org_document_settings to authenticated;
