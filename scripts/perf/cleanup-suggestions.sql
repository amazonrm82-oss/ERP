-- Performance probe for public.cleanup_suggestions (DQL-03, review 1; not run by CI).
--
-- Run ONLY against your own local throwaway test database (a database built by `npm run test:db`, name ending in _test):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/cleanup-suggestions.sql
-- It creates one new business 'perf cleanup' (each run adds another; the next test:db rebuilds the database) with
--   20,000 leads and 20,000 contacts (2,000 of each made "now", the rest 60 to 400 days ago), phones and emails drawn from a
--   pool so about one record in ten shares a key, 5,000 further contact channels, 2,000 companies (names repeating), a
--   select field with five options on leads (two options almost never used), 500 open leads with no owner, and a manager
--   who leads a team the owner is in, holding half the leads and contacts.
-- Then run scripts/perf/cleanup-suggestions-measure.sql, which times the function on the newest such business.
\set QUIET on
\pset pager off
select current_database() like '%\_test' as is_test \gset
\if :is_test
\else
  \echo 'refusing: not a _test database'
  \quit
\endif

begin;
create temporary table perf_ids (k text primary key, v uuid) on commit drop;
with u as (insert into auth.users (email, raw_user_meta_data)
           values ('perf-cleanup-' || gen_random_uuid() || '@example.test', '{"full_name":"perf"}') returning id)
insert into perf_ids select 'owner', id from u;
select set_config('request.jwt.claims', json_build_object('sub', (select v from perf_ids where k = 'owner'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_organization('perf cleanup') as org \gset
reset role;
select set_config('request.jwt.claims', '', true);
select id as status from public.lead_statuses where organization_id = :'org' and is_default \gset
select v as owner from perf_ids where k = 'owner' \gset

-- a manager who leads a team the owner is in (the measure's manager path, with 'team' visibility)
with u as (insert into auth.users (email, raw_user_meta_data)
           values ('perf-cleanup-mgr-' || gen_random_uuid() || '@example.test', '{"full_name":"perf manager"}') returning id)
insert into perf_ids select 'manager', id from u;
insert into public.memberships (organization_id, user_id, role) values (:'org', (select v from perf_ids where k = 'manager'), 'manager');
with t as (insert into public.teams (organization_id, name) values (:'org', 'perf team') returning id)
insert into public.team_members (organization_id, team_id, user_id, is_manager)
select :'org', t.id, x.user_id, x.is_manager
  from t, (values ((select v from perf_ids where k = 'manager'), true), ((select v from perf_ids where k = 'owner'), false)) x(user_id, is_manager);

insert into public.field_definitions (organization_id, object_type, key, label, field_type, options)
values (:'org', 'lead', 'size', 'גודל', 'select', '["קטן","בינוני","גדול","ענק","זעיר"]');

-- the server writes the rest (no JWT); created_at is set with the triggers off (app.touch_row keeps it otherwise)
set local session_replication_role = replica;
insert into public.leads (organization_id, status_id, full_name, phone, phone_e164, email, owner_id, custom_fields, created_at)
select :'org', :'status', 'ליד ' || g,
       '05' || lpad((g % 18000)::text, 8, '0'), '+9725' || lpad((g % 18000)::text, 8, '0'),
       case when g % 3 = 0 then 'lead' || (g % 17000) || '@example.test' end,
       case when g % 40 = 0 then null else :'owner'::uuid end,
       jsonb_build_object('size', case when g % 1000 = 0 then 'ענק' else (array['קטן','בינוני','גדול'])[1 + g % 3] end),
       case when g <= 2000 then now() - make_interval(hours => g % 600) else now() - make_interval(days => 60 + g % 340) end
  from generate_series(1, 20000) g;
insert into public.contacts (organization_id, first_name, last_name, phone, phone_e164, email, owner_id, created_at)
select :'org', 'איש', 'קשר ' || g,
       case when g % 7 <> 0 then '05' || lpad((g % 18500)::text, 8, '1') end,
       case when g % 7 <> 0 then '+9725' || lpad((g % 18500)::text, 8, '1') end,
       case when g % 2 = 0 then 'contact' || (g % 18000) || '@example.test' end,
       :'owner'::uuid,
       case when g <= 2000 then now() - make_interval(hours => g % 600) else now() - make_interval(days => 60 + g % 340) end
  from generate_series(1, 20000) g;
insert into public.contact_channels (organization_id, contact_id, kind, value, value_e164)
select :'org', c.id, 'phone', '07' || lpad(n::text, 8, '0'), '+9727' || lpad((n % 4500)::text, 8, '0')
  from (select id, row_number() over (order by id) as n from public.contacts where organization_id = :'org') c
 where c.n <= 5000;
insert into public.companies (organization_id, name, owner_id, created_at)
select :'org', 'חברה ' || (g % 1800), :'owner'::uuid,
       case when g <= 200 then now() else now() - make_interval(days => 60 + g % 300) end
  from generate_series(1, 2000) g;
-- half the leads and contacts belong to the manager's team (what the manager reads with 'team' visibility)
update public.leads set team_id = (select id from public.teams where organization_id = :'org')
 where organization_id = :'org' and (('x' || substr(md5(id::text), 1, 1))::bit(4)::int % 2) = 0;
update public.contacts set team_id = (select id from public.teams where organization_id = :'org')
 where organization_id = :'org' and (('x' || substr(md5(id::text), 1, 1))::bit(4)::int % 2) = 0;
set local session_replication_role = origin;
commit;
analyze public.leads;
analyze public.contacts;
analyze public.contact_channels;
analyze public.companies;
\echo 'made business' :org
