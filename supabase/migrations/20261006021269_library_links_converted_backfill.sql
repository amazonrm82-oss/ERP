-- =============================================================================
-- RVW-90 backfill (owner's answer (372) ב, 13 November 2026): the library links of leads that were converted BEFORE
-- 20261006021268 (whose trigger leads_library_links_convert moves them from now on) are moved to the lead's contact,
-- the same move as app.convert_library_links: lead_id = null, contact_id = the lead's converted_contact_id, only rows of
-- the lead's own business and only while that contact still exists (the composite FK keeps it inside the business).
-- The public link keeps working (app.library_record_live reads any record type). Counted before and after on hosted
-- with read-only queries (the lead's note in docs/BACKLOG.md). An update of existing rows, approved by the owner.
-- Safe to run twice: a second run finds no link on a converted lead.
-- =============================================================================

update public.library_links k
   set contact_id = l.converted_contact_id, lead_id = null
  from public.leads l
 where k.organization_id = l.organization_id
   and k.lead_id = l.id
   and l.converted_at is not null
   and l.converted_contact_id is not null
   and exists (select 1 from public.contacts c
                where c.organization_id = l.organization_id and c.id = l.converted_contact_id);
