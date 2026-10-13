-- =============================================================================
-- Goals (GOL-01)
-- =============================================================================
-- * public.goals: one target per (who, period, metric).
--   - who: scope 'user' (user_id, a member of the organization), 'team'
--     (team_id) or 'org' (neither). Composite FKs; a goal goes with its member
--     or team (cascade).
--   - period: 'month', 'quarter' or 'year', starting on period_start, which is
--     the first day of that month, quarter or year (check goals_period_start).
--   - metric: a closed list, checked by goals_metric_check and mirrored by
--     GOAL_METRICS in src/features/goals/metrics.ts (a unit test reads this
--     file). won_amount (closed revenue, agorot), won_deals, leads_handled,
--     meetings_held. Collections ("גבייה") is added to both lists with the
--     payments module: a new migration replaces the check constraint.
--   - target: a whole number >= 0 (agorot for won_amount, a count otherwise).
--   - at most one goal per (organization, scope, user, team, period,
--     period_start, metric): unique nulls not distinct.
-- * Who reads (spec 22.9 "יעדים: מנהלים"): owners and admins read every goal;
--   every member reads the organization's goals, their own goals and the goals
--   of the teams they belong to; a manager (the role, not only the team flag)
--   also reads the goals of the teams they manage (or a parent of) and of the
--   people in those teams (app.goals_manages_team, app.goals_manages_user).
-- * Who writes (22.9, lead's answer of 13 October 2026): owners and admins of a
--   writable organization, every goal; a manager (role manager) the goals of
--   the teams they manage (or a parent of) and of the people in those teams
--   whose role is member: never an owner's, an admin's, another manager's or
--   their own, never another team's, never the organization's
--   (app.goals_manager_may_write; strict until the owner answers whether a
--   manager may set goals for owners, admins or other managers). Clients insert the identifying columns once
--   and update only target.
-- * Configuration: audited (app.audit_row), touch_row keeps updated_at.
-- * Module rules (22.9): goals are not moved by transfer_records (a goal is the
--   person's, not their records'); they are in the full export; a read-only or
--   suspended organization keeps reading them and cannot change them; no plan
--   limit yet.
-- Every statement is safe to run twice. No deletes, no drops.

create table if not exists public.goals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  scope           text not null,
  user_id         uuid,
  team_id         uuid,
  period          text not null,
  period_start    date not null,
  metric          text not null,
  target          bigint not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade,
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete cascade,
  constraint goals_scope_check check (
    (scope = 'user' and user_id is not null and team_id is null)
    or (scope = 'team' and team_id is not null and user_id is null)
    or (scope = 'org' and user_id is null and team_id is null)
  ),
  constraint goals_period_check check (period in ('month', 'quarter', 'year')),
  constraint goals_period_start check (
    extract(day from period_start) = 1
    and period_start between date '2000-01-01' and date '2100-12-01'
    and (period = 'month'
         or (period = 'quarter' and extract(month from period_start) in (1, 4, 7, 10))
         or (period = 'year' and extract(month from period_start) = 1))
  ),
  constraint goals_metric_check check (metric in ('won_amount', 'won_deals', 'leads_handled', 'meetings_held')),
  -- up to a billion shekels in agorot; counts stay far below it
  constraint goals_target_check check (target between 0 and 100000000000),
  constraint goals_one_per_target unique nulls not distinct (organization_id, scope, user_id, team_id, period, period_start, metric)
);

create index if not exists goals_period_idx on public.goals (organization_id, period, period_start);
create index if not exists goals_user_idx on public.goals (organization_id, user_id) where user_id is not null;
create index if not exists goals_team_idx on public.goals (organization_id, team_id) where team_id is not null;

alter table public.goals enable row level security;

revoke all on public.goals from anon, authenticated;
grant select, delete on public.goals to authenticated;
grant insert (organization_id, scope, user_id, team_id, period, period_start, metric, target) on public.goals to authenticated;
grant update (target) on public.goals to authenticated;

