-- =============================================================================
-- A failed outbox event waits for the next run (RVW-20)
-- =============================================================================
-- Since 0039 the every-minute job calls app.process_outbox() again and again
-- (app.process_outbox_rounds) until the queue is empty. An event that failed
-- stayed the oldest pending one, so every round picked it again: with a queue
-- longer than one round it used up its five attempts within seconds, and a
-- passing failure no longer got five minutes to clear.
-- * outbox_events.last_attempt_at records when an event was last tried
--   (server only: the table has no client grants at all).
-- * process_outbox() skips an event that was already tried in the current
--   transaction (last_attempt_at = now(), the transaction's start time). One
--   run of the job is one statement and therefore one transaction, so a failed
--   event is tried once per run, i.e. once a minute, as before 0039.
-- Everything else process_outbox() does is as in 0012. Safe to run twice.

alter table public.outbox_events add column if not exists last_attempt_at timestamptz;

create or replace function app.process_outbox(p_limit integer default 500) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_event public.outbox_events%rowtype;
  v_auto public.automations%rowtype;
  v_record jsonb;
  v_count integer := 0;
begin
  for v_event in
    select * from public.outbox_events e
     where e.processed_at is null
       -- tried earlier in this run (same transaction): wait for the next run
       and (e.last_attempt_at is null or e.last_attempt_at < now())
     order by e.id limit p_limit for update skip locked
  loop
    begin
      if coalesce(v_event.payload ->> 'origin', '') not in ('automation', 'import') and app.org_writable(v_event.organization_id) then
        for v_auto in
          select * from public.automations a
           where a.organization_id = v_event.organization_id and a.is_active and a.entity_type = v_event.entity_type
             and a.trigger_type in ('created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost')
        loop
          v_record := app.automation_record(v_event.entity_type, v_event.organization_id, v_event.entity_id);
          if v_record is not null and app.automation_event_matches(v_auto, v_event, v_record) then
            perform app.execute_automation(v_auto, v_event.entity_id, 'event:' || v_event.id);
          end if;
        end loop;
      end if;
      update public.outbox_events set processed_at = now(), attempts = attempts + 1, last_attempt_at = now() where id = v_event.id;
    exception when others then
      update public.outbox_events
         set attempts = attempts + 1, last_error = left(sqlerrm, 500), last_attempt_at = now(),
             processed_at = case when attempts + 1 >= 5 then now() end
       where id = v_event.id;
    end;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.process_outbox(integer) from public, anon, authenticated;
grant execute on function app.process_outbox(integer) to service_role;
