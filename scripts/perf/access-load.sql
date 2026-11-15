-- Load fixture for OPS-09: the access rules on hundreds of thousands of rows (not run by CI).
--
-- Run ONLY against your own local throwaway test database (a database built by `npm run test:db`, name ending in _test):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -v scale=1 -f scripts/perf/access-load.sql
-- scale=1 makes one big business ('perf ops09'; each run adds another) with 300,000 leads, 200,000 contacts, 20,000
-- companies, 50,000 deals and 200,000 tasks; scale=0.1 a tenth of that. Around it: 60 people (1 owner, 3 admins,
-- 6 managers, 45 members, 5 viewers), 12 teams in two levels (a manager of a parent team manages its child teams),
-- record visibility 'team', one member absent with a deputy (HEB-08), and 20 small businesses of 500 leads each.
-- Records are owned round-robin by the people who hold a team (10% unowned), with the owner's team.
-- The rows are written with triggers set aside (server data), then every table is analyzed (021144's rule: unanalyzed
-- estimates hide plans). Then run scripts/perf/access-load-measure.sql. The rows stay until the next `npm run test:db`.
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif
\if :{?scale}
\else
  \set scale 1
\endif
\timing on
begin;
create temporary table perf_people (n int primary key, id uuid, role public.membership_role, team int) on commit drop;
-- 60 people: n=1 owner, 2..4 admins, 5..10 managers, 11..55 members, 56..60 viewers
with u as (
  insert into auth.users (email, raw_user_meta_data)
  select 'perf-ops09-' || g || '-' || gen_random_uuid() || '@example.test', jsonb_build_object('full_name', 'איש ' || g)
    from generate_series(1, 60) g
  returning id, email)
insert into perf_people (n, id, role)
select split_part(email, '-', 3)::int, id,
       case when split_part(email, '-', 3)::int = 1 then 'owner'
            when split_part(email, '-', 3)::int <= 4 then 'admin'
            when split_part(email, '-', 3)::int <= 10 then 'manager'
            when split_part(email, '-', 3)::int <= 55 then 'member'
            else 'viewer' end::public.membership_role
  from u;
select id as owner from perf_people where n = 1 \gset
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_organization('perf ops09') as org \gset
reset role;
select set_config('request.jwt.claims', '', true);
update public.subscriptions set seats = 100 where organization_id = :'org';
update public.organizations set record_visibility = 'team' where id = :'org';
insert into public.memberships (organization_id, user_id, role, seat_type)
select :'org', p.id, p.role, case when p.role = 'viewer' then 'view' else 'full' end::public.seat_type
  from perf_people p where p.n > 1;
-- 12 teams: 1..4 parents, 5..12 children (team 4+k under parent 1 + (k-1) % 4)
create temporary table perf_teams (n int primary key, id uuid) on commit drop;
with t as (insert into public.teams (organization_id, name) select :'org', 'צוות ' || g from generate_series(1, 12) g returning id, name)
insert into perf_teams select substr(name, 6)::int, id from t;
update public.teams t set parent_team_id = (select id from perf_teams where n = 1 + ((pt.n - 5) % 4))
  from perf_teams pt where t.id = pt.id and pt.n > 4;
-- managers 5..10: 5..8 manage parent teams 1..4, 9..10 manage children 5..6; members 11..55 in children 5..12; viewers in team 5
update perf_people set team = case when n between 5 and 8 then n - 4 when n between 9 and 10 then n - 4
                                   when n between 11 and 55 then 5 + (n % 8) when n > 55 then 5 end;
insert into public.team_members (organization_id, team_id, user_id, is_manager, is_primary)
select :'org', t.id, p.id, p.role = 'manager', true from perf_people p join perf_teams t on t.n = p.team;
-- a member of two teams
insert into public.team_members (organization_id, team_id, user_id, is_manager, is_primary)
select :'org', (select id from perf_teams where n = 12), id, false, false from perf_people where n = 20
on conflict do nothing;

select id as status from public.lead_statuses where organization_id = :'org' and is_default \gset
select p.id as pipe, s.id as stage from public.pipelines p join public.stages s on s.pipeline_id = p.id and s.kind = 'open'
 where p.organization_id = :'org' order by s.position limit 1 \gset

-- record owners: people 5..55 round-robin (managers and members), every tenth record unowned (a team, no owner)
create temporary table perf_owner (k int primary key, owner_id uuid, team_id uuid) on commit drop;
insert into perf_owner
select p.n - 5, case when p.n % 10 = 0 then null else p.id end, t.id
  from perf_people p join perf_teams t on t.n = p.team where p.n between 5 and 55;