-- ----------------------------------------------------------------------------
-- A manager who manages a team (or a parent of a team) the person is in
-- ----------------------------------------------------------------------------
create or replace function app.goals_manages_user(p_org uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is not null
     and coalesce(app.membership_role(p_org) = 'manager', false)
     and exists (
       select 1 from public.team_members tm
        where tm.organization_id = p_org and tm.user_id = p_user
          and app.manages_team(tm.team_id)
     )
$$;
revoke all on function app.goals_manages_user(uuid, uuid) from public, anon;
grant execute on function app.goals_manages_user(uuid, uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A manager (role manager) who manages the team or a parent of it. A team_members row
-- marked is_manager is not enough on its own: the role decides (review of 13 October).
-- ----------------------------------------------------------------------------
create or replace function app.goals_manages_team(p_org uuid, p_team uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_team is not null
     and coalesce(app.membership_role(p_org) = 'manager', false)
     and exists (select 1 from public.teams t where t.organization_id = p_org and t.id = p_team)
     and app.manages_team(p_team)
$$;
revoke all on function app.goals_manages_team(uuid, uuid) from public, anon;
grant execute on function app.goals_manages_team(uuid, uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A goal a manager may write: a team they manage, or a person in one (not themselves)
-- ----------------------------------------------------------------------------
create or replace function app.goals_manager_may_write(p_org uuid, p_scope text, p_user uuid, p_team uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case p_scope
           -- strict until the owner answers (13 October 2026): only a person whose role is member,
           -- never an owner, an admin, another manager or a viewer, and never the manager themselves
           when 'user' then p_user is distinct from auth.uid()
                            and app.goals_manages_user(p_org, p_user)
                            and exists (select 1 from public.memberships m
                                         where m.organization_id = p_org and m.user_id = p_user and m.role = 'member')
           when 'team' then app.goals_manages_team(p_org, p_team)
           else false
         end
$$;
revoke all on function app.goals_manager_may_write(uuid, text, uuid, uuid) from public, anon;
grant execute on function app.goals_manager_may_write(uuid, text, uuid, uuid) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'goals' and policyname = 'goals_select') then
    create policy goals_select on public.goals for select to authenticated
      using (app.is_member(organization_id)
             and (app.is_admin(organization_id)
                  or scope = 'org'
                  -- platform support in an open session reads what the business's admins read, like records (app.can_read_record)
                  or app.support_session(organization_id)
                  or (scope = 'user' and user_id = (select auth.uid()))
                  or (scope = 'user' and app.goals_manages_user(organization_id, user_id))
                  or (scope = 'team' and (app.in_team(team_id) or app.goals_manages_team(organization_id, team_id)))));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'goals' and policyname = 'goals_insert') then
    create policy goals_insert on public.goals for insert to authenticated
      with check (app.org_writable(organization_id)
                  and (app.is_admin(organization_id)
                       or app.goals_manager_may_write(organization_id, scope, user_id, team_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'goals' and policyname = 'goals_update') then
    create policy goals_update on public.goals for update to authenticated
      using (app.org_writable(organization_id)
             and (app.is_admin(organization_id)
                  or app.goals_manager_may_write(organization_id, scope, user_id, team_id)))
      with check (app.is_admin(organization_id)
                  or app.goals_manager_may_write(organization_id, scope, user_id, team_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'goals' and policyname = 'goals_delete') then
    create policy goals_delete on public.goals for delete to authenticated
      using (app.org_writable(organization_id)
             and (app.is_admin(organization_id)
                  or app.goals_manager_may_write(organization_id, scope, user_id, team_id)));
  end if;
end;
$$;

create or replace trigger goals_touch before update on public.goals
  for each row execute function app.touch_row();
create or replace trigger goals_audit after insert or update or delete on public.goals
  for each row execute function app.audit_row();
