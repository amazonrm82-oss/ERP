-- =============================================================================
-- DOC-15 part 2 (owner, 18 November 2026, answer (413) ג): the business chooses how a sent accounting document goes to the
-- customer by email: 'system' (default: our email with the link to the customer's document page, migration document_links)
-- or 'provider' (the invoicing provider emails it). Owners and admins of a writable business write it through column grants
-- (the table's own policies). It is stored only: the issue request's sendEmail still comes from
-- invoice_provider_settings.provider_sends_email (DOC-05), read by public.invoice_issue_claim, which test 381 pins by md5.
-- Every statement is safe to run twice. No drops, no row removal.
-- =============================================================================
alter table public.org_document_settings add column if not exists document_delivery text not null default 'system';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_document_settings_document_delivery'
                   and conrelid = 'public.org_document_settings'::regclass) then
    alter table public.org_document_settings add constraint org_document_settings_document_delivery
      check (document_delivery in ('system', 'provider')) not valid;
  end if;
end;
$$;
alter table public.org_document_settings validate constraint org_document_settings_document_delivery;
grant select (document_delivery) on public.org_document_settings to authenticated;
grant insert (document_delivery) on public.org_document_settings to authenticated;
grant update (document_delivery) on public.org_document_settings to authenticated;
