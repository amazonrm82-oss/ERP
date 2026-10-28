-- Performance probe for BAL-02's list columns (not run by CI).
--
-- Run ONLY against your own local throwaway test database (a database built by `npm run test:db`, name ending in _test):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/customer-debt.sql
-- It creates one new business ('perf debt business'; each run adds another) with 20,000 contacts, one company of 2,000 of
-- them and 50 companies of 20, 4,000 open tax invoices (one per contact for the first 4,000 contacts: so 2,000 on the big
-- company's contacts) due between 120 days ago and 60 days ahead, and 2,000 payments allocated to half of them. The
-- triggers of BAL-02 run as in production, and the time of the seeding commit (which refreshes every kept row) is printed.
-- Then run scripts/perf/customer-debt-measure.sql.
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif

begin;
create temporary table perf_ids (k text primary key, v uuid) on commit preserve rows;
with u as (insert into auth.users (email, raw_user_meta_data)
           values ('perf-debt-' || gen_random_uuid() || '@example.test', '{"full_name":"perf"}') returning id)
insert into perf_ids select 'owner', id from u;
select set_config('request.jwt.claims', json_build_object('sub', (select v from perf_ids where k = 'owner'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_organization('perf debt business') as org \gset
reset role;
select set_config('request.jwt.claims', '', true);
update public.subscriptions set feature_overrides = '{"documents": true, "payments": true, "balances": true}'::jsonb
 where organization_id = :'org';

create temporary table perf_companies on commit drop as
with c as (
  insert into public.companies (organization_id, name, owner_id)
  select :'org', 'perf company ' || g, (select v from perf_ids where k = 'owner') from generate_series(1, 51) g
  returning id, name
) select row_number() over (order by name) as n, id from c;

-- contact g: company 1 (the big one) for g <= 2,000; companies 2..51 for 2,001..3,000; none after
create temporary table perf_contacts on commit drop as
with c as (
  insert into public.contacts (organization_id, first_name, owner_id, company_id)
  select :'org', 'perf ' || g, (select v from perf_ids where k = 'owner'),
         case when g <= 2000 then (select id from perf_companies where n = 1)
              when g <= 3000 then (select id from perf_companies where n = 2 + (g % 50)) end
    from generate_series(1, 20000) g
  returning id, first_name
) select substr(first_name, 6)::int as n, id from c;

create temporary table perf_docs on commit drop as
with d as (
  insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, due_date, amount_agorot)
  select :'org', c.id, 'tax_invoice', 'PD-' || c.n, current_date - 150, current_date - 120 + (c.n % 180), 100000
    from perf_contacts c where c.n <= 4000
  returning id, contact_id, number
) select substr(number, 4)::int as n, id, contact_id from d;

create temporary table perf_pay on commit drop as
with p as (
  insert into public.payments (organization_id, contact_id, amount_agorot, method, status)
  select :'org', d.contact_id, 40000, 'transfer', 'confirmed' from perf_docs d where d.n % 2 = 0
  returning id, contact_id
) select id, contact_id from p;
insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
select :'org', p.id, d.id, 40000 from perf_pay p join perf_docs d on d.contact_id = p.contact_id;

\timing on
\echo '--- commit (the deferred BAL-02 and PAY-03 refreshes of every row above)'
commit;
\timing off

analyze public.contacts;
analyze public.companies;
analyze public.debt_document_customers;
analyze public.customer_debt_totals;
select count(*) as open_rows, sum(balance_agorot) as open_agorot from public.debt_document_customers where organization_id = :'org' and balance_agorot > 0;
select count(*) as totals from public.customer_debt_totals where organization_id = :'org';
\echo 'seeded; now run scripts/perf/customer-debt-measure.sql'
