-- =============================================================================
-- 0093 Team managers see their team's meetings (CAL-01, owner's answer 12 October 2026)
-- =============================================================================
-- "In an organization with visibility 'team', a team manager sees the internal
-- meetings of the people in their team, like the rest of the records."
--
-- Why they did not: meetings have no team_id. The organizer rule of
-- meetings_select (0053) is app.can_read_record(organization_id, owner_id, null),
-- and with p_team null app.can_read_record stops before its team branches
-- ("if p_team is null then return false"). So a manager saw a meeting of a team
-- member only through a linked record of their team; an internal meeting (no
-- lead, contact, company or deal) never.
--
-- The change: one more way to read a meeting, app.manages_meeting_organizer().
-- It is the manager branch of app.can_read_record, with the team a record owned
-- by the organizer would get (app.default_team(), 0025/0055: the organizer's
-- only team, else their primary team, else none):
--   * the caller's role in the organization is 'manager', and
--   * they manage that team or one of its ancestors (app.manages_team).
-- Like the records, this does not depend on the organization's visibility: a
-- manager sees their team's leads under 'own' too (the manager branch of
-- app.can_read_record does not look at visibility), and so their team's meetings.
-- Under 'org' everyone sees every meeting already. Plain team members (the
-- in_team branch of 'team' visibility) are not added: the owner's answer is about
-- managers only.
-- It is the organizer rule, so it applies to every meeting the team member
-- organizes, internal or linked (a linked one was mostly visible to the manager
-- already, through the linked record of their team).
-- Editing and deleting are unchanged (meeting_editable / meetings_delete).
--
-- public.meeting_busy() copies the meetings_select expression to decide when a
-- meeting's id and title come back; it gets the same new term, so the two stay
-- exactly in step.
-- Every statement is safe to run twice.

-- true when the caller is a manager (role) of p_org and manages the team a
-- record owned by p_owner would join (the same choice as app.default_team())
create or replace function app.manages_meeting_organizer(p_org uuid, p_owner uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_owner is not null
     and coalesce(app.membership_role(p_org) = 'manager', false)
     and coalesce(app.manages_team((
           select case
                    when count(*) = 1 then min(tm.team_id::text)::uuid
                    else (min(tm.team_id::text) filter (where tm.is_primary))::uuid
                  end
             from public.team_members tm
            where tm.organization_id = p_org and tm.user_id = p_owner
         )), false)
$$;
revoke all on function app.manages_meeting_organizer(uuid, uuid) from public, anon;
grant execute on function app.manages_meeting_organizer(uuid, uuid) to authenticated, service_role;

-- alter, not drop and create: the policy exists since 0053 (meetings_policies.sql)
alter policy meetings_select on public.meetings
  using (app.can_read_record(organization_id, owner_id, null)
         or app.manages_meeting_organizer(organization_id, owner_id)
         or (app.is_member(organization_id)
             and (created_by = (select auth.uid()) or app.is_meeting_participant(organization_id, id)))
         or app.meeting_subject_ok(organization_id, lead_id, contact_id, company_id, deal_id, false));

-- Same as 0084, with the new term in the readable expression.
create or replace function public.meeting_busy(
  p_org uuid,
  p_users uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_exclude uuid default null
) returns table (user_id uuid, meeting_id uuid, title text, starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_org is null or not app.is_member(p_org) or not app.can_write(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if p_users is null or p_from is null or p_to is null
     or cardinality(p_users) > 51 or p_to <= p_from or p_to > p_from + interval '15 days' then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;

  return query
  with people as (
    select distinct m.user_id
    from public.memberships m
    where m.organization_id = p_org
      and m.status = 'active'
      and m.user_id = any (p_users)
  ),
  taken as (
    -- organized
    select mt.owner_id as user_id, mt.id as meeting_id, mt.starts_at, mt.ends_at
    from public.meetings mt
    join people p on p.user_id = mt.owner_id
    where mt.organization_id = p_org
      and mt.status not in ('cancelled', 'no_show')
      and mt.starts_at < p_to and mt.ends_at > p_from
    union
    -- taken part in
    select mp.user_id, mt.id, mt.starts_at, mt.ends_at
    from public.meeting_participants mp
    join people p on p.user_id = mp.user_id
    join public.meetings mt on mt.organization_id = mp.organization_id and mt.id = mp.meeting_id
    where mp.organization_id = p_org
      and mt.status not in ('cancelled', 'no_show')
      and mt.starts_at < p_to and mt.ends_at > p_from
  )
  select t.user_id,
         case when v.readable then mt.id end,
         case when v.readable then mt.title end,
         t.starts_at, t.ends_at
  from taken t
  join public.meetings mt on mt.organization_id = p_org and mt.id = t.meeting_id
  -- MUST stay in step with the meetings_select policy (migrations
  -- 20261006005320_meetings_policies.sql and
  -- 20261006009300_team_manager_internal_meetings.sql): the same expression on
  -- the row, so the id and title come back exactly when the caller could select
  -- the row.
  cross join lateral (
    select (app.can_read_record(mt.organization_id, mt.owner_id, null)
            or app.manages_meeting_organizer(mt.organization_id, mt.owner_id)
            or (app.is_member(mt.organization_id)
                and (mt.created_by = (select auth.uid()) or app.is_meeting_participant(mt.organization_id, mt.id)))
            or app.meeting_subject_ok(mt.organization_id, mt.lead_id, mt.contact_id, mt.company_id, mt.deal_id, false)) as readable
  ) v
  -- the meeting being edited is left out only when the caller may read it:
  -- excluding a hidden meeting by its id would tell who is in it
  where p_exclude is null or t.meeting_id <> p_exclude or not coalesce(v.readable, false)
  order by t.starts_at, t.ends_at, t.user_id, t.meeting_id
  limit 500;
end;
$$;

revoke all on function public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid) to authenticated;
