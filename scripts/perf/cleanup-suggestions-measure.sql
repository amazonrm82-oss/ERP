-- Times public.cleanup_suggestions on the newest business made by scripts/perf/cleanup-suggestions.sql (not run by CI).
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/cleanup-suggestions-measure.sql
-- (a) as the business's owner (role authenticated + JWT claims, so RLS applies as for a real caller), three runs;
-- (c) as a manager with 'team' visibility (the change is rolled back), three runs;
-- (b) the weekly job's path: the same function with no session, three runs, then app.send_cleanup_suggestions for this one
--     business once, in a transaction that is rolled back.
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif
select id as org from public.organizations where name = 'perf cleanup' order by created_at desc limit 1 \gset
select user_id as owner from public.memberships where organization_id = :'org' and role = 'owner' \gset

\echo '=== (a) as the owner, x3'
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\timing on
-- one call (a materialized CTE: a subquery would be flattened and the stable function run once per column)
with x as materialized (select public.cleanup_suggestions(:'org', 20) as r)
select r -> 'duplicates' ->> 'count' as dups, r -> 'unowned_leads' ->> 'count' as unowned, r -> 'no_channel' ->> 'count' as no_channel,
       r -> 'rare_options' ->> 'count' as rare from x;
select length(public.cleanup_suggestions(:'org', 20)::text) \g /dev/null
select length(public.cleanup_suggestions(:'org', 20)::text) \g /dev/null
\timing off
rollback;

\echo '=== (c) as the manager, with team visibility (rolled back), x3'
select m.user_id as manager from public.memberships m where m.organization_id = :'org' and m.role = 'manager' \gset
begin;
update public.organizations set record_visibility = 'team' where id = :'org';
select set_config('request.jwt.claims', json_build_object('sub', :'manager', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\timing on
with x as materialized (select public.cleanup_suggestions(:'org', 20) as r)
select r -> 'duplicates' ->> 'count' as dups, r -> 'unowned_leads' ->> 'count' as unowned, r -> 'no_channel' ->> 'count' as no_channel,
       r -> 'rare_options' ->> 'count' as rare from x;
select length(public.cleanup_suggestions(:'org', 20)::text) \g /dev/null
select length(public.cleanup_suggestions(:'org', 20)::text) \g /dev/null
\timing off
rollback;

\echo '=== (b) the job path (no session), x3, then the weekly job for this business (rolled back)'
begin;
\timing on
-- one call (a materialized CTE: a subquery would be flattened and the stable function run once per column)
with x as materialized (select public.cleanup_suggestions(:'org', 0) as r)
select r -> 'duplicates' ->> 'count' as dups, r -> 'unowned_leads' ->> 'count' as unowned, r -> 'no_channel' ->> 'count' as no_channel,
       r -> 'rare_options' ->> 'count' as rare from x;
select length(public.cleanup_suggestions(:'org', 0)::text) \g /dev/null
select length(public.cleanup_suggestions(:'org', 0)::text) \g /dev/null
select app.send_cleanup_suggestions(array[:'org'::uuid]) as served;
\timing off
rollback;
