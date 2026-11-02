-- Performance probe for CON-11 / RET-01 (not run by CI).
--
-- Run ONLY against your own local throwaway test database (a database built by `npm run test:db`, name ending in _test):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/customer-status.sql
-- It creates one new business ('perf con11'; each run adds another) with 20,000 contacts (6,000 of them in 2,000 companies),
-- 8,000 won deals (half with the contact's company) and 8,000 open deals, and 4,000 payments (2,000 on won deals, 2,000 with
-- no deal). The kept-facts triggers run as in production; the time of each seeding commit is printed. Then run
-- scripts/perf/customer-status-measure.sql.
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing'
  \quit
\endif
\timing on
begin;
create temporary table perf_ids (k text primary key, v uuid) on commit preserve rows;
with u as (insert into auth.users (email, raw_user_meta_data) values ('perf-c11-' || gen_random_uuid() || '@example.test', '{"full_name":"perf"}') returning id)
insert into perf_ids select 'owner', id from u;
with u as (insert into auth.users (email, raw_user_meta_data) values ('perf-c11m-' || gen_random_uuid() || '@example.test', '{"full_name":"perfm"}') returning id)
insert into perf_ids select 'member', id from u;
select set_config('request.jwt.claims', json_build_object('sub', (select v from perf_ids where k = 'owner'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_organization('perf con11') as org \gset
reset role;
select set_config('request.jwt.claims', '', true);
update public.subscriptions set seats = 50, feature_overrides = '{"payments": true}'::jsonb where organization_id = :'org';
insert into public.memberships (organization_id, user_id, role) values (:'org', (select v from perf_ids where k = 'member'), 'member');
insert into perf_ids select 'org', :'org';
create temporary table perf_companies on commit drop as
with c as (insert into public.companies (organization_id, name, owner_id)
  select :'org', 'perf company ' || g, (select v from perf_ids where k = 'owner') from generate_series(1, 2000) g returning id, name)
select row_number() over (order by name) as n, id from c;
create temporary table perf_contacts on commit drop as
with c as (insert into public.contacts (organization_id, first_name, owner_id, company_id)
  select :'org', 'perf ' || g,
         case when g % 3 = 0 then (select v from perf_ids where k = 'member') else (select v from perf_ids where k = 'owner') end,
         case when g <= 6000 then (select id from perf_companies where n = 1 + (g % 2000)) end
    from generate_series(1, 20000) g returning id, first_name, company_id)
select substr(first_name, 6)::int as n, id, company_id from c;
select p.id as pipe, s.id as won, s2.id as open from public.pipelines p
  join public.stages s on s.pipeline_id = p.id and s.kind = 'won'
  join public.stages s2 on s2.pipeline_id = p.id and s2.kind = 'open'
 where p.organization_id = :'org' limit 1 \gset
-- 8,000 won deals over the first 8,000 contacts (half with the contact's company), 8,000 open deals
insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, amount_agorot, owner_id, closed_at)
select :'org', 'd' || c.n, :'pipe', :'won', c.id, case when c.n % 2 = 0 then c.company_id end, 1000 * c.n,
       case when c.n % 4 = 0 then (select v from perf_ids where k = 'member') else (select v from perf_ids where k = 'owner') end,
       now() - (c.n % 900) * interval '1 day'
  from perf_contacts c where c.n <= 8000;
insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, amount_agorot, owner_id)
select :'org', 'o' || c.n, :'pipe', :'open', c.id, 500, (select v from perf_ids where k = 'owner')
  from perf_contacts c where c.n > 8000 and c.n <= 16000;
-- 2,000 payments on won deals, 2,000 payments with no deal (contacts 8,001..10,000)
insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method)
select :'org', d.id, d.contact_id, 1000, (d.closed_at at time zone 'Asia/Jerusalem')::date, 'cash'
  from public.deals d where d.organization_id = :'org' and d.status = 'won' order by d.id limit 2000;
insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method)
select :'org', c.id, 700, current_date - (c.n % 700), 'cash' from perf_contacts c where c.n > 8000 and c.n <= 10000;
\echo '--- the seeding commit (the kept facts are refreshed here)'
commit;
\timing off
analyze public.contacts; analyze public.companies; analyze public.deals; analyze public.payments; analyze app.customer_purchase_facts;
select count(*) filter (where status = 'won') won, count(*) total from public.deals where organization_id = :'org';
\echo :org
