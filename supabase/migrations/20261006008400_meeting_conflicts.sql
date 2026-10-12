-- =============================================================================
-- 0084 Meeting conflicts: busy times of the people in a meeting (CAL-05)
-- =============================================================================
-- When a meeting is set, edited or moved, the app warns about people who
-- already have another meeting at that time. Meetings are visible by the record
-- rules (0053), so with visibility 'own' or 'team' a member does not see a
-- colleague's meetings at all, and a check made with the user's rights alone
-- would miss exactly the clashes it is meant to catch.
--
-- public.meeting_busy() answers "when is each of these people busy" for writers
-- of the same organization: per person, the meetings (organized or taken part
-- in) that overlap the given time, with their start and end. The id and the
-- title come back only for a meeting the caller may read (the same rule as the
-- meetings_select policy); for any other meeting both are null, so rows of a
-- hidden meeting cannot be joined across people to learn who meets whom. No
-- place, customer or anything else of a meeting comes back. The app shows a
-- hidden meeting as "another meeting" with no details.
--
-- * Cancelled and no-show meetings do not count. Back to back (one ends when
--   the other starts) is not an overlap. p_exclude (the meeting being edited
--   or moved) is left out only when the caller may read it.
-- * Only people with an active membership in the organization are answered.
-- * At most 51 people (organizer + 50 participants) and a window of 15 days
--   (a meeting is at most 14 days long).
-- * The caller must be able to write in the organization (app.can_write: an
--   active member who is not a viewer, in an organization that is not
--   read-only; a verified session where two-step verification is required).
--   Viewers never schedule, so they are not answered.
-- Read only. Every statement is safe to run twice.

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
  -- MUST stay in step with the meetings_select policy (migration
  -- 20261006005320_meetings_policies.sql): the same expression on the row, so
  -- the id and title come back exactly when the caller could select the row.
  cross join lateral (
    select (app.can_read_record(mt.organization_id, mt.owner_id, null)
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
