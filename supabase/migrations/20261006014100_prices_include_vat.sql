-- =============================================================================
-- Prices typed and shown before VAT or including VAT (TAX-04, wave 2)
-- =============================================================================
-- public.org_document_settings.prices_include_vat: how the business types and
-- reads prices (product prices, document lines):
--   false (default)  "לפני מע"מ": a price is net; VAT is added on top.
--   true             "כולל מע"מ": a price already includes VAT; the net and the
--                    VAT are taken out of it (app.document_totals(), TAX-05).
-- A business that charges no VAT (TAX-01) sees the same numbers either way.
--
-- The rule for documents (quotes, orders, documents; later waves), which
-- the document tables must follow when they are built:
--   * every document stores its own prices_include_vat (boolean not null);
--   * when a document is created it takes the organization's setting (no row
--     yet = false); the person may change it on that document alone;
--   * a later change of this setting never changes a document that exists.
-- TS: documentPricesIncludeVat() in src/features/tax/prices.ts.
--
-- Rights: like the rest of the row (TAX-01): members read, owners and admins of
-- a writable organization write through the column grants below. Audited by
-- org_document_settings_audit. Not null with a default, so older rows read false.
-- Every statement is safe to run twice.

alter table public.org_document_settings
  add column if not exists prices_include_vat boolean not null default false;

comment on column public.org_document_settings.prices_include_vat is
  'TAX-04: true = prices are typed and shown including VAT; false = before VAT. A document copies it when created and may change it for itself.';

grant insert (prices_include_vat) on public.org_document_settings to authenticated;
grant update (prices_include_vat) on public.org_document_settings to authenticated;
