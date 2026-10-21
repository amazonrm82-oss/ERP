-- =============================================================================
-- PAY-07 part two: the automation trigger "התקבל תשלום" (payment_received)
-- =============================================================================
-- * automations.trigger_type takes 'payment_received', for deal and contact rules. trigger_config may carry
--   min_agorot (a whole number of agorot): the rule runs only for a payment of at least that amount.
-- * A payment that is recorded (inserted as recorded or confirmed) writes one outbox event per linked record:
--   event_type 'payment_received', entity_type 'deal' with the payment's deal, and another with entity_type
--   'contact' with its contact, when it has one (lead's answer, 20 October 2026: contact rules also see a payment
--   on a deal). Payload: payment_id, amount_agorot, method, status, and origin 'automation' while an automation
--   runs (app.automation_running), so an automation that records a payment starts no other automation.
-- * Only the insert writes an event: a later change (status, correction, cancel, refund, the merge move, erasure)
--   writes none. A server insert in another status (payments_check allows failed or refunded without a session)
--   writes none either.
-- * app.automation_event_matches learns the new case; it never raises on a stored config (a min_agorot that is
--   not a JSON number is ignored), because one failing rule would fail the event for every rule.
-- * app.process_outbox (the body of 008100) offers the event to 'payment_received' rules.
-- PAY-07 part one (020660, payments_notify_received) sends the notices; this trigger is separate from it.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.automations drop constraint if exists automations_trigger_type_check;
alter table public.automations add constraint automations_trigger_type_check check (trigger_type = any (array[
  'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'no_activity', 'stuck_in_stage', 'birthday',
  'task_due_soon', 'date_reached', 'payment_received']));

create or replace function app.emit_payment_received() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if new.status not in ('recorded', 'confirmed') then
    return null;
  end if;
  v_payload := jsonb_build_object('payment_id', new.id, 'amount_agorot', new.amount_agorot, 'method', new.method,
                                  'status', new.status)
               || case when current_setting('app.automation_running', true) = 'on'
                       then jsonb_build_object('origin', 'automation') else '{}'::jsonb end;
  if new.deal_id is not null then
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (new.organization_id, 'payment_received', 'deal', new.deal_id, auth.uid(), v_payload);
  end if;
  if new.contact_id is not null then
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (new.organization_id, 'payment_received', 'contact', new.contact_id, auth.uid(), v_payload);
  end if;
  return null;
end;
$$;
revoke all on function app.emit_payment_received() from public, anon, authenticated, service_role;

create or replace trigger payments_emit_received after insert on public.payments
  for each row when (new.status in ('recorded', 'confirmed')) execute function app.emit_payment_received();

create or replace function app.automation_event_matches(p_auto public.automations, p_event public.outbox_events, p_record jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_auto.entity_type = p_event.entity_type and case p_auto.trigger_type
    when 'created' then p_event.event_type = p_auto.entity_type || '.created'
    when 'field_changed' then p_event.event_type = p_auto.entity_type || '.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? (p_auto.trigger_config ->> 'field')
      and ((p_auto.trigger_config ->> 'to') is null or p_record ->> (p_auto.trigger_config ->> 'field') = p_auto.trigger_config ->> 'to')
    when 'task_completed' then p_event.event_type = 'task.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'done'
    when 'deal_won' then p_event.event_type = 'deal.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'won'
    when 'deal_lost' then p_event.event_type = 'deal.updated'
      and coalesce(p_event.payload -> 'changed', '[]'::jsonb) ? 'status' and p_record ->> 'status' = 'lost'
    -- PAY-07: at least min_agorot when the rule sets it (a value that is not a JSON number is ignored)
    when 'payment_received' then p_event.event_type = 'payment_received'
      and (jsonb_typeof(p_auto.trigger_config -> 'min_agorot') is distinct from 'number'
           or jsonb_typeof(p_event.payload -> 'amount_agorot') = 'number'
              and (p_event.payload ->> 'amount_agorot')::numeric >= (p_auto.trigger_config ->> 'min_agorot')::numeric)
    else false
  end
$$;
revoke all on function app.automation_event_matches(public.automations, public.outbox_events, jsonb) from public, anon, authenticated;

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
             and a.trigger_type in ('created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'payment_received')
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
