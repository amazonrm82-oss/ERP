-- =============================================================================
-- 0097 Team managers edit and cancel their team's meetings (CAL-01, owner's answer 12 October 2026)
-- =============================================================================
-- 0093 let a team manager SEE the meetings organized by the people of their team
-- (app.manages_meeting_organizer). The owner's answer: they also edit and cancel
-- them, like leads (the manager branch of app.can_edit_record, and deleting is
-- for admins and team managers, app.can_delete_record).
--
-- * Edit: app.meeting_editable (used by meetings_update, and through
--   app.can_edit_meeting by the meeting_participants insert/delete policies)
--   gets the term app.manages_meeting_organizer(p_org, p_owner), inside the
--   app.can_write() it already starts with. Cancelling is an update (status
--   'cancelled'), so it follows. Changing who takes part follows too.
-- * Delete: a meeting has no recycle bin; deleting removes one set up by
--   mistake. Its policy is "can_delete_record on the organizer, or the creator";
--   with p_team null can_delete_record never reaches its team branch, so the same
--   term is added (with app.can_write, the org_writable check can_delete_record has).
--
-- Who may see a meeting does not change. Who may change the organizer does not
-- change either (app.meetings_check_owner: the organizer, the creator, or an
-- owner/admin). Only the manager-role branch is added: like the records, it does
-- not depend on the organization's visibility.
-- Every statement is safe to run twice.

create or replace function app.meeting_editable(
  p_org uuid, p_meeting uuid, p_owner uuid, p_created_by uuid,
  p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid
) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.can_write(p_org)
     and (app.can_edit_record(p_org, p_owner, null)
          or app.manages_meeting_organizer(p_org, p_owner)
          or (p_created_by is not null and p_created_by = auth.uid())
          or app.is_meeting_participant(p_org, p_meeting)
          or app.meeting_subject_ok(p_org, p_lead, p_contact, p_company, p_deal, true))
$$;
revoke all on function app.meeting_editable(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.meeting_editable(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- alter, not drop and create: the policy exists since 0053 (meetings_policies.sql)
alter policy meetings_delete on public.meetings
  using (app.can_delete_record(organization_id, owner_id, null)
         or (app.can_write(organization_id) and app.manages_meeting_organizer(organization_id, owner_id))
         or (created_by = (select auth.uid()) and app.can_write(organization_id)));
