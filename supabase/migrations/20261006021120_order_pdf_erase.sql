-- =============================================================================
-- ORD-05 PDF: a privacy erasure removes the stored PDF of the erased customer's orders (pasted by hand in the SQL Editor: it
-- holds a row removal)
-- =============================================================================
-- Gives app.order_pdf_drop (a no-op in 20261006021119) its body. Called only by app.audit_erase_core, for the numbered orders
-- that were detached from the erased contact, company or deal and whose personal details it empties: their PDF (one files
-- row each, order_id) goes, and its object follows through the orphan cleanup (trigger files_after_delete ->
-- app.orphan_files -> crm-file-cleanup). Trigger files_keep_attached lets this one path through only while the
-- transaction-local setting app.order_pdf_erase names the business, set here around the removal; a person's own delete is
-- refused by the files policy. The rule of QUO-06 (owner's answer (2) א) for orders. Safe to run twice. Paste it after
-- 20261006021119 has been applied.

create or replace function app.order_pdf_drop(p_org uuid, p_orders uuid[]) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_org is null or p_orders is null or cardinality(p_orders) = 0 then
    return;
  end if;
  perform set_config('app.order_pdf_erase', p_org::text, true);
  delete from public.files f
   where f.organization_id = p_org and f.order_id = any (p_orders);
  perform set_config('app.order_pdf_erase', '', true);
end;
$$;
revoke all on function app.order_pdf_drop(uuid, uuid[]) from public, anon, authenticated, service_role;
