-- Timings for CON-11 / RET-01 on the business scripts/perf/customer-status.sql made (not run by CI; own _test database only).
--   psql "$TEST_DATABASE_URL" -f scripts/perf/customer-status-measure.sql
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif
set statement_timeout = '300s';
select id as org from public.organizations where name = 'perf con11' order by created_at desc limit 1 \gset
select user_id as owner from public.memberships where organization_id = :'org' and role = 'owner' \gset
select user_id as member from public.memberships where organization_id = :'org' and role = 'member' \gset
select id as c1 from public.contacts where organization_id = :'org' and first_name = 'perf 7' \gset
select id as c2 from public.contacts where organization_id = :'org' and first_name = 'perf 19000' \gset
select company_id as co1 from public.contacts where organization_id = :'org' and first_name = 'perf 8' \gset
select array_agg(id)::text as page from (select id from public.contacts where organization_id = :'org' order by created_at desc limit 50) x \gset
\timing on
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\echo '--- owner: card (customer_summary) of a buyer, a non-buyer, a company'
select public.customer_summary(:'org', :'c1', null) is not null;
select public.customer_summary(:'org', :'c2', null) is not null;
select public.customer_summary(:'org', null, :'co1') is not null;
\echo '--- owner: baseline, one page of 50 without the fields (RLS alone)'
select count(*) from (select id from public.contacts c where organization_id = :'org' order by created_at desc limit 50) x;
\echo '--- owner: baseline, the whole contacts list sorted by name, first page (RLS alone)'
select count(*) from (select id from public.contacts c where organization_id = :'org' and deleted_at is null order by first_name, id limit 50) x;
\echo '--- owner: the two columns of one list page of 50 ids (as getCustomerNumbers reads them)'
select count(*) from (select id, customer_status(c), customer_value(c) from public.contacts c
  where organization_id = :'org' and id = any (:'page'::uuid[])) x;
\echo '--- owner: one list page of 50 with the two columns'
select count(*) from (select id, customer_status(c), customer_value(c) from public.contacts c where organization_id = :'org' order by created_at desc limit 50) x;
\echo '--- owner: sort the whole contacts list by customer_status, first page'
select count(*) from (select id from public.contacts c where organization_id = :'org' and deleted_at is null order by customer_status(c) nulls last, id limit 50) x;
\echo '--- owner: sort the companies by customer_value, first page'
select count(*) from (select id from public.companies c where organization_id = :'org' and deleted_at is null order by customer_value(c) desc nulls last, id limit 50) x;
\echo '--- owner: filter customer_status = dormant (count over every contact)'
select count(*) from public.contacts c where organization_id = :'org' and deleted_at is null and customer_status(c) = 'dormant';
\echo '--- owner: the dormant list (contacts, 200)'
select jsonb_array_length(public.dormant_customers(:'org', 'contact', 200) -> 'rows');
\echo '--- owner: the dormant list (companies, 200)'
select jsonb_array_length(public.dormant_customers(:'org', 'company', 200) -> 'rows');
commit;
update public.organizations set record_visibility = 'own' where id = :'org';
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'member', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\echo '--- member (own): card of a contact and of a company'
select public.customer_summary(:'org', :'c1', null) is not null;
select public.customer_summary(:'org', null, :'co1') is not null;
\echo '--- member (own): one list page of 50 with the two columns (null for a member)'
select count(*) from (select id, customer_status(c), customer_value(c) from public.contacts c where organization_id = :'org' order by created_at desc limit 50) x;
commit;
update public.organizations set record_visibility = 'org' where id = :'org';
\echo '--- one dormant scan pass (a contact rule that makes a task; rolled back)'
begin;
insert into public.automations (organization_id, name, entity_type, trigger_type, actions, created_by)
values (:'org', 'perf dormant', 'contact', 'customer_dormant', '[{"type": "create_task", "title": "לחזור", "due_in_days": 1}]', :'owner');
select set_config('app.date_trigger_hour', '0', true) \g /dev/null
select app.run_dormant_automations() as runs;
rollback;
\echo '--- a refresh of one deal (update its amount; rolled back after the commit-time trigger runs by set constraints)'
begin;
update public.deals set amount_agorot = amount_agorot + 1 where organization_id = :'org' and contact_id = :'c1';
set constraints all immediate;
rollback;
