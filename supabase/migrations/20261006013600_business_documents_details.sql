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
-- Bank details for a transfer are NOT here: only owners and admins may read
-- them, so they live in their own table, public.org_bank_details (migration
-- org_bank_details), which documents copy as a snapshot.
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
                             and email !~ '[[:cntrl:]"]')));
  end if;
end;
$$;

comment on column public.org_document_settings.tax_id is
  'TAX-02: מספר עוסק / ח.פ., 9 digits with a valid check digit (app.valid_israeli_id); null = not given.';

grant insert (legal_name, tax_id, address_line, city, postal_code, phone, email)
  on public.org_document_settings to authenticated;
grant update (legal_name, tax_id, address_line, city, postal_code, phone, email)
  on public.org_document_settings to authenticated;
