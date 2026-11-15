-- OPS-09: the read rules of the five record tables, and the owner sort, on hundreds of thousands of rows.
--
-- Measured (scripts/perf/access-load*.sql, results in scripts/perf/access-load-RESULTS.md): every row a list reads paid
-- app.can_read_record(), a plpgsql definer that calls app.membership_role(), app.has_verified_factor(), app.in_team() and
-- app.manages_team(), all SQL definers. A SQL function that is not inlined is planned again on every call (PostgreSQL 16
-- and 17 keep no plan for it between calls), so a count of 300,000 leads planned more than a million small queries, for
-- an owner too, and a page sorted by owner planned sort_owner's query and the profiles rule (app.shares_org) once per row.
--
-- What changes, and why the answer stays the same:
-- 0. app.session_aal, has_verified_factor, membership_role, platform_role, support_session, role_in, is_member, in_team
--    and manages_team become plpgsql with their queries unchanged (plans kept for the session). Every policy that still
--    calls a helper per row (activities, files, meetings and the rest) and every per-row read of the five tables from such
--    a policy (app.can_read_activity_subject) gets cheaper without any change of rule.
-- 1. The select policies of leads, contacts, companies, deals and tasks no longer call app.can_read_record() per row.
--    They ask the same rule as sets computed once per statement (uncorrelated subqueries, hashed):
--      app.my_record_orgs()  the caller's businesses: reads_all (no role and a support session; owner or admin; any role
--                            when the business's visibility is 'org'), has_role (app.membership_role is not null) and
--                            is_member (app.role_in is not null = app.is_member)
--      app.my_read_teams()   the teams whose records the caller reads: visibility 'team' and app.in_team(), or the role
--                            manager and app.manages_team() (a parent team included), only in a business where the caller
--                            has a role and does not already read everything
--    The row is readable when its business is reads_all, or its owner is the caller in a business where they have a role,
--    or its (business, team) is in app.my_read_teams(): exactly the branches of app.can_read_record() in its order (a
--    team row belongs to the record's business through the composite foreign key, so the pair names the same team). Each
--    set asks the very helpers app.can_read_record() asks (membership_role, support_session, in_team, manages_team), once
--    per business or team, so the two-step rule, the closed-business rule and support sessions are judged as before.
--    The HEB-08 deputy line is kept as it was. tasks keep the creator line (app.is_member -> is_member of the same set)
--    and TASK-07's app.team_task_visible(), now behind the conditions it starts with (no owner, a team the caller is in,
--    open, not in the bin): the function answers false without them, so the guard changes no answer and only spares the
--    call on every other row. app.can_read_record() itself is unchanged and still serves every other table.
--    Test 369 compares, for every role, visibility mode, a support session, a session missing its second step, a closed
--    business, a suspended member and a deputy, the new rule row by row with app.can_read_record() and the old policies.
-- 2. The profiles select policy asks app.shares_org() as a set (app.my_shared_users(): the body of app.shares_org with the
--    other user left open), once per statement instead of once per profile row.
-- 3. public.sort_owner(leads|contacts|companies|deals|tasks) read the owner's name through app.owner_sort_name(), a plpgsql
--    definer that applies profiles_select's rule to that one profile with plans kept for the session (the old body, a SQL
--    function with a FROM, could not be inlined and ran the profiles rule from scratch on every row). The five wrappers
--    have no SET clause and no FROM, so they inline; the advisor's function_search_path_mutable on them is expected, as on
--    search_text and deal_attention_rows.
-- 4. One index: team_members (user_id), for the caller's teams across businesses (app.my_teams(); the existing
--    team_members_user_idx starts with organization_id). The list queries keep their indexes ((organization_id,
--    created_at) and the FK indexes); the rule is now a hash probe. A plain create index locks writes to team_members
--    for its build; the table holds one row per person and team (hundreds of rows on the hosted project), so the lock is
--    momentary. No other table is indexed, scanned or rewritten.
--
-- Apart from that index only policies and functions change; safe to run twice.

