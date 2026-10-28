-- Times COL-06's collection report (public.report_collection) on the newest business made by
-- scripts/perf/money-allocation-state.sql (5,000 payments, 5,000 counted allocations; not run by CI).
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/money-allocation-state.sql
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/collection-report-measure.sql
-- Inside a transaction that is rolled back: the payments are spread over the last 365 days, then, as the business's owner (role
-- authenticated + JWT claims, so RLS applies as for a real caller), three runs each of a month, a quarter and a year. (`offset 0` keeps each call to one evaluation.)
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif
select id as org from public.organizations where name = 'perf business' order by created_at desc limit 1 \gset
select user_id as owner from public.memberships where organization_id = :'org' and role = 'owner' \gset

begin;
update public.subscriptions set feature_overrides = feature_overrides || '{"collection": true}'::jsonb where organization_id = :'org';
update public.payments set paid_on = current_date - (abs(hashtext(id::text)) % 365) where organization_id = :'org';
analyze public.payments;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\timing on
\echo '--- owner: one month x3'
select r -> 'totals', r -> 'collection_days' ->> 'documents' from (select public.report_collection(:'org', current_date - 30, current_date) as r offset 0) x;
select r -> 'totals', r -> 'collection_days' ->> 'documents' from (select public.report_collection(:'org', current_date - 30, current_date) as r offset 0) x;
select r -> 'totals', r -> 'collection_days' ->> 'documents' from (select public.report_collection(:'org', current_date - 30, current_date) as r offset 0) x;
\echo '--- owner: a quarter x3'
select r -> 'totals' from (select public.report_collection(:'org', current_date - 90, current_date) as r offset 0) x;
select r -> 'totals' from (select public.report_collection(:'org', current_date - 90, current_date) as r offset 0) x;
select r -> 'totals' from (select public.report_collection(:'org', current_date - 90, current_date) as r offset 0) x;
\echo '--- owner: a year x3'
select r -> 'totals', r -> 'collection_days' from (select public.report_collection(:'org', current_date - 365, current_date) as r offset 0) x;
select r -> 'totals' from (select public.report_collection(:'org', current_date - 365, current_date) as r offset 0) x;
select r -> 'totals' from (select public.report_collection(:'org', current_date - 365, current_date) as r offset 0) x;
\timing off
rollback;
