-- Times COL-01's collection screen (public.collection_documents) on the newest business made by
-- scripts/perf/customer-debt.sql (4,000 open tax invoices, 2,000 of them half paid; not run by CI).
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/customer-debt.sql
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/collection-measure.sql
-- As the business's owner (role authenticated + JWT claims, so RLS applies as for a real caller): three runs each of the
-- whole screen, the overdue filter, one bucket and one rep, then BAL-03's report_debt_aging on the same data for comparison.
-- (`offset 0` keeps each call to one evaluation: a stable function referenced twice in an inlined subquery runs twice.)
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif
select id as org from public.organizations where name = 'perf debt business' order by created_at desc limit 1 \gset
select user_id as owner from public.memberships where organization_id = :'org' and role = 'owner' \gset

begin;
update public.subscriptions set feature_overrides = feature_overrides || '{"collection": true}'::jsonb where organization_id = :'org';
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\timing on
\echo '--- the whole screen x3 (documents listed, total)'
select jsonb_array_length(r -> 'documents'), r -> 'totals' ->> 'total' from (select public.collection_documents(:'org') as r offset 0) x;
select jsonb_array_length(r -> 'documents'), r -> 'totals' ->> 'total' from (select public.collection_documents(:'org') as r offset 0) x;
select jsonb_array_length(r -> 'documents'), r -> 'totals' ->> 'total' from (select public.collection_documents(:'org') as r offset 0) x;
\echo '--- overdue only x3'
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', null, true) as r offset 0) x;
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', null, true) as r offset 0) x;
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', null, true) as r offset 0) x;
\echo '--- one bucket (d1_30) x3'
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', null, false, 'd1_30') as r offset 0) x;
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', null, false, 'd1_30') as r offset 0) x;
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', null, false, 'd1_30') as r offset 0) x;
\echo '--- one rep (the owner) x3'
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', :'owner') as r offset 0) x;
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', :'owner') as r offset 0) x;
select jsonb_array_length(r -> 'documents') from (select public.collection_documents(:'org', :'owner') as r offset 0) x;
\echo '--- for comparison: report_debt_aging x3'
select r -> 'totals' ->> 'total' from (select public.report_debt_aging(:'org') as r offset 0) x;
select r -> 'totals' ->> 'total' from (select public.report_debt_aging(:'org') as r offset 0) x;
select r -> 'totals' ->> 'total' from (select public.report_debt_aging(:'org') as r offset 0) x;
\timing off
rollback;
