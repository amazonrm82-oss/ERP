-- =============================================================================
-- PRV-03: the rows a person's removal deletes. PASTED BY THE OWNER in the SQL Editor (it deletes rows).
-- =============================================================================
-- Called only by public.privacy_erase_person (20261006020530_person_erase_set.sql), after its checks and locks: the form
-- inquiries of the person's leads, then the leads and contacts, binned and deleted for good (further channels, files,
-- followers and links by cascade; activities and tasks of the record alone through app.purge_links). Every statement is
-- scoped to the business. No role may run it. Answers {inquiries, leads, contacts}. Safe to paste twice.

create or replace function app.person_erase_delete_rows(p_org uuid, p_leads uuid[], p_contacts uuid[]) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inquiries integer := 0;
  v_leads integer := 0;
  v_contacts integer := 0;
begin
  delete from public.form_submissions s where s.organization_id = p_org and s.lead_id = any (p_leads);
  get diagnostics v_inquiries = row_count;
  update public.leads l set deleted_at = now()
   where l.organization_id = p_org and l.id = any (p_leads) and l.deleted_at is null;
  update public.contacts c set deleted_at = now()
   where c.organization_id = p_org and c.id = any (p_contacts) and c.deleted_at is null;
  delete from public.leads l where l.organization_id = p_org and l.id = any (p_leads);
  get diagnostics v_leads = row_count;
  delete from public.contacts c where c.organization_id = p_org and c.id = any (p_contacts);
  get diagnostics v_contacts = row_count;
  return jsonb_build_object('inquiries', v_inquiries, 'leads', v_leads, 'contacts', v_contacts);
end;
$$;
revoke all on function app.person_erase_delete_rows(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;
