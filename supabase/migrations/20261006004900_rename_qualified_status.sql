-- =============================================================================
-- 0049 Existing businesses: the lead status "מוסמך" becomes "מתאים" (FXU-08)
-- =============================================================================
-- New businesses already get "מתאים" (0047). The owner approved renaming the
-- rows of existing businesses on 9 October 2026 (DECISIONS.md). Only the name
-- changes: the status keeps its id, kind and position, so leads stay on it.
-- A business that already has a status called "מתאים" keeps both as they are.
-- Safe to run twice: the second run finds nothing to rename.

update public.lead_statuses s
   set name = 'מתאים'
 where s.name = 'מוסמך'
   and s.kind = 'open'
   and not exists (
     select 1 from public.lead_statuses o
      where o.organization_id = s.organization_id and o.name = 'מתאים'
   );
