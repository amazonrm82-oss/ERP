-- Performance probe for public.money_allocation_state (not run by CI).
--
-- Run ONLY against your own local throwaway test database (a database built by `npm run test:db`, name ending in _test):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/money-allocation-state.sql
-- It creates one new business (each run adds another; the database is rebuilt by the next test:db) with
--   ~200 contacts, 500 open documents (400 tax invoices, 100 proformas, 50 of them billed by an invoice),
--   5,000 payments and 5,000 counted allocations (plus 500 released and 500 removed ones), 50 negative opening balances
--   with about 100 opening-credit offsets.
-- Then run scripts/perf/money-allocation-state-measure.sql, which times the function on the newest such business.
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif

begin;
-- an owner and a business, made the way the app makes them
create temporary table perf_ids (k text primary key, v uuid) on commit preserve rows;
with u as (insert into auth.users (email, raw_user_meta_data)
           values ('perf-owner-' || gen_random_uuid() || '@example.test', '{"full_name":"perf"}') returning id)
insert into perf_ids select 'owner', id from u;
select set_config('request.jwt.claims', json_build_object('sub', (select v from perf_ids where k = 'owner'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_organization('perf business') as org \gset
reset role;
select set_config('request.jwt.claims', '', true);
insert into perf_ids values ('org', :'org');
update public.subscriptions set feature_overrides = '{"documents": true, "payments": true, "balances": true}'::jsonb
 where organization_id = :'org';

-- the server writes the rest (no JWT: every guard treats it as a server write)
create temporary table perf_contacts on commit drop as
with c as (
  insert into public.contacts (organization_id, first_name, owner_id)
  select :'org', 'perf ' || g, (select v from perf_ids where k = 'owner') from generate_series(1, 200) g
  returning id
) select row_number() over (order by id) as n, id from c;

-- 400 tax invoices and 100 proformas, two or three per contact, big enough for 10 allocations each
create temporary table perf_docs on commit drop as
with d as (
  insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot)
  select :'org', c.id, case when g <= 400 then 'tax_invoice' else 'proforma' end, 'P-' || g, date '2026-01-01' + (g % 200),
         100000
    from generate_series(1, 500) g join perf_contacts c on c.n = 1 + (g % 200)
  returning id, contact_id, doc_type
) select row_number() over (order by id) as n, id, contact_id, doc_type from d;

-- 50 invoices bill a proforma of the same contact (invoice P-g and proforma P-(g+400) share a contact)
update public.accounting_documents i set proforma_id = p.id
  from public.accounting_documents p
 where i.organization_id = :'org' and p.organization_id = :'org'
   and i.doc_type = 'tax_invoice' and p.doc_type = 'proforma'
   and i.number in (select 'P-' || g from generate_series(1, 50) g)
   and p.number = 'P-' || (substr(i.number, 3)::int + 400);

-- 5,000 payments of 1,000 agorot, 10 per document's contact
create temporary table perf_pay on commit drop as
with p as (
  insert into public.payments (organization_id, contact_id, amount_agorot, method, status)
  select :'org', d.contact_id, 1000, 'transfer', case when g % 3 = 0 then 'confirmed' else 'recorded' end
    from generate_series(1, 5000) g join perf_docs d on d.n = 1 + (g % 500)
  returning id, contact_id
) select row_number() over (order by id) as n, id, contact_id from p;

-- each payment allocated once to a document of its contact that takes payments (5,000 counted allocations, 600 agorot each)
insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
select :'org', p.id, d.id, 600
  from perf_pay p
  join lateral (select d.id from perf_docs d
                 where d.contact_id = p.contact_id
                   and not exists (select 1 from public.accounting_documents i
                                    where i.organization_id = :'org' and i.proforma_id = d.id and i.status = 'active')
                 order by md5(d.id::text || p.id::text) limit 1) d on true;
-- 1,000 more that no longer count: 500 removed, 500 released
insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
select :'org', p.id, a.document_id, 100
  from perf_pay p join public.payment_allocations a on a.organization_id = :'org' and a.payment_id = p.id
 where p.n <= 1000;
update public.payment_allocations set removed_at = now()
 where organization_id = :'org' and amount_agorot = 100
   and id in (select id from public.payment_allocations where organization_id = :'org' and amount_agorot = 100 order by id limit 500);
-- a fixture shortcut: released_at is set by the server's release triggers; skip the guard here
set session_replication_role = replica;
update public.payment_allocations set released_at = now()
 where organization_id = :'org' and amount_agorot = 100 and removed_at is null;

-- 50 negative opening balances, four offsets each onto that contact's documents
create temporary table perf_ob on commit drop as
with o as (
  insert into public.accounting_documents (organization_id, contact_id, doc_type, doc_date, amount_agorot)
  select :'org', c.id, 'opening_balance', date '2025-12-31', -20000 from perf_contacts c where c.n <= 50
  returning id, contact_id
) select id, contact_id from o;
insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot)
select :'org', o.id, d.id, 1000
  from perf_ob o
  join lateral (select d.id from perf_docs d where d.contact_id = o.contact_id and d.doc_type = 'tax_invoice' limit 4) d on true;

commit;

analyze public.accounting_documents;
analyze public.payments;
analyze public.payment_allocations;
analyze public.opening_credit_allocations;

select count(*) filter (where doc_type in ('tax_invoice', 'proforma')) as open_docs,
       count(*) filter (where doc_type = 'opening_balance') as opening_balances
  from public.accounting_documents where organization_id = :'org';
select count(*) filter (where released_at is null and removed_at is null) as counted_allocations, count(*) as all_allocations
  from public.payment_allocations where organization_id = :'org';
select count(*) as opening_offsets from public.opening_credit_allocations where organization_id = :'org';

\echo 'seeded; now run scripts/perf/money-allocation-state-measure.sql'
