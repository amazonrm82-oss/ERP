-- =============================================================================
-- QUO-06 (review H1): a privacy erasure removes the stored PDF of the erased customer's quotes (pasted by hand in the SQL
-- Editor: it holds a row removal)
-- =============================================================================
-- Gives app.quote_pdf_drop (a no-op in 20261006020955) its body. Called only by app.audit_erase_core, for the sent quotes
-- that were detached from the erased contact or deal and whose personal details it empties: their PDF (one files row
-- each, quote_id) goes, and its object follows through the orphan cleanup (trigger files_after_delete -> app.orphan_files
-- -> crm-file-cleanup). Trigger files_keep_attached lets this one path through only while the transaction-local setting
-- app.quote_pdf_erase names the business, set here around the removal; a person's own delete is refused by the files
-- policy. Lead's choice until the owner answers (DECISIONS.md, QUO-06). Safe to run twice. Paste it after
-- 20261006020955 has been applied.

create or replace function app.quote_pdf_drop(p_org uuid, p_quotes uuid[]) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_org is null or p_quotes is null or cardinality(p_quotes) = 0 then
    return;
  end if;
  perform set_config('app.quote_pdf_erase', p_org::text, true);
  delete from public.files f
   where f.organization_id = p_org and f.quote_id = any (p_quotes);
  perform set_config('app.quote_pdf_erase', '', true);
end;
$$;
revoke all on function app.quote_pdf_drop(uuid, uuid[]) from public, anon, authenticated;
