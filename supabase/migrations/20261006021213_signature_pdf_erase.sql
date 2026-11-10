-- =============================================================================
-- SGN-02 review 1: a person's erasure removes the signed PDF of the documents for signature that named them
-- (pasted by hand in the SQL Editor: it holds a row removal)
-- =============================================================================
-- Gives app.signature_pdf_drop (a placeholder in 20261006021212) its body. Called only by app.signature_documents_erase, from
-- app.audit_erase_core, for the documents whose text and signature that erasure has just emptied. The files rows of those
-- documents' signed PDFs are removed; their objects go to the orphan cleanup (files_after_delete -> app.orphan_files).
-- files_keep_attached does not hold a signed document's PDF, and no person can reach this (no grants). Safe to run twice.
-- Paste it after 20261006021212 has been applied.

create or replace function app.signature_pdf_drop(p_org uuid, p_docs uuid[]) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_org is null or coalesce(cardinality(p_docs), 0) = 0 then
    return;
  end if;
  delete from public.files f
   where f.organization_id = p_org and f.signature_document_id = any (p_docs);
end;
$$;
revoke all on function app.signature_pdf_drop(uuid, uuid[]) from public, anon, authenticated, service_role;
