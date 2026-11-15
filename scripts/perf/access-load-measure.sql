-- Timings for OPS-09 on the business scripts/perf/access-load.sql made (not run by CI; own _test database only).
--   psql "$TEST_DATABASE_URL" -v vis=team -f scripts/perf/access-load-measure.sql
-- vis (team | own | org) sets the business's record visibility first. Every query is the one the app sends through
-- PostgREST for a list (src/features/<area>/queries.ts): the first page of 50 (+1) newest, the exact count, a search
-- through search_text, and the first page sorted by sort_owner; each runs as the signed-in person (role authenticated,
-- JWT claims with aal1) and prints EXPLAIN ANALYZE's execution time in ms. People: n=1 owner, n=2 admin, n=5 manager of a
-- parent team, n=20 member (two teams), n=13 member who is a deputy (HEB-08), n=56 viewer.
\set QUIET on
\pset pager off
\pset footer off
\pset tuples_only on
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif
\if :{?vis}
\else
  \set vis team
\endif
set statement_timeout = '600s';
select id as org from public.organizations where name = 'perf ops09' order by created_at desc limit 1 \gset
update public.organizations set record_visibility = :'vis' where id = :'org';

create or replace function pg_temp.ms(p_sql text) returns numeric language plpgsql as $$
declare v jsonb;
begin
  execute 'explain (analyze, timing off, format json) ' || p_sql into v;
  return round((v -> 0 ->> 'Execution Time')::numeric, 1);
end $$;

create temporary table perf_who (label text, n int);
insert into perf_who values ('owner', 1), ('admin', 2), ('manager', 5), ('member', 20), ('deputy', 13), ('viewer', 56);
create temporary table perf_q (k text, t text, q text);
insert into perf_q
select k, t, replace(replace(q, '$T', t), '$ORG', :'org')
  from (values
    ('page',   'select id, owner_id, created_at from public.$T where organization_id = ''$ORG'' and deleted_at is null order by created_at desc, id desc limit 51'),
    ('count',  'select count(*) from public.$T where organization_id = ''$ORG'' and deleted_at is null'),
    ('search', 'select id from public.$T x where organization_id = ''$ORG'' and deleted_at is null and public.search_text(x) like ''%%77%%'' order by created_at desc, id desc limit 51'),
    ('sort_owner', 'select id from public.$T x where organization_id = ''$ORG'' and deleted_at is null order by public.sort_owner(x) asc nulls last, id limit 51')
  ) q(k, q),
  (values ('leads'), ('contacts'), ('companies'), ('deals'), ('tasks')) t(t);
grant select on perf_q, perf_who to authenticated;

create temporary table perf_out (who text, t text, k text, ms numeric);


create or replace function pg_temp.run_as(p_who text, p_user uuid, p_t text, p_k text, p_sql text) returns text language plpgsql as $$
declare v numeric;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  begin
    v := pg_temp.ms(p_sql);
  exception when query_canceled then v := null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into perf_out values (p_who, p_t, p_k, coalesce(v, -1));
  return format('%s %s %s %s', p_who, p_t, p_k, coalesce(v, -1));
end $$;
-- one statement per person and query, each under its own timeout (-1 = over the timeout)
\if :{?limit_s}
\else
  \set limit_s 60s
\endif
set statement_timeout = :'limit_s';
select format('select pg_temp.run_as(%L, %L, %L, %L, %L)', pw.label, m.user_id, q.t, q.k, q.q)
  from perf_who pw
  join auth.users u on u.email like 'perf-ops09-' || pw.n || '-%'
  join public.memberships m on m.user_id = u.id and m.organization_id = :'org'
  cross join perf_q q
 order by q.t, q.k, pw.n \gexec
set statement_timeout = '600s';

\echo 'visibility' :vis
\pset tuples_only off
select t as "table", k as query,
       max(ms) filter (where who = 'owner') as owner, max(ms) filter (where who = 'admin') as admin,
       max(ms) filter (where who = 'manager') as manager, max(ms) filter (where who = 'member') as member,
       max(ms) filter (where who = 'deputy') as deputy, max(ms) filter (where who = 'viewer') as viewer
  from perf_out group by t, k order by t, k;
update public.organizations set record_visibility = 'team' where id = :'org';
