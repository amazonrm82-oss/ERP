-- =============================================================================
-- One-time conversion of free-text contact/company types into type_id (CON-02)
-- =============================================================================
-- Approved by the owner on 12 October 2026. Before CON-02, contacts.contact_type
-- and companies.company_type were free text; since 0065 a record points at a
-- type of the organization's list (type_id), and the old text is shown only
-- while no type is set. This migration links the old text to the list:
-- * Only an exact match to the name of an ACTIVE type of the same organization
--   and object type, after removing extra whitespace from the old text (trimmed,
--   inner runs of whitespace collapsed to one space). No case folding, no fuzzy
--   matching. Hidden types are not matched: the forms do not offer them, and a
--   record should not be given a type nobody can pick any more.
-- * Only rows whose type_id is null; rows in the recycle bin too (a restored
--   record shows its type). A value with no match stays as it is and is still
--   shown. The old text columns are neither changed nor removed.
-- * Housekeeping, not an edit by a person: app.automation_running is on while
--   the updates run (as in transfer_records and convert_lead, 0070), so the
--   contact.updated / company.updated events are marked origin 'automation' and
--   start no automation; the previous value is put back afterwards.
-- * What the other triggers do on these updates: touch_row sets updated_at to
--   now() and keeps updated_by (no user in a migration); audit_row writes one
--   'update' entry per converted row ({type_id: {old: null, new: ...}}, no actor);
--   *_type_check fires (update of type_id) but skips server writes; the custom
--   fields, tax id, count, soft-delete, owner/team and import triggers are
--   limited to other columns and do not fire; *_normalize recomputes the same
--   phone_e164; contacts_touch_contact_stamp acts only while app.contact_stamp is on.
-- * RAISE NOTICE reports how many contacts and companies were converted and how
--   many still have free text with no type.
-- Safe to run twice: the second run finds no row with a null type_id that
-- matches, and changes nothing.

do $$
declare
  v_automation text := current_setting('app.automation_running', true);
  v_contacts integer;
  v_companies integer;
  v_contacts_left integer;
  v_companies_left integer;
begin
  perform set_config('app.automation_running', 'on', true);

  update public.contacts c
     set type_id = r.id
    from public.record_type_options r
   where c.type_id is null
     and c.contact_type is not null
     and r.organization_id = c.organization_id
     and r.object_type = 'contact'
     and r.is_active
     and r.name = btrim(regexp_replace(c.contact_type, '\s+', ' ', 'g'));
  get diagnostics v_contacts = row_count;

  update public.companies c
     set type_id = r.id
    from public.record_type_options r
   where c.type_id is null
     and c.company_type is not null
     and r.organization_id = c.organization_id
     and r.object_type = 'company'
     and r.is_active
     and r.name = btrim(regexp_replace(c.company_type, '\s+', ' ', 'g'));
  get diagnostics v_companies = row_count;

  perform set_config('app.automation_running', coalesce(v_automation, ''), true);

  select count(*) into v_contacts_left from public.contacts c
   where c.type_id is null and btrim(regexp_replace(coalesce(c.contact_type, ''), '\s+', ' ', 'g')) <> '';
  select count(*) into v_companies_left from public.companies c
   where c.type_id is null and btrim(regexp_replace(coalesce(c.company_type, ''), '\s+', ' ', 'g')) <> '';

  raise notice 'free-text types converted: % contacts, % companies; still free text with no type: % contacts, % companies',
    v_contacts, v_companies, v_contacts_left, v_companies_left;
end;
$$;
