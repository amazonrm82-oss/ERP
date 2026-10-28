-- Times BAL-02's list columns on the newest business made by scripts/perf/customer-debt.sql (not run by CI).
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/customer-debt-measure.sql
-- As the business's owner (role authenticated + JWT claims, so RLS applies as for a real caller), three runs each of the
-- contacts list's first page (50 rows) sorted by the kept value (debt_balance, overdue_debt) and filtered by
-- has_overdue_debt, against the same sort computed when read (a throwaway function over money_allocation_state, the one
-- rule, per row and customer, created and rolled back here); then one allocation's commit on the big company (the cost a
-- write pays for the kept rows).
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

\echo '=== kept totals (this branch)'
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
\timing on
\echo '--- sorted by open debt x3'
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by public.debt_balance(c) desc nulls last, c.id limit 50) x;
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by public.debt_balance(c) desc nulls last, c.id limit 50) x;
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by public.debt_balance(c) desc nulls last, c.id limit 50) x;
\echo '--- sorted by overdue debt x3'
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by public.overdue_debt(c) desc nulls last, c.id limit 50) x;
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by public.overdue_debt(c) desc nulls last, c.id limit 50) x;
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by public.overdue_debt(c) desc nulls last, c.id limit 50) x;
\echo '--- filtered by has_overdue_debt, sorted by created x3'
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null and public.has_overdue_debt(c) order by c.created_at desc, c.id limit 50) x;
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null and public.has_overdue_debt(c) order by c.created_at desc, c.id limit 50) x;
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null and public.has_overdue_debt(c) order by c.created_at desc, c.id limit 50) x;
\echo '--- reference: sorted by credit_balance (PAY-03) x1, by created x1'
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by public.credit_balance(c) desc nulls last, c.id limit 50) x;
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null order by c.created_at desc, c.id limit 50) x;
\timing off
rollback;

\echo '=== computed when read (the alternative; a throwaway function, rolled back)'
begin;
-- the customer's open debt by the one rule, read under the caller's RLS: PAY-02's scope, then money_allocation_state
create function public.zz_perf_debt_when_read(p_org uuid, p_company uuid, p_contact uuid) returns bigint
language sql stable set search_path = '' as $$
  with docs as (
    select d.id from public.accounting_documents d
     where d.organization_id = p_org and d.status = 'active' and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
       and d.amount_agorot > 0
       and ((p_company is null and d.contact_id = p_contact)
            or (p_company is not null and (d.company_id = p_company
                 or d.contact_id in (select k.id from public.contacts k where k.organization_id = p_org and k.company_id = p_company)
                 or d.deal_id in (select e.id from public.deals e where e.organization_id = p_org and e.company_id = p_company)))))
  select coalesce(sum((x ->> 'balance')::bigint), 0)::bigint
    from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from docs), '{}'::uuid[])
                              -> 'documents') x
$$;
grant execute on function public.zz_perf_debt_when_read(uuid, uuid, uuid) to authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
set local statement_timeout = '600s';
\set ON_ERROR_STOP off
\timing on
\echo '--- sorted by open debt computed when read x1'
select count(*) from (select c.id from public.contacts c where c.organization_id = :'org' and c.deleted_at is null
                       order by public.zz_perf_debt_when_read(c.organization_id, c.company_id, c.id) desc, c.id limit 50) x;
\timing off
rollback;

\set ON_ERROR_STOP on
\echo '=== one allocation on the big company: its commit refreshes the kept rows'
select d.id as doc, d.contact_id as contact from public.accounting_documents d
  join public.contacts c on c.organization_id = d.organization_id and c.id = d.contact_id
  join public.companies co on co.organization_id = c.organization_id and co.id = c.company_id and co.name = 'perf company 1'
 where d.organization_id = :'org' and d.doc_type = 'tax_invoice'
   and not exists (select 1 from public.payment_allocations a where a.document_id = d.id)
 order by d.id limit 1 \gset
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true) \g /dev/null
set local role authenticated;
insert into public.payments (organization_id, contact_id, amount_agorot, method) values (:'org', :'contact', 1000, 'cash') returning id as pay \gset
insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values (:'org', :'pay', :'doc', 1000);
\timing on
\echo '--- commit'
commit;
\timing off
