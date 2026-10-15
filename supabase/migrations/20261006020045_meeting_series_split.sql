-- =============================================================================
-- 0199b Moving a meeting series to another weekday (CAL-09, owner 15 October 2026)
-- =============================================================================
-- "This and following" with a new weekday splits the series: the app first makes the new
-- series (public.create_meeting_series, one transaction), then removes the old planned
-- meetings from the split point with the user's session. To refuse the whole split up front
-- when the user may not remove every one of them (so the business never keeps two overlapping
-- series by surprise), the app asks:
-- * public.meetings_removable(org, ids): security invoker. The ids, of those given, that the
--   caller could delete right now: the same expression as the meetings_delete policy (migrations
--   20261006005320_meetings_policies.sql and 20261006009700_team_manager_edit_meetings.sql; keep
--   the two in step; tests/db/99-meeting-series compares them with real deletes). Being
--   invoker, a meeting the caller cannot read is never returned. Read only.
-- No delete, no drop. Safe to run twice.

create or replace function public.meetings_removable(p_org uuid, p_ids uuid[])
returns setof uuid
language sql stable security invoker
set search_path = ''
as $$
  select m.id
    from public.meetings m
   where m.organization_id = p_org
     and m.id = any (p_ids)
     -- MUST stay in step with the meetings_delete policy
     and (app.can_delete_record(m.organization_id, m.owner_id, null)
          or (app.can_write(m.organization_id) and app.manages_meeting_organizer(m.organization_id, m.owner_id))
          or (m.created_by = (select auth.uid()) and app.can_write(m.organization_id)))
$$;
revoke all on function public.meetings_removable(uuid, uuid[]) from public, anon;
grant execute on function public.meetings_removable(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
