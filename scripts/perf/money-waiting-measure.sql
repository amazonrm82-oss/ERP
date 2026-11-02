-- Times public.report_money_waiting as the owner on the newest business made by scripts/perf/money-waiting.sql
-- (local _test database only). Prints the plans of the nested statements that took over 50 ms (auto_explain,
-- needs a superuser connection for LOAD) and the time of three calls; the answer's debts must be {count 5, amount 5000}.
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/money-waiting-measure.sql
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif
select o.id as org, m.user_id as uid
  from public.organizations o
  join public.memberships m on m.organization_id = o.id and m.role = 'owner'
 where o.name = 'perf money waiting'
 order by o.created_at desc limit 1 \gset

begin;
load 'auto_explain';
set local auto_explain.log_min_duration = 50;
set local auto_explain.log_nested_statements = on;
set local auto_explain.log_analyze = on;
set local auto_explain.log_buffers = on;
set local auto_explain.log_level = notice;
select set_config('request.jwt.claims', json_build_object('sub', :'uid', 'role', 'authenticated')::text, true);
set local role authenticated;
\timing on
select public.report_money_waiting(:'org') -> 'debts' -> 'count' as debts_count,
       public.report_money_waiting(:'org') -> 'debts' -> 'amount' as debts_amount;
select length(public.report_money_waiting(:'org')::text) as answer_length;
\timing off
rollback;
