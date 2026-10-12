-- =============================================================================
-- 0053c Meetings: policies and the organizer rule (CAL-01; split from 0053)
-- =============================================================================
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Grants and policies: meetings
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meetings' and policyname = 'meetings_select') then
    create policy meetings_select on public.meetings for select to authenticated
      using (app.can_read_record(organization_id, owner_id, null)
             or (app.is_member(organization_id)
                 and (created_by = (select auth.uid()) or app.is_meeting_participant(organization_id, id)))
             or app.meeting_subject_ok(organization_id, lead_id, contact_id, company_id, deal_id, false));
  end if;
end;
$$;

-- any writer may set up a meeting, internal or on a record they can see
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meetings' and policyname = 'meetings_insert') then
    create policy meetings_insert on public.meetings for insert to authenticated
      with check (app.can_write(organization_id)
                  and (num_nonnulls(lead_id, contact_id, company_id, deal_id) = 0
                       or app.meeting_subject_ok(organization_id, lead_id, contact_id, company_id, deal_id, false)));
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meetings' and policyname = 'meetings_update') then
    create policy meetings_update on public.meetings for update to authenticated
      using (app.meeting_editable(organization_id, id, owner_id, created_by, lead_id, contact_id, company_id, deal_id))
      -- new links are checked one by one by the meetings_check_links trigger
      with check (app.can_write(organization_id));
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meetings' and policyname = 'meetings_delete') then
    create policy meetings_delete on public.meetings for delete to authenticated
      using (app.can_delete_record(organization_id, owner_id, null)
             or (created_by = (select auth.uid()) and app.can_write(organization_id)));
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- Grants and policies: participants (added and removed; nothing to update)
-- ----------------------------------------------------------------------------

-- the sub-select runs under the caller's meetings policy: see the meeting, see who comes
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meeting_participants' and policyname = 'meeting_participants_select') then
    create policy meeting_participants_select on public.meeting_participants for select to authenticated
      using (app.is_member(organization_id)
             and exists (select 1 from public.meetings m
                         where m.organization_id = meeting_participants.organization_id
                           and m.id = meeting_participants.meeting_id));
  end if;
end;
$$;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meeting_participants' and policyname = 'meeting_participants_insert') then
    create policy meeting_participants_insert on public.meeting_participants for insert to authenticated
      with check (app.can_edit_meeting(organization_id, meeting_id));
  end if;
end;
$$;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meeting_participants' and policyname = 'meeting_participants_delete') then
    create policy meeting_participants_delete on public.meeting_participants for delete to authenticated
      using (app.can_edit_meeting(organization_id, meeting_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The organizer (owner_id)
-- ----------------------------------------------------------------------------
-- The organizer is an active member who can write (not a viewer). A writer sets
-- up meetings for themself; owners and admins may set them up for anyone. The
-- organizer is changed only by the current organizer, the meeting's creator,
-- or an owner/admin, and never to nobody. Server writes (current_user is not a
-- client role: transfer_records, merge) are not checked here.
create or replace function app.meeting_owner_active(p_org uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = p_org and m.user_id = p_user and m.status = 'active' and m.role <> 'viewer'
  )
$$;
revoke all on function app.meeting_owner_active(uuid, uuid) from public, anon;
grant execute on function app.meeting_owner_active(uuid, uuid) to authenticated, service_role;

-- SECURITY INVOKER on purpose: it reads current_user.
create or replace function app.meetings_check_owner() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- empty: app.default_owner (it fires after this trigger) makes the writer the organizer
    if new.owner_id is null then
      return new;
    end if;
    if new.owner_id is distinct from auth.uid() and not app.is_admin(new.organization_id) then
      raise exception 'not allowed to change the meeting organizer' using errcode = '42501';
    end if;
  else
    if new.owner_id is not distinct from old.owner_id then
      return new;
    end if;
    if not ((old.owner_id is not null and old.owner_id = auth.uid())
            or (old.created_by is not null and old.created_by = auth.uid())
            or app.is_admin(old.organization_id)) then
      raise exception 'not allowed to change the meeting organizer' using errcode = '42501';
    end if;
  end if;
  if new.owner_id is null or not app.meeting_owner_active(new.organization_id, new.owner_id) then
    raise exception 'meeting organizer must be an active member' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function app.meetings_check_owner() from public, anon, authenticated;

-- Triggers of the same timing fire in name order, so this one runs BEFORE
-- meetings_default_owner: an empty organizer on insert is let through here and
-- then filled in with the writer, who is an active non-viewer (meetings_insert
-- requires app.can_write).
create or replace trigger meetings_check_owner
  before insert or update of owner_id on public.meetings
  for each row execute function app.meetings_check_owner();
