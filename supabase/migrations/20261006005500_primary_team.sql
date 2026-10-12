-- =============================================================================
-- CAP-06 Primary team
-- =============================================================================
-- A user who sits in several teams can have one of them marked as primary
-- (team_members.is_primary). Records they own then join that team the same way
-- records of a one-team user join their only team (app.default_team(), 0025):
--   * exactly one team         -> that team (as before; the flag is not needed)
--   * several teams, a primary -> the primary team
--   * several teams, none      -> no team (as before)
-- The flag lives on the membership row itself, so it always points to a team the
-- user belongs to in the same organization (composite FKs of team_members), and
-- it disappears with the row when the user leaves the team.
-- At most one primary team per user per organization (partial unique index).
-- Admins set it (team_members update policy, unchanged); every member reads it.
-- Changes are audited by the existing team_members_audit trigger.
-- Every statement is safe to run twice.

alter table public.team_members
  add column if not exists is_primary boolean not null default false;

create unique index if not exists team_members_one_primary_idx
  on public.team_members (organization_id, user_id) where is_primary;

-- Same trigger function and triggers as 0025, with the primary team as the
-- choice for an owner in several teams.
create or replace function app.default_team() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_team uuid;
begin
  if new.owner_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' and new.team_id is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.owner_id is not distinct from old.owner_id or new.team_id is distinct from old.team_id) then
    return new;
  end if;
  select case
           when count(*) = 1 then min(tm.team_id::text)::uuid
           else (min(tm.team_id::text) filter (where tm.is_primary))::uuid
         end
    into v_team
    from public.team_members tm
   where tm.organization_id = new.organization_id and tm.user_id = new.owner_id;
  if v_team is not null then
    new.team_id := v_team;
  end if;
  return new;
end;
$$;
revoke all on function app.default_team() from public, anon, authenticated;

-- Marks (or unmarks) one team as the user's primary team in one step: the
-- previous primary is cleared first, so the unique index never sees two.
-- Security invoker: the team_members policies decide (admins of a writable
-- organization). Touching no row means "not found or not permitted" and raises
-- P0002, which also rolls back the clearing.
create or replace function public.set_primary_team(p_org uuid, p_team uuid, p_user uuid, p_primary boolean)
returns void
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if p_primary then
    update public.team_members
       set is_primary = false
     where organization_id = p_org and user_id = p_user and is_primary and team_id <> p_team;
  end if;
  update public.team_members
     set is_primary = coalesce(p_primary, false)
   where organization_id = p_org and team_id = p_team and user_id = p_user;
  v_found := found;
  if not v_found then
    raise exception 'team member not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_primary_team(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.set_primary_team(uuid, uuid, uuid, boolean) to authenticated;
