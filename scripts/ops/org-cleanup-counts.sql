-- READ-ONLY. Rows per table for the three businesses of the 9 November 2026 cleanup
-- (supabase/migrations/20261006021193_org_delete_cancelled.sql). Run it before and after the paste and compare.
-- Every table in public and app with organization_id, plus the Storage objects and the cleanup queue by path prefix.
-- It only reads (query_to_xml runs a select per table); it writes nothing.
with orgs(label, id) as (
  values ('cancelled (removed)', 'a415bb9e-a965-4ad1-a7e0-85b22637e76f'::uuid),
         ('reset',               'e3bcb98c-2cd7-47f9-ab61-e0f233a66305'::uuid),
         ('untouched',           '7684fff2-200c-4be3-9276-b41cf53cd7e6'::uuid)),
tables as (
  select n.nspname || '.' || c.relname as t
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
   where n.nspname in ('public', 'app') and c.relkind in ('r', 'p')),
counts as (
  select o.label, t.t as table_name,
         (xpath('/row/n/text()',
                query_to_xml(format('select count(*) as n from %s where organization_id = %L', t.t, o.id), false, true, '')))[1]::text::bigint as n
    from orgs o cross join tables t
  union all
  select o.label, 'public.organizations',
         (select count(*) from public.organizations x where x.id = o.id) from orgs o
  union all
  select o.label, 'storage.objects (' || s.bucket_id || ')', count(*)
    from orgs o join storage.objects s on s.name like o.id::text || '/%' group by o.label, s.bucket_id
  union all
  select o.label, 'app.orphan_files (' || f.bucket || ', ' || case when f.deleted_at is null then 'waiting' else 'done' end || ')', count(*)
    from orgs o join app.orphan_files f on f.storage_path like o.id::text || '/%'
   group by o.label, f.bucket, f.deleted_at is null)
select label, table_name, n
  from counts
 where n > 0
 order by label, table_name;
