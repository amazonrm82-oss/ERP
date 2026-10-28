-- Times public.money_allocation_state on the newest business made by scripts/perf/money-allocation-state.sql (not run by CI).
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/money-allocation-state-measure.sql
-- As the business's owner (role authenticated + JWT claims, so RLS applies as for a real caller), three runs each of
--   (a) every document id, (b) one document (a tax invoice that bills a proforma), (c) every payment id, (d) both;
-- first with the server's own settings (jit as configured), then with jit off for comparison; then auto_explain
-- (ANALYZE, BUFFERS, nested statements over 20 ms) of (b) with the server's settings.
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
select array_agg(id order by id)::text as docs from public.accounting_documents where organization_id = :'org' \gset
select min(id::text) as one_doc from public.accounting_documents where organization_id = :'org' and doc_type = 'tax_invoice' and proforma_id is not null \gset
select array_agg(id order by id)::text as pays from public.payments where organization_id = :'org' \gset
select current_setting('jit') as jit_setting, md5(public.money_allocation_state(:'org', :'docs'::uuid[], :'pays'::uuid[])::text) as superuser_md5;

\echo '=== server settings'
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
select md5(public.money_allocation_state(:'org', :'docs'::uuid[], :'pays'::uuid[])::text) as owner_md5;
\timing on
\echo '--- (a) every document id x3'
select length(public.money_allocation_state(:'org', :'docs'::uuid[], '{}')::text) \g /dev/null
select length(public.money_allocation_state(:'org', :'docs'::uuid[], '{}')::text) \g /dev/null
select length(public.money_allocation_state(:'org', :'docs'::uuid[], '{}')::text) \g /dev/null
\echo '--- (b) one document x3'
select length(public.money_allocation_state(:'org', array[:'one_doc']::uuid[], '{}')::text) \g /dev/null
select length(public.money_allocation_state(:'org', array[:'one_doc']::uuid[], '{}')::text) \g /dev/null
select length(public.money_allocation_state(:'org', array[:'one_doc']::uuid[], '{}')::text) \g /dev/null
\echo '--- (c) every payment id x3'
select length(public.money_allocation_state(:'org', '{}', :'pays'::uuid[])::text) \g /dev/null
select length(public.money_allocation_state(:'org', '{}', :'pays'::uuid[])::text) \g /dev/null
select length(public.money_allocation_state(:'org', '{}', :'pays'::uuid[])::text) \g /dev/null
\echo '--- (d) both x3'
select length(public.money_allocation_state(:'org', :'docs'::uuid[], :'pays'::uuid[])::text) \g /dev/null
select length(public.money_allocation_state(:'org', :'docs'::uuid[], :'pays'::uuid[])::text) \g /dev/null
select length(public.money_allocation_state(:'org', :'docs'::uuid[], :'pays'::uuid[])::text) \g /dev/null
\timing off
rollback;

\echo '=== jit off'
begin;
set local jit = off;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\timing on
\echo '--- (a)'
select length(public.money_allocation_state(:'org', :'docs'::uuid[], '{}')::text) \g /dev/null
\echo '--- (b)'
select length(public.money_allocation_state(:'org', array[:'one_doc']::uuid[], '{}')::text) \g /dev/null
\echo '--- (c)'
select length(public.money_allocation_state(:'org', '{}', :'pays'::uuid[])::text) \g /dev/null
\echo '--- (d)'
select length(public.money_allocation_state(:'org', :'docs'::uuid[], :'pays'::uuid[])::text) \g /dev/null
\timing off
rollback;

\echo '=== auto_explain of (b), server settings'
load 'auto_explain';
begin;
set local auto_explain.log_min_duration = 20;
set local auto_explain.log_analyze = on;
set local auto_explain.log_buffers = on;
set local auto_explain.log_nested_statements = on;
set local client_min_messages = log;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
select length(public.money_allocation_state(:'org', array[:'one_doc']::uuid[], '{}')::text) \g /dev/null
rollback;
