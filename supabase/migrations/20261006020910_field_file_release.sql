-- =============================================================================
-- FLD-06 part B: releasing a file field's old file (pasted by hand in the SQL Editor: it holds a delete)
-- =============================================================================
-- Gives app.custom_field_file_drop (a no-op in 20261006020905) its body: the files row of a file field's old value is
-- removed, only when it is a field file of that record and that field. Its object then goes to the orphan cleanup
-- (trigger files_after_delete -> app.orphan_files -> crm-file-cleanup). Callers: a record's value changing or being
-- cleared (*_cf_files_release), a file field being deleted, and a merge's unused duplicate files. Safe to run twice.
-- Paste it after 20261006020905 has been applied; 020905 makes the no-op only while the function does not exist, so a
-- later re-run of 020905 keeps this body.

create or replace function app.custom_field_file_drop(p_org uuid, p_object text, p_record uuid, p_key text, p_file uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.files f
   where f.organization_id = p_org and f.id = p_file and f.custom_field_key = p_key
     and case p_object when 'lead' then f.lead_id = p_record when 'contact' then f.contact_id = p_record
                       when 'company' then f.company_id = p_record when 'deal' then f.deal_id = p_record else false end;
end;
$$;
revoke all on function app.custom_field_file_drop(uuid, text, uuid, text, uuid) from public, anon, authenticated;
