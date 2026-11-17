-- =============================================================================
-- Owner (401) א, 17 November 2026 (RVW-108, BIZ-05): a converted lead's prefill links move to its contact
-- =============================================================================
-- app.prefill_record_live counted a lead as live only while unconverted, so a prefill link sent to a lead answered "not
-- found" from the moment the lead was converted. Now, as LIB-02's library links (021268, leads_library_links_convert):
-- * trigger leads_prefill_links_convert (app.convert_prefill_links, definer, no grants), after converted_at /
--   converted_contact_id are set: every link of the lead moves to the contact the conversion made (lead_id cleared and
--   contact_id set in one update, so prefill_links_one_record holds). The link keeps its token, expiry, submission state and
--   its copied field list. The page and the submit already judge a link by the record it names
--   (app.prefill_record_live / app.prefill_link_usable take a contact link while the contact is live, unchanged), and they
--   judge every copied key against the CONTACT's fields (app.prefill_field_problem with record type 'contact', unchanged):
--   a lead-only key (full_name, company_name, a custom field the contacts do not have) is not shown and not accepted, the
--   existing rule for a key no longer allowed; keys both types have (phone, email, job_title, a custom field of the same key
--   on contacts) keep working. Links of leads converted before this migration stay on the lead (no backfill: a bulk rewrite
--   of rows needs the owner's go-ahead).
-- * app.merge_prefill_links (021265's body): a lead merge sends the duplicate's links to the kept lead, and on to its contact
--   when the kept lead is converted (app.merge_library_links' branch, 021268).
-- Safe to run twice. No drop statement, no delete.

create or replace function app.convert_prefill_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.converted_at is null or new.converted_contact_id is null then
    return null;
  end if;
  update app.prefill_links l set contact_id = new.converted_contact_id, lead_id = null
   where l.organization_id = new.organization_id and l.lead_id = new.id;
  return null;
end;
$$;
revoke all on function app.convert_prefill_links() from public, anon, authenticated, service_role;

create or replace trigger leads_prefill_links_convert
  after update of converted_at, converted_contact_id on public.leads
  for each row
  when (new.converted_at is not null and new.converted_contact_id is not null)
  execute function app.convert_prefill_links();

-- app.merge_prefill_links: 021265's body plus the converted kept lead's branch
create or replace function app.merge_prefill_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_contact uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.lead_id is not null and v_merged <> new.lead_id then
    select l.converted_contact_id into v_contact
      from public.leads l
     where l.organization_id = new.organization_id and l.id = new.lead_id and l.converted_at is not null;
    if v_contact is not null then
      update app.prefill_links l set contact_id = v_contact, lead_id = null
       where l.organization_id = new.organization_id and l.lead_id = v_merged;
    else
      update app.prefill_links l set lead_id = new.lead_id
       where l.organization_id = new.organization_id and l.lead_id = v_merged;
    end if;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update app.prefill_links l set contact_id = new.contact_id
     where l.organization_id = new.organization_id and l.contact_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_prefill_links() from public, anon, authenticated, service_role;
