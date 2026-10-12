-- =============================================================================
-- Team managers pin and unpin their team's notes (REC-01, owner's decision 12 October 2026)
-- =============================================================================
-- * A manager may pin and unpin what a person logged (note, call, meeting, email,
--   WhatsApp, SMS) on a record of a team they manage (app.manages_team: the team
--   or an ancestor of it), whoever wrote it. Only pinning: they do not edit what
--   it says and do not delete it.
-- * activities_update gains that case (app.manages_activity_subject). The column
--   grants stay as they are (body, metadata, occurred_at, is_pinned).
-- * Trigger activities_edit_window now also refuses, at any age, a change other
--   than is_pinned / updated_at by a user who is neither an owner/admin nor the
--   author (42501, hint 'note:pin_only'). The author's 24 hours are unchanged.
-- * activities_delete is unchanged: a manager does not delete someone else's note.
-- Every statement is safe to run twice.

-- true when the caller is a manager (role) of p_org and manages the team of at
-- least one of the records the activity hangs on
create or replace function app.manages_activity_subject(
  p_org uuid, p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid
) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org) = 'manager', false)
     and exists (
       select 1
         from (
           select l.team_id from public.leads l
            where p_lead is not null and l.organization_id = p_org and l.id = p_lead
           union all
           select c.team_id from public.contacts c
            where p_contact is not null and c.organization_id = p_org and c.id = p_contact
           union all
           select co.team_id from public.companies co
            where p_company is not null and co.organization_id = p_org and co.id = p_company
           union all
           select d.team_id from public.deals d
            where p_deal is not null and d.organization_id = p_org and d.id = p_deal
         ) s
        where s.team_id is not null and app.manages_team(s.team_id)
     )
$$;
revoke all on function app.manages_activity_subject(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.manages_activity_subject(uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- alter, not drop and create: the policy exists since 0004 (rls.sql), changed in 0052
alter policy activities_update on public.activities
  using (app.can_write(organization_id)
         and (app.is_admin(organization_id)
              or (type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
                  and (created_by = (select auth.uid())
                       or app.manages_activity_subject(organization_id, lead_id, contact_id, company_id, deal_id)))))
  with check (app.can_write(organization_id));

-- what an entry says: owners and admins always, the author for 24 hours, nobody else;
-- pinning is free for whoever the policy lets through
create or replace function app.activities_edit_window() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  -- columns the server stamps itself (touch_row), and the one that pinning changes
  v_free constant text[] := array['is_pinned', 'updated_at'];
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user in ('authenticated', 'anon')
     and (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free)
     and not app.is_admin(old.organization_id) then
    if old.created_by is distinct from (select auth.uid()) then
      raise exception 'note pin only' using errcode = '42501', hint = 'note:pin_only';
    end if;
    if old.created_at <= now() - interval '24 hours' then
      raise exception 'note edit window closed' using errcode = '42501', hint = 'note:edit_window';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_edit_window() from public, anon, authenticated;

create or replace trigger activities_edit_window before update on public.activities
  for each row execute function app.activities_edit_window();