create index if not exists team_members_user_only_idx on public.team_members (user_id);

-- ----------------------------------------------------------------------------
-- The helpers every read asks, as plpgsql: the same queries, so the same answers, but plpgsql keeps their plans for the
-- session where a SQL definer is planned again on every call. Bodies of 0014 (session_aal, has_verified_factor), 0171
-- (membership_role), 0013 (platform_role, role_in), 020075 (support_session) and 0001 (is_member, in_team, manages_team).
-- A SELECT INTO keeps the first row, as a SQL function returns it. Test 369 compares each with its old SQL body.
-- ----------------------------------------------------------------------------
create or replace function app.session_aal() returns text
language plpgsql stable
set search_path = ''
as $$
begin
  return coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '');
end;
$$;

create or replace function app.has_verified_factor() returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified');
end;
$$;

create or replace function app.membership_role(p_org uuid) returns public.membership_role
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role;
begin
  select m.role into v_role from public.memberships m
    join public.organizations o on o.id = m.organization_id
   where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
     and (app.session_aal() = 'aal2' or (not o.require_mfa and not app.has_verified_factor()))
     and (m.role = 'owner' or not app.org_status_closed(o.status));
  return v_role;
end;
$$;

create or replace function app.platform_role() returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select s.role into v_role from app.platform_staff s
   where s.user_id = auth.uid()
     and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') = 'aal2';
  return v_role;
end;
$$;

