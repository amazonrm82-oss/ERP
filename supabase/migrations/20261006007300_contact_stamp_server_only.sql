-- =============================================================================
-- Last / first contact are written by the server only (RVW-12)
-- =============================================================================
-- Since 0057 (LEAD-02) last_contacted_at follows the timeline: trigger
-- activities_last_contact runs app.stamp_last_contact() (security definer) and
-- moves it forward. But the client grants still let anyone who may edit a lead or
-- a contact set it (and a lead's first_contacted_at) straight through the API,
-- for example to take a lead out of the "days without contact" filter. The app
-- itself never writes these columns.
--
-- * leads: since 0038 every client grant on leads is per column; the two columns
--   are taken out of the insert and update grants. Every other column keeps its grant.
-- * contacts: the table-wide insert / update grant of 0004 becomes per column:
--   every column except last_contacted_at, and except full_name, which is
--   generated and cannot be written anyway. Reading is unchanged (select grant).
--   A new contacts column must from now on get
--   grant insert, update (col) on public.contacts to authenticated
--   (like tasks since 0063 and leads since 0038).
-- * The stamp (security definer), conversion (convert_lead, copies the lead's
--   last contact to the new contact) and merge (merge_records) run as the table
--   owner and are not affected.
-- * A client insert or update that names one of these columns now fails with
--   42501, whatever the value.
-- Every statement is safe to run twice (a table-wide revoke also clears column grants).

revoke insert (first_contacted_at, last_contacted_at), update (first_contacted_at, last_contacted_at)
  on public.leads from authenticated;

revoke insert, update on public.contacts from authenticated;

grant insert (
  id, organization_id, first_name, last_name, email, phone, phone_e164, job_title, contact_type,
  company_id, source_id, address_line, city, birth_date, preferred_locale, owner_id, team_id,
  tag_ids, custom_fields, created_by, updated_by, created_at, updated_at, deleted_at,
  import_job_id, type_id
) on public.contacts to authenticated;

grant update (
  id, organization_id, first_name, last_name, email, phone, phone_e164, job_title, contact_type,
  company_id, source_id, address_line, city, birth_date, preferred_locale, owner_id, team_id,
  tag_ids, custom_fields, created_by, updated_by, created_at, updated_at, deleted_at,
  import_job_id, type_id
) on public.contacts to authenticated;
