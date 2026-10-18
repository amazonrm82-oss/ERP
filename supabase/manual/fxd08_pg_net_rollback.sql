-- =============================================================================
-- FXD-08 part two, ROLLBACK: put pg_net back in schema public (pasted by hand, only if needed)
-- =============================================================================
-- Undoes fxd08_pg_net_move.sql. Use it only when push or file cleanup stopped working after the move and the checks in
-- docs/paste/FXD-08-pg_net.md point at pg_net. Same rules: one DO block (all or nothing), the same version, no
-- CASCADE, waiting requests in net.http_request_queue are lost. Safe to run twice.

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
  if v_schema = 'public' then
    raise notice 'pg_net is already in schema public: nothing to do';
    return;
  end if;
  execute 'drop extension pg_net';
  execute format('create extension pg_net schema public version %L', v_version);
  raise notice 'pg_net % moved from % back to public', v_version, v_schema;
end;
$$;

select n.nspname as pg_net_schema, e.extversion as version
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
 where e.extname = 'pg_net';