create or replace function app.support_session(p_org uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return coalesce(app.platform_role() in ('owner', 'support'), false)
     and exists (select 1
                   from app.support_sessions s
                   join public.support_access_grants g on g.organization_id = s.organization_id and g.id = s.grant_id
                  where s.organization_id = p_org and s.staff_user_id = auth.uid()
                    and g.revoked_at is null and g.expires_at > now());
end;
$$;

create or replace function app.role_in(p_org uuid) returns public.membership_role
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return coalesce(app.membership_role(p_org),
                  case when app.support_session(p_org) then 'viewer'::public.membership_role end);
end;
$$;

create or replace function app.is_member(p_org uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return app.role_in(p_org) is not null;
end;
$$;

create or replace function app.in_team(p_team uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team and tm.user_id = auth.uid()
  );
end;
$$;

create or replace function app.manages_team(p_team uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return exists (
    with recursive chain as (
      select t.id, t.parent_team_id, 1 as depth
      from public.teams t where t.id = p_team
      union all
      select t.id, t.parent_team_id, c.depth + 1
      from public.teams t
      join chain c on t.id = c.parent_team_id
      where c.depth < 10
    )
    select 1
    from chain c
    join public.team_members tm on tm.team_id = c.id
    where tm.user_id = auth.uid() and tm.is_manager
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- The caller's businesses, judged once per statement
-- ----------------------------------------------------------------------------
create or replace function app.my_record_orgs()
returns table (organization_id uuid, reads_all boolean, has_role boolean, is_member boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return query
  with candidates as (
    -- app.membership_role() needs an active membership of the caller, app.support_session() a session row of the caller
    select m.organization_id from public.memberships m where m.user_id = auth.uid()
    union
    select s.organization_id from app.support_sessions s where s.staff_user_id = auth.uid()
  ), judged as (
    select c.organization_id, app.membership_role(c.organization_id) as role, o.record_visibility as visibility
      from candidates c
      join public.organizations o on o.id = c.organization_id
  ), support as (
    select j.*, case when j.role is null then app.support_session(j.organization_id) else false end as support
      from judged j
  )
  select s.organization_id,
         -- the order of app.can_read_record(): no role = the support session; owner/admin; visibility 'org'
         case when s.role is null then s.support
              else s.role in ('owner', 'admin') or s.visibility = 'org' end,
         s.role is not null,
         -- app.is_member = app.role_in() is not null = a role, or a support session
         s.role is not null or s.support
    from support s
   where s.role is not null or s.support;
end;
$$;
revoke all on function app.my_record_orgs() from public, anon;
grant execute on function app.my_record_orgs() to authenticated, service_role;

-- The teams whose records the caller reads beyond their own (the team branches of app.can_read_record())
create or replace function app.my_read_teams()
returns table (organization_id uuid, team_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return query
  select t.organization_id, t.id
    from public.teams t
    join public.organizations o on o.id = t.organization_id
    join public.memberships m on m.organization_id = t.organization_id and m.user_id = auth.uid()
    cross join lateral (select app.membership_role(t.organization_id) as role) r
   where r.role is not null
     and not (r.role in ('owner', 'admin') or o.record_visibility = 'org')
     and ((o.record_visibility = 'team' and app.in_team(t.id))
          or (r.role = 'manager' and app.manages_team(t.id)));
end;
$$;
revoke all on function app.my_read_teams() from public, anon;
grant execute on function app.my_read_teams() to authenticated, service_role;

-- The teams the caller is in (read as the definer, as app.team_task_visible() reads team_members)
create or replace function app.my_teams()
returns table (organization_id uuid, team_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return query
  select tm.organization_id, tm.team_id from public.team_members tm where tm.user_id = auth.uid();
end;
$$;
revoke all on function app.my_teams() from public, anon;
grant execute on function app.my_teams() to authenticated, service_role;

-- The users the caller shares a business with (app.shares_org() for every user at once)
create or replace function app.my_shared_users()
returns table (user_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return query
  select distinct theirs.user_id
    from public.memberships mine
    join public.memberships theirs on theirs.organization_id = mine.organization_id
    join public.organizations o on o.id = mine.organization_id
   where mine.user_id = auth.uid() and mine.status = 'active'
     and (mine.role = 'owner' or not app.org_status_closed(o.status));
end;
$$;
revoke all on function app.my_shared_users() from public, anon;
grant execute on function app.my_shared_users() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Policies (alter: same names, same commands, same roles)
-- ----------------------------------------------------------------------------
alter policy leads_select on public.leads
  using (organization_id in (select r.organization_id from app.my_record_orgs() r where r.reads_all)
         or (owner_id = (select auth.uid())
             and organization_id in (select r.organization_id from app.my_record_orgs() r where r.has_role))
         or ((organization_id, team_id) in (select r.organization_id, r.team_id from app.my_read_teams() r))
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('lead') r));
alter policy contacts_select on public.contacts
  using (organization_id in (select r.organization_id from app.my_record_orgs() r where r.reads_all)
         or (owner_id = (select auth.uid())
             and organization_id in (select r.organization_id from app.my_record_orgs() r where r.has_role))
         or ((organization_id, team_id) in (select r.organization_id, r.team_id from app.my_read_teams() r))
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('contact') r));
alter policy companies_select on public.companies
  using (organization_id in (select r.organization_id from app.my_record_orgs() r where r.reads_all)
         or (owner_id = (select auth.uid())
             and organization_id in (select r.organization_id from app.my_record_orgs() r where r.has_role))
         or ((organization_id, team_id) in (select r.organization_id, r.team_id from app.my_read_teams() r))
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('company') r));
alter policy deals_select on public.deals
  using (organization_id in (select r.organization_id from app.my_record_orgs() r where r.reads_all)
         or (owner_id = (select auth.uid())
             and organization_id in (select r.organization_id from app.my_record_orgs() r where r.has_role))
         or ((organization_id, team_id) in (select r.organization_id, r.team_id from app.my_read_teams() r))
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('deal') r));
alter policy tasks_select on public.tasks
  using (organization_id in (select r.organization_id from app.my_record_orgs() r where r.reads_all)
         or (owner_id = (select auth.uid())
             and organization_id in (select r.organization_id from app.my_record_orgs() r where r.has_role))
         or ((organization_id, team_id) in (select r.organization_id, r.team_id from app.my_read_teams() r))
         or (created_by = (select auth.uid())
             and organization_id in (select r.organization_id from app.my_record_orgs() r where r.is_member))
         or ((organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('task') r(organization_id, id)))
         -- TASK-07: an open team task nobody took yet, for the team's members (the guard is the function's own start)
         or (owner_id is null and status = 'open' and deleted_at is null
             and (organization_id, team_id) in (select r.organization_id, r.team_id from app.my_teams() r)
             and app.team_task_visible(organization_id, id, owner_id, team_id, status, deleted_at)));

alter policy profiles_select on public.profiles
  using (id = (select auth.uid())
         or (id in (select s.user_id from app.my_shared_users() s) and app.session_verified()));

-- ----------------------------------------------------------------------------
-- Owner sort: the name public.sort_owner() showed, read the way profiles_select lets the caller read it: the caller's own
-- profile, or a person they share a business with while the session is verified (app.shares_org, app.session_verified,
-- their bodies written out here so plpgsql keeps one plan for every row; keep in step). Test 369 compares the names
-- with the old body read under the caller's rights.
-- ----------------------------------------------------------------------------
create or replace function app.owner_sort_name(p_owner uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_name text; v_me uuid := auth.uid();
begin
  if p_owner is null then return null; end if;
  select coalesce(nullif(pg_catalog.btrim(p.full_name), ''), p.email) into v_name from public.profiles p where p.id = p_owner;
  if not found then return null; end if;
  if p_owner = v_me then return v_name; end if;
  -- app.shares_org(p_owner): its body, with the other user given (keep in step)
  if not exists (select 1 from public.memberships mine
                   join public.memberships theirs on theirs.organization_id = mine.organization_id
                   join public.organizations o on o.id = mine.organization_id
                  where mine.user_id = v_me and mine.status = 'active' and theirs.user_id = p_owner
                    and (mine.role = 'owner' or not app.org_status_closed(o.status))) then
    return null;
  end if;
  -- app.session_verified(): its body (keep in step)
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') = 'aal2'
     or (not exists (select 1 from auth.mfa_factors f where f.user_id = v_me and f.status::text = 'verified')
         and not exists (select 1 from public.memberships m join public.organizations o on o.id = m.organization_id
                          where m.user_id = v_me and m.status = 'active' and o.require_mfa)) then
    return v_name;
  end if;
  return null;
end $$;
revoke all on function app.owner_sort_name(uuid) from public, anon;
grant execute on function app.owner_sort_name(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Owner sort: no FROM and no SET clause, so the planner inlines the call into the list's query
-- ----------------------------------------------------------------------------
create or replace function public.sort_owner(public.leads) returns text
language sql stable security invoker
as $$
  select app.owner_sort_name($1.owner_id)
$$;
create or replace function public.sort_owner(public.contacts) returns text
language sql stable security invoker
as $$
  select app.owner_sort_name($1.owner_id)
$$;
create or replace function public.sort_owner(public.companies) returns text
language sql stable security invoker
as $$
  select app.owner_sort_name($1.owner_id)
$$;
create or replace function public.sort_owner(public.deals) returns text
language sql stable security invoker
as $$
  select app.owner_sort_name($1.owner_id)
$$;
create or replace function public.sort_owner(public.tasks) returns text
language sql stable security invoker
as $$
  select app.owner_sort_name($1.owner_id)
$$;
revoke all on function public.sort_owner(public.leads) from public, anon;
revoke all on function public.sort_owner(public.contacts) from public, anon;
revoke all on function public.sort_owner(public.companies) from public, anon;
revoke all on function public.sort_owner(public.deals) from public, anon;
revoke all on function public.sort_owner(public.tasks) from public, anon;
grant execute on function public.sort_owner(public.leads) to authenticated;
grant execute on function public.sort_owner(public.contacts) to authenticated;
grant execute on function public.sort_owner(public.companies) to authenticated;
grant execute on function public.sort_owner(public.deals) to authenticated;
grant execute on function public.sort_owner(public.tasks) to authenticated;

notify pgrst, 'reload schema';
