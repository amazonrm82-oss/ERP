-- 20261006002000_merge_records: part 1 of 4. Run the parts in order.
-- =============================================================================
-- 0020 Merging duplicates
-- =============================================================================
-- public.merge_records(org, type, keep, merge, picks): two leads, contacts or
-- companies become one.
-- * picks: { "<column>": "merge" } takes that field from the duplicate; every other
--   field stays as it is on the kept record. Only the listed columns can be picked.
-- * Tags are joined; custom fields are joined, the kept record's values win.
-- * Everything that pointed at the duplicate moves to the kept record: timeline,
--   tasks, files, notifications, deals, deal participants, contacts of a company,
--   lead form submissions and conversion links.
-- * The duplicate is then deleted for good (it is in the audit log in full), and
--   a timeline entry on the kept record says what was merged.
-- * Allowed to whoever may edit the kept record and delete the duplicate
--   (team managers and admins), in a writable organization.
-- Every statement is safe to run twice.

create or replace function app.merge_columns(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['full_name', 'email', 'phone', 'company_name', 'job_title', 'status_id', 'source_id',
                           'campaign', 'message', 'budget_agorot', 'owner_id']
    when 'contact' then array['first_name', 'last_name', 'email', 'phone', 'job_title', 'company_id', 'source_id',
                              'address_line', 'city', 'birth_date', 'owner_id']
    when 'company' then array['name', 'tax_id', 'industry', 'website', 'email', 'phone', 'address_line', 'city', 'owner_id']
  end;
$$;
