-- =============================================================================
-- FXD-08 part two: move the pg_net extension out of schema public (pasted by hand)
-- =============================================================================
-- Owner, 18 October 2026: a hand-paste file, run at a quiet hour, with written rollback steps
-- (fxd08_pg_net_rollback.sql next to this file; guide: docs/paste/FXD-08-pg_net.md). Not a migration: it changes
-- where an extension lives, not our schema, and it holds a drop.
--
-- Why drop and create: pg_net is not relocatable (ALTER EXTENSION ... SET SCHEMA is refused). Its functions and tables
-- always live in schema `net`; only the extension's own schema (what the advisor flags) moves to `extensions`.
-- Our callers are unaffected: app.dispatch_push and app.cleanup_files (the only functions of ours that use pg_net,
-- tests/db/167) call net.http_post(...) by its schema-qualified name through dynamic SQL, and check only that an
-- extension named pg_net exists. The cron jobs call those two functions, not pg_net.
-- What is lost: requests still waiting in net.http_request_queue and the stored responses in net._http_response
-- (a few seconds of push wake-ups; the next minute's cron run sends again). Hence the quiet hour.
-- Safety: one DO block, so all or nothing; the same version is created again; no CASCADE, so if anything depends on
-- the extension the drop is refused and nothing changes. Safe to run twice (the second run only reports).

do $$
declare
  v_schema text;
  v_version text;
begin
  select n.nspname, e.extversion into v_schema, v_version
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_net';
  if v_schema is null then
    raise notice 'pg_net is not installed: nothing to do';
    return;
  end if;
  if v_schema <> 'public' then
    raise notice 'pg_net is already in schema %: nothing to do', v_schema;
    return;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'extensions') then
    raise exception 'schema extensions is missing: nothing was changed';
  end if;
  execute 'drop extension pg_net';
  execute format('create extension pg_net schema extensions version %L', v_version);
  raise notice 'pg_net % moved from public to extensions', v_version;
end;
$$;

-- the result: one row, pg_net_schema = extensions
select n.nspname as pg_net_schema, e.extversion as version
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
 where e.extname = 'pg_net';
