-- =============================================================================
-- 0053b Meetings: access helpers and the link check (CAL-01; split from 0053)
-- =============================================================================
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Access helpers (meetings only)
-- ----------------------------------------------------------------------------

-- May the caller read (p_edit = false) or edit (p_edit = true) at least one of
-- the records a meeting is linked to? Each record is looked up inside p_org
-- only, and judged by the same rules as the record itself.
create or replace function app.meeting_subject_ok(
  p_org uuid, p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid, p_edit boolean
) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from (
      select l.owner_id, l.team_id from public.leads l where p_lead is not null and l.organization_id = p_org and l.id = p_lead
      union all
      select c.owner_id, c.team_id from public.contacts c where p_contact is not null and c.organization_id = p_org and c.id = p_contact
      union all
      select co.owner_id, co.team_id from public.companies co where p_company is not null and co.organization_id = p_org and co.id = p_company
      union all
      select d.owner_id, d.team_id from public.deals d where p_deal is not null and d.organization_id = p_org and d.id = p_deal
    ) s
    where case when p_edit then app.can_edit_record(p_org, s.owner_id, s.team_id)
               else app.can_read_record(p_org, s.owner_id, s.team_id) end
  )
$$;
revoke all on function app.meeting_subject_ok(uuid, uuid, uuid, uuid, uuid, boolean) from public, anon;
grant execute on function app.meeting_subject_ok(uuid, uuid, uuid, uuid, uuid, boolean) to authenticated, service_role;

-- Is the caller a participant of the meeting? SECURITY DEFINER so the meetings
-- policies can ask without going through the participants policies (which ask
-- about meetings: that would recurse).
create or replace function app.is_meeting_participant(p_org uuid, p_meeting uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.meeting_participants mp
    where mp.organization_id = p_org and mp.meeting_id = p_meeting and mp.user_id = auth.uid()
  )
$$;
revoke all on function app.is_meeting_participant(uuid, uuid) from public, anon;
grant execute on function app.is_meeting_participant(uuid, uuid) to authenticated, service_role;

-- The edit rule of a meeting, from its row values (used by the meetings update policy).
create or replace function app.meeting_editable(
  p_org uuid, p_meeting uuid, p_owner uuid, p_created_by uuid,
  p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid
) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.can_write(p_org)
     and (app.can_edit_record(p_org, p_owner, null)
          or (p_created_by is not null and p_created_by = auth.uid())
          or app.is_meeting_participant(p_org, p_meeting)
          or app.meeting_subject_ok(p_org, p_lead, p_contact, p_company, p_deal, true))
$$;
revoke all on function app.meeting_editable(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.meeting_editable(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- The same rule by meeting id (used by the participants policies).
create or replace function app.can_edit_meeting(p_org uuid, p_meeting uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select app.meeting_editable(m.organization_id, m.id, m.owner_id, m.created_by,
                                m.lead_id, m.contact_id, m.company_id, m.deal_id)
    from public.meetings m
    where m.organization_id = p_org and m.id = p_meeting
  ), false)
$$;
revoke all on function app.can_edit_meeting(uuid, uuid) from public, anon;
grant execute on function app.can_edit_meeting(uuid, uuid) to authenticated, service_role;

-- Every record a meeting is linked to must be one the writer can see: checked
-- per link that is set or changed, so a participant who records the outcome of
-- a meeting on a record they cannot see is not blocked by the links already
-- there. Server writes (current_user is not a client role) are not checked.
-- SECURITY INVOKER on purpose: it reads current_user.
create or replace function app.meetings_check_links() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (new.lead_id is not null and (tg_op = 'INSERT' or new.lead_id is distinct from old.lead_id)
        and not app.meeting_subject_ok(new.organization_id, new.lead_id, null, null, null, false))
     or (new.contact_id is not null and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
        and not app.meeting_subject_ok(new.organization_id, null, new.contact_id, null, null, false))
     or (new.company_id is not null and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id)
        and not app.meeting_subject_ok(new.organization_id, null, null, new.company_id, null, false))
     or (new.deal_id is not null and (tg_op = 'INSERT' or new.deal_id is distinct from old.deal_id)
        and not app.meeting_subject_ok(new.organization_id, null, null, null, new.deal_id, false)) then
    raise exception 'meeting linked to a record the user cannot see' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.meetings_check_links() from public, anon, authenticated;

create or replace trigger meetings_check_links
  before insert or update of lead_id, contact_id, company_id, deal_id on public.meetings
  for each row execute function app.meetings_check_links();
