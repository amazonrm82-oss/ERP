-- Performance probe for public.report_money_waiting with many paid overdue invoices (not run by CI).
--
-- Run ONLY against your own local throwaway test database (a database built by `npm run test:db`, name ending in _test):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/money-waiting.sql
-- It creates one new business (each run adds another; the database is rebuilt by the next test:db) shaped like the
-- bulk case of tests/db/257-money-waiting-groups.test.ts: one contact, 3,005 tax invoices overdue by 10 days,
-- 3,000 confirmed payments each allocated in full to one invoice (so 5 invoices stay open), then ANALYZE of the
-- three money tables, as autovacuum keeps the statistics on the hosted database. Without the ANALYZE the planner
-- guesses and the plan looks fast; with it, the 021089 body took about 7-10 s here (2 November 2026).
-- Then run scripts/perf/money-waiting-measure.sql, which times the function as the owner on the newest such business.
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif

begin;
insert into auth.users (email, raw_user_meta_data)
values ('perf-mw-owner-' || gen_random_uuid() || '@example.test', '{"full_name":"perf"}') returning id as owner \gset
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_organization('perf money waiting') as org \gset
insert into public.contacts (organization_id, first_name, owner_id)
values (:'org', 'לקוח', :'owner') returning id as contact \gset
reset role;
select set_config('request.jwt.claims', '', true);

-- fixture rows in bulk: triggers set aside (as server data), every invoice due 10 days ago
set local session_replication_role = replica;
insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date, status)
select :'org', :'contact', 'tax_invoice', 'B-' || g, current_date - 40, 1000, current_date - 10, 'active' from generate_series(1, 3005) g;
insert into public.payments (organization_id, contact_id, amount_agorot, method, status)
select :'org', :'contact', 1000, 'transfer', 'confirmed' from generate_series(1, 3000);
insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
select :'org', p.id, d.id, 1000
  from (select id, row_number() over (order by id) as n from public.payments where organization_id = :'org') p
  join (select id, row_number() over (order by id) as n from public.accounting_documents where organization_id = :'org') d on d.n = p.n;
commit;

analyze public.accounting_documents, public.payments, public.payment_allocations;
\echo 'business made:' :org
