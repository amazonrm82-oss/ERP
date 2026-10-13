-- =============================================================================
-- Billing details of a company and of a contact (CON-08, wave 2)
-- =============================================================================
-- SPEC-ADDITIONS CON-08: "billing details on a company and on a contact: name for
-- the invoice, dealer number, company number or ID number, billing and shipping
-- address, email for invoices, payment terms, price list".
--
-- Nullable columns on public.companies and public.contacts, not a separate table:
-- one set per record, read and written with the record's own rights (RLS of the
-- record, no new policy), audited by the record's audit trigger, exported with the
-- record in the full export, and kept in the recycle bin with it.
--
--   billing_name      the name on the invoice, 1..200 characters, trimmed
--   billing_tax_id    contacts only: a dealer number (עוסק מורשה) or ID number (ת"ז),
--                     9 digits with a valid check digit (app.valid_israeli_id, CON-04;
--                     the app pads shorter numbers to 9). A company's number stays
--                     companies.tax_id (ח.פ. / ע.מ., CON-04) and is not duplicated.
--   billing_address   the address for invoices, 1..300 characters, trimmed
--   shipping_address  the address for deliveries, 1..300 characters, trimmed
--   billing_email     the email for invoices, ≤ 254, same shape as an email custom field
--   payment_terms     'immediate' (מיידי), 'net' (N days after the document date) or
--   payment_days      'eom' (שוטף + N: N days after the end of the document's month);
--                     payment_days 0..365 is required for net and eom and empty for
--                     immediate (constraint *_payment_terms_shape). Mirrored by
--                     PAYMENT_TERMS / paymentDueDate() in src/features/billing/terms.ts
--                     (unit test reads this file); COL-02 computes due dates from it.
--   price_list_id     the customer's price list (public.price_lists, PL-01); composite
--                     foreign key, so it can only point into the same organization; when
--                     the list is deleted only this column is cleared. Documents pulling
--                     the price from it is PL-03.
--
-- A contact whose field is empty shows its company's value, marked "מהחברה"
-- (display only, effectiveBilling() in src/features/billing/billing.ts); nothing is copied.
--
-- Grants: contacts has column-level insert/update grants (0073), so every new column
-- gets its own; companies keeps its table-wide grants (0004). The values are
-- business data with no server-only part. Not part of merge picks yet
-- (app.merge_columns() is shared ground; follow-up). New nullable columns need
-- nothing in app.sample_row() (0121).
--
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- companies
-- ----------------------------------------------------------------------------
alter table public.companies
  add column if not exists billing_name     text,
  add column if not exists billing_address  text,
  add column if not exists shipping_address text,
  add column if not exists billing_email    text,
  add column if not exists payment_terms    text,
  add column if not exists payment_days     smallint,
  add column if not exists price_list_id    uuid;

-- ----------------------------------------------------------------------------
-- contacts
-- ----------------------------------------------------------------------------
alter table public.contacts
  add column if not exists billing_name     text,
  add column if not exists billing_tax_id   text,
  add column if not exists billing_address  text,
  add column if not exists shipping_address text,
  add column if not exists billing_email    text,
  add column if not exists payment_terms    text,
  add column if not exists payment_days     smallint,
  add column if not exists price_list_id    uuid;

-- Constraints and foreign keys, created only when missing. The columns are new and
-- empty, so every constraint is valid at once.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['companies', 'contacts'] loop
    if not exists (select 1 from pg_catalog.pg_constraint where conname = v_table || '_billing_name_check' and conrelid = ('public.' || v_table)::regclass) then
      execute format('alter table public.%I add constraint %I check (billing_name is null or (char_length(billing_name) between 1 and 200 and billing_name = btrim(billing_name)))',
        v_table, v_table || '_billing_name_check');
    end if;
    if not exists (select 1 from pg_catalog.pg_constraint where conname = v_table || '_billing_address_check' and conrelid = ('public.' || v_table)::regclass) then
      execute format('alter table public.%I add constraint %I check (billing_address is null or (char_length(billing_address) between 1 and 300 and billing_address = btrim(billing_address)))',
        v_table, v_table || '_billing_address_check');
    end if;
    if not exists (select 1 from pg_catalog.pg_constraint where conname = v_table || '_shipping_address_check' and conrelid = ('public.' || v_table)::regclass) then
      execute format('alter table public.%I add constraint %I check (shipping_address is null or (char_length(shipping_address) between 1 and 300 and shipping_address = btrim(shipping_address)))',
        v_table, v_table || '_shipping_address_check');
    end if;
    if not exists (select 1 from pg_catalog.pg_constraint where conname = v_table || '_billing_email_check' and conrelid = ('public.' || v_table)::regclass) then
      execute format('alter table public.%I add constraint %I check (billing_email is null or (char_length(billing_email) <= 254 and billing_email ~ %L))',
        v_table, v_table || '_billing_email_check', '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
    end if;
    if not exists (select 1 from pg_catalog.pg_constraint where conname = v_table || '_payment_terms_shape' and conrelid = ('public.' || v_table)::regclass) then
      -- a case, not a chain of or: every branch is true or false, never null (a null would pass)
      execute format($f$alter table public.%I add constraint %I check (
          case
            when payment_terms is null then payment_days is null
            when payment_terms = 'immediate' then payment_days is null
            when payment_terms in ('net', 'eom') then payment_days is not null and payment_days between 0 and 365
            else false
          end)$f$,
        v_table, v_table || '_payment_terms_shape');
    end if;
    if not exists (select 1 from pg_catalog.pg_constraint where conname = v_table || '_price_list_fk' and conrelid = ('public.' || v_table)::regclass) then
      execute format('alter table public.%I add constraint %I foreign key (organization_id, price_list_id) references public.price_lists (organization_id, id) on delete set null (price_list_id)',
        v_table, v_table || '_price_list_fk');
    end if;
  end loop;

  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'contacts_billing_tax_id_check' and conrelid = 'public.contacts'::regclass) then
    alter table public.contacts add constraint contacts_billing_tax_id_check
      check (billing_tax_id is null or (billing_tax_id ~ '^[0-9]{9}$' and app.valid_israeli_id(billing_tax_id)));
  end if;
end;
$$;

-- the foreign keys' lookups when a price list is deleted
create index if not exists companies_price_list_idx on public.companies (organization_id, price_list_id) where price_list_id is not null;
create index if not exists contacts_price_list_idx on public.contacts (organization_id, price_list_id) where price_list_id is not null;

-- contacts: column grants for the new columns (companies has table-wide grants)
grant insert (billing_name, billing_tax_id, billing_address, shipping_address, billing_email, payment_terms, payment_days, price_list_id),
      update (billing_name, billing_tax_id, billing_address, shipping_address, billing_email, payment_terms, payment_days, price_list_id)
  on public.contacts to authenticated;

comment on column public.companies.payment_terms is
  'CON-08: immediate | net (payment_days after the document date) | eom (שוטף + payment_days); null = not set.';
comment on column public.contacts.payment_terms is
  'CON-08: immediate | net (payment_days after the document date) | eom (שוטף + payment_days); null = not set.';
comment on column public.contacts.billing_tax_id is
  'CON-08: dealer or ID number for invoices, 9 digits with a valid check digit (app.valid_israeli_id).';