set local session_replication_role = replica;
insert into public.leads (organization_id, status_id, full_name, email, company_name, owner_id, team_id, created_at, updated_at)
select :'org', :'status', 'ליד ' || g || ' ' || md5(g::text), 'l' || g || '@example.test', 'חברה ' || (g % 5000),
       o.owner_id, o.team_id, now() - g * interval '1 minute', now()
  from generate_series(1, (300000 * :scale)::int) g join perf_owner o on o.k = g % 51;
insert into public.companies (organization_id, name, owner_id, team_id, created_at, updated_at)
select :'org', 'חברה ' || g || ' ' || md5(g::text), o.owner_id, o.team_id, now() - g * interval '1 minute', now()
  from generate_series(1, (20000 * :scale)::int) g join perf_owner o on o.k = g % 51;
insert into public.contacts (organization_id, first_name, last_name, email, owner_id, team_id, created_at, updated_at)
select :'org', 'איש', 'קשר ' || g || ' ' || md5(g::text), 'c' || g || '@example.test',
       o.owner_id, o.team_id, now() - g * interval '1 minute', now()
  from generate_series(1, (200000 * :scale)::int) g join perf_owner o on o.k = g % 51;
insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, team_id, amount_agorot, created_at, updated_at)
select :'org', 'עסקה ' || g || ' ' || md5(g::text), :'pipe', :'stage', o.owner_id, o.team_id, g * 100,
       now() - g * interval '1 minute', now()
  from generate_series(1, (50000 * :scale)::int) g join perf_owner o on o.k = g % 51;
insert into public.tasks (organization_id, title, owner_id, team_id, created_by, status, due_at, created_at, updated_at)
select :'org', 'משימה ' || g || ' ' || md5(g::text), o.owner_id, o.team_id, (select id from perf_people where n = 1 + g % 55),
       case when g % 3 = 0 then 'done' else 'open' end::public.task_status, now() + (g % 90) * interval '1 day',
       now() - g * interval '1 minute', now()
  from generate_series(1, (200000 * :scale)::int) g join perf_owner o on o.k = g % 51;
-- the absent member (n=12) has open tasks on leads; deputy n=13 (HEB-08)
update public.tasks t set lead_id = l.id
  from (select id, row_number() over (order by id) as r from public.leads where organization_id = :'org' and owner_id = (select id from perf_people where n = 12) limit 200) l,
       (select id, row_number() over (order by id) as r from public.tasks where organization_id = :'org' and owner_id = (select id from perf_people where n = 12) and status = 'open' limit 200) tt
 where t.id = tt.id and tt.r = l.r;
set local session_replication_role = origin;
insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id)
select :'org', (select id from perf_people where n = 12), current_date - 1, current_date + 7, 'vacation', (select id from perf_people where n = 13);

-- 20 small businesses of 500 leads each, owned by their own owner
do $$
declare
  v_user uuid; v_org uuid; v_status uuid;
begin
  for i in 1..20 loop
    insert into auth.users (email, raw_user_meta_data) values ('perf-ops09-small-' || gen_random_uuid() || '@example.test', '{"full_name":"קטן"}')
      returning id into v_user;
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    v_org := public.create_organization('perf ops09 small ' || i);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    select id into v_status from public.lead_statuses where organization_id = v_org and is_default;
    perform set_config('session_replication_role', 'replica', true);
    insert into public.leads (organization_id, status_id, full_name, owner_id)
    select v_org, v_status, 'ליד קטן ' || g, v_user from generate_series(1, 500) g;
    perform set_config('session_replication_role', 'origin', true);
  end loop;
end $$;
commit;
\timing off
analyze public.leads; analyze public.contacts; analyze public.companies; analyze public.deals; analyze public.tasks;
analyze public.memberships; analyze public.team_members; analyze public.teams; analyze public.organizations; analyze public.profiles;
analyze public.member_leaves;
select (select count(*) from public.leads where organization_id = :'org') as leads,
       (select count(*) from public.contacts where organization_id = :'org') as contacts,
       (select count(*) from public.companies where organization_id = :'org') as companies,
       (select count(*) from public.deals where organization_id = :'org') as deals,
       (select count(*) from public.tasks where organization_id = :'org') as tasks;
\echo :org
