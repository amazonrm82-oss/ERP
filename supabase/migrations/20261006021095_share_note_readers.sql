-- =============================================================================
-- WAB-06 (owner's answer of 28 October 2026, question (1) answer (ב)): anyone who reads a record may add a share note to it
-- =============================================================================
-- 20261006021090 let a person write a 'share_note' ("הערת שיתוף") only when they may EDIT every record the entry is on
-- (app.can_edit_activity_subjects). The owner chose that a share note follows the rule of an ordinary note instead: a writer
-- (app.can_write: owner, admin, manager or member of a writable business; never a viewer) who READS every record the entry
-- is on (app.can_read_every_activity_subject), exactly like the six logged types of app.contact_types().
--
-- * activities_insert is altered in place; everything else it checks stays as in 20261006021090 (the contact types
--   unchanged, the read check on every subject unchanged). Only the share_note branch loses its edit check.
-- * The mark trigger activities_zz_share_note (author + first line "שותף מהטלפון", hint share_note:mark), the private and
--   activity-type refusals, and activities_update / activities_delete are unchanged.
-- * app.can_edit_activity_subjects stays defined (nothing is removed) but no policy uses it any more.
-- * Answer (2) (א): existing notes are not touched (no rewrite of rows).
-- Safe to run twice.

alter policy activities_insert on public.activities
  with check (app.can_write(organization_id)
              and (type = any (app.contact_types())
                   or type = 'share_note')
              and app.can_read_every_activity_subject(lead_id, contact_id, company_id, deal_id));
