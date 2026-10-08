-- =============================================================================
-- 0039 The event queue keeps up with large imports (FXD-01)
-- =============================================================================
-- process_outbox() handled 500 events a minute for the whole platform, and an
-- import of 50,000 rows queued 50,000 events that it only skipped (imports and
-- automations do not trigger automations). Every customer's automations waited
-- behind them for about an hour and a half.
-- * Events that come from an import or from an automation are written already
--   handled (processed_at set), so they never wait in the queue.
-- * app.process_outbox_rounds() calls process_outbox() again and again until the
--   queue is empty or 45 seconds have passed; the every-minute job calls it.
-- Every statement is safe to run twice.

create or replace function app.outbox_skip_internal() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(new.payload ->> 'origin', '') in ('automation', 'import') then
    new.processed_at := coalesce(new.processed_at, now());
  end if;
  return new;
end;
$$;
revoke all on function app.outbox_skip_internal() from public, anon, authenticated;

create or replace trigger outbox_events_skip_internal before insert on public.outbox_events
  for each row execute function app.outbox_skip_internal();

create or replace function app.process_outbox_rounds(p_batch integer default 500, p_budget interval default interval '45 seconds')
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_done integer;
  v_total integer := 0;
begin
  loop
    v_done := app.process_outbox(p_batch);
    v_total := v_total + v_done;
    exit when v_done < p_batch or clock_timestamp() - v_started > p_budget;
  end loop;
  return v_total;
end;
$$;
revoke all on function app.process_outbox_rounds(integer, interval) from public, anon, authenticated;
grant execute on function app.process_outbox_rounds(integer, interval) to service_role;

-- the every-minute job (same name: pg_cron replaces the command)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-process-outbox', '* * * * *', 'select app.process_outbox_rounds()');
  end if;
end;
$$;
