-- =============================================================================
-- PAY-07 follow-up: the owner's answers of 21 October 2026 (2), (3) and (4)
-- =============================================================================
-- (2) A payment on a record with no usable owner tells the active owners and admins. The notice goes to the deal's owner
--     when that is an active member who is not a viewer, else to the contact's owner on the same terms, else to every
--     active owner and admin of the business. Never to the person who recorded the payment: when the chosen owner recorded
--     it, nobody is told (they know). The notice still leads to the deal, else the contact.
-- (4) The notice is of the kind `payment` (already in both kind constraints since 0068, and in NOTIFICATION_KINDS, now
--     shown), so a person can mute it or keep it to the bell. Notices sent before this stay `system`. The text names no
--     record, so the notification-text redraw (FLD-10 part three) needs nothing.
-- (3) A second automation trigger "תשלום אושר" (payment_confirmed), for deal and contact rules, with the same optional
--     min_agorot: a payment inserted as confirmed, or moved from recorded to confirmed, writes one outbox event per linked
--     record (event_type 'payment_confirmed', the payload of payment_received: payment_id, amount_agorot, method, status,
--     origin 'automation' while an automation runs). A payment inserted as confirmed starts both kinds of rules; moving
--     failed -> confirmed, or any later change, writes nothing.
--     app.automation_event_matches and app.process_outbox (bodies of 020665) learn the type; the AUT-06 retry decision
--     (app.automation_run_facts, app.automation_event_still_holds, bodies of 020755): the payment is still confirmed.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.automations drop constraint if exists automations_trigger_type_check;
alter table public.automations add constraint automations_trigger_type_check check (trigger_type = any (array[
  'created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'no_activity', 'stuck_in_stage', 'birthday',
  'task_due_soon', 'date_reached', 'payment_received', 'payment_confirmed']));

-- (2) and (4): the notice of a payment received
create or replace function app.notify_payment_received() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_recorder uuid := coalesce(auth.uid(), new.created_by);
  v_owner uuid;
  v_kind text;
  v_entity uuid;
begin
  if new.status not in ('recorded', 'confirmed') then
    return null;
  end if;
  -- the deal's owner, else the contact's, each only while an active member who is not a viewer
  if new.deal_id is not null then
    select d.owner_id into v_owner from public.deals d
      join public.memberships m on m.organization_id = d.organization_id and m.user_id = d.owner_id
                               and m.status = 'active' and m.role <> 'viewer'
     where d.organization_id = new.organization_id and d.id = new.deal_id;
  end if;
  if v_owner is null and new.contact_id is not null then
    select c.owner_id into v_owner from public.contacts c
      join public.memberships m on m.organization_id = c.organization_id and m.user_id = c.owner_id
                               and m.status = 'active' and m.role <> 'viewer'
     where c.organization_id = new.organization_id and c.id = new.contact_id;
    if v_owner is not null then
      v_kind := 'contact';
      v_entity := new.contact_id;
    end if;
  elsif v_owner is not null then
    v_kind := 'deal';
    v_entity := new.deal_id;
  end if;
  if v_owner is not null then
    if v_owner is not distinct from v_recorder then
      return null;
    end if;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (new.organization_id, v_owner, 'payment', 'התקבל תשלום',
            app.payment_amount_text(new.amount_agorot) || ' · ' || app.payment_method_label(new.method),
            v_kind, v_entity);
    return null;
  end if;
  -- no usable owner: the active owners and admins, never the recorder
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select new.organization_id, m.user_id, 'payment', 'התקבל תשלום',
         app.payment_amount_text(new.amount_agorot) || ' · ' || app.payment_method_label(new.method),
         case when new.deal_id is not null then 'deal' else 'contact' end, coalesce(new.deal_id, new.contact_id)
    from public.memberships m
   where m.organization_id = new.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
     and m.user_id is distinct from v_recorder;
  return null;
end;
$$;
revoke all on function app.notify_payment_received() from public, anon, authenticated, service_role;

-- (3): the outbox event of a confirmed payment
create or replace function app.emit_payment_confirmed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if new.status <> 'confirmed' or (tg_op = 'UPDATE' and old.status is distinct from 'recorded') then
    return null;
  end if;
  v_payload := jsonb_build_object('payment_id', new.id, 'amount_agorot', new.amount_agorot, 'method', new.method,
                                  'status', new.status)
               || case when current_setting('app.automation_running', true) = 'on'
                       then jsonb_build_object('origin', 'automation') else '{}'::jsonb end;
  if new.deal_id is not null then
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (new.organization_id, 'payment_confirmed', 'deal', new.deal_id, auth.uid(), v_payload);
  end if;
  if new.contact_id is not null then
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (new.organization_id, 'payment_confirmed', 'contact', new.contact_id, auth.uid(), v_payload);
  end if;
  return null;
end;
$$;
revoke all on function app.emit_payment_confirmed() from public, anon, authenticated, service_role;

create or replace trigger payments_emit_confirmed after insert or update of status on public.payments
  for each row when (new.status = 'confirmed') execute function app.emit_payment_confirmed();

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
    -- PAY-07 (owner, 21 October 2026, answer 3): the payment was confirmed; the same minimum
    when 'payment_confirmed' then p_event.event_type = 'payment_confirmed'
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
             and a.trigger_type in ('created', 'field_changed', 'task_completed', 'deal_won', 'deal_lost', 'payment_received',
                                   'payment_confirmed')
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

create or replace function app.automation_run_facts(p_trigger text, p_config jsonb, p_entity text, p_org uuid, p_id uuid,
                                                    p_run_key text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_record jsonb;
  v_text text;
  v_payment text;
  v_last timestamptz;
begin
  case p_trigger
    when 'created', 'deal_won', 'deal_lost', 'task_completed' then
      return '{}'::jsonb;
    when 'field_changed' then
      v_record := app.automation_record(p_entity, p_org, p_id);
      if v_record is null or (p_config ->> 'field') is null then
        return null;
      end if;
      return jsonb_build_object('value', v_record -> (p_config ->> 'field'));
    when 'no_activity' then
      -- the last activity when the run ends, by the rule of the check below (and of app.scheduled_no_activity), so the
      -- run's own timeline entries (a status or stage change by its steps) count as seen; only later activity ends retries
      if p_entity not in ('lead', 'contact', 'company', 'deal') then
        return null;
      end if;
      execute format(
        'select coalesce((select max(a.occurred_at) from public.activities a
                           where a.organization_id = $1 and a.%I = $2 and a.type <> ''automation_note''),
                         (select t.created_at from public.%I t where t.organization_id = $1 and t.id = $2))',
        p_entity || '_id', app.automation_table(p_entity))
        into v_last using p_org, p_id;
      return case when v_last is not null then jsonb_build_object('last_at', v_last) end;
    when 'stuck_in_stage' then
      v_text := substring(p_run_key from '^stuck:[0-9a-f-]{36}:(.+)$');
      if v_text is null then
        return null;
      end if;
      return (select jsonb_build_object('stage_id', d.stage_id, 'stage_entered_at', v_text::timestamptz)
                from public.deals d where d.organization_id = p_org and d.id = p_id);
    when 'task_due_soon' then
      v_text := substring(p_run_key from '^due:[0-9a-f-]{36}:(.+)$');
      return case when v_text is not null then jsonb_build_object('due_at', v_text::timestamptz) end;
    when 'birthday' then
      return (select jsonb_build_object('birth_date', c.birth_date)
                from public.contacts c where c.organization_id = p_org and c.id = p_id and c.birth_date is not null);
    when 'date_reached' then
      v_text := substring(p_run_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})$');
      return case when v_text is not null then jsonb_build_object('day', v_text::date) end;
    when 'payment_received', 'payment_confirmed' then
      v_text := substring(p_run_key from '^event:([0-9]{1,18})$');
      if v_text is null then
        return null;
      end if;
      -- the outbox event of the run's own type (payment_received or payment_confirmed)
      select e.payload ->> 'payment_id' into v_payment from public.outbox_events e
       where e.organization_id = p_org and e.id = v_text::bigint and e.event_type = p_trigger;
      return case when v_payment is not null then jsonb_build_object('payment_id', v_payment::uuid) end;
    else
      -- a trigger type without a decision: never retried
      return null;
  end case;
exception when others then
  return null;
end;
$$;
revoke all on function app.automation_run_facts(text, jsonb, text, uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function app.automation_event_still_holds(p_trigger text, p_config jsonb, p_entity text, p_org uuid,
                                                            p_id uuid, p_record jsonb, p_facts jsonb) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_field text := p_config ->> 'field';
  v_last timestamptz;
  v_zone text;
  v_type text;
  v_day date;
begin
  if p_facts is null or p_record is null then
    return false;
  end if;
  case p_trigger
    when 'created' then
      return true;
    when 'deal_won' then
      return coalesce(p_record ->> 'status' = 'won', false);
    when 'deal_lost' then
      return coalesce(p_record ->> 'status' = 'lost', false);
    when 'task_completed' then
      return coalesce(p_record ->> 'status' = 'done', false);
    when 'field_changed' then
      if v_field is null then
        return false;
      end if;
      if (p_config ->> 'to') is not null then
        return p_record ->> v_field is not distinct from p_config ->> 'to';
      end if;
      return p_facts ? 'value' and (p_record -> v_field) is not distinct from (p_facts -> 'value');
    when 'no_activity' then
      if p_entity not in ('lead', 'contact', 'company', 'deal')
         or (p_entity = 'lead' and (p_record ->> 'converted_at') is not null)
         or (p_entity = 'deal' and p_record ->> 'status' is distinct from 'open') then
        return false;
      end if;
      execute format(
        'select coalesce((select max(a.occurred_at) from public.activities a
                           where a.organization_id = $1 and a.%I = $2 and a.type <> ''automation_note''),
                         (select t.created_at from public.%I t where t.organization_id = $1 and t.id = $2))',
        p_entity || '_id', app.automation_table(p_entity))
        into v_last using p_org, p_id;
      return coalesce(v_last = (p_facts ->> 'last_at')::timestamptz, false);
    when 'stuck_in_stage' then
      return coalesce(p_entity = 'deal' and p_record ->> 'status' = 'open'
                      and p_record ->> 'stage_id' = p_facts ->> 'stage_id'
                      and (p_record ->> 'stage_entered_at')::timestamptz = (p_facts ->> 'stage_entered_at')::timestamptz, false);
    when 'task_due_soon' then
      return coalesce(p_entity = 'task' and p_record ->> 'status' = 'open'
                      and (p_record ->> 'due_at')::timestamptz = (p_facts ->> 'due_at')::timestamptz, false);
    when 'birthday' then
      return coalesce(p_entity = 'contact' and (p_record ->> 'birth_date')::date = (p_facts ->> 'birth_date')::date, false);
    when 'date_reached' then
      if v_field is null
         or (p_entity = 'lead' and (p_record ->> 'converted_at') is not null)
         or (p_entity = 'deal' and v_field = 'expected_close_date' and p_record ->> 'status' is distinct from 'open')
         or (p_entity = 'task' and v_field = 'due_at' and p_record ->> 'status' is distinct from 'open') then
        return false;
      end if;
      select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
      v_zone := coalesce(v_zone, 'Asia/Jerusalem');
      if v_field like 'cf:%' then
        if p_entity not in ('lead', 'contact', 'company', 'deal') then
          return false;
        end if;
        select f.field_type into v_type from public.field_definitions f
         where f.organization_id = p_org and f.object_type = p_entity and f.key = substr(v_field, 4) and f.is_active
           and f.field_type in ('date', 'datetime');
        if v_type is null then
          return false;
        end if;
        v_day := app.automation_value_day(p_record -> 'custom_fields' ->> substr(v_field, 4), v_type, v_zone);
      elsif v_field = any (app.automation_date_fields(p_entity)) then
        if v_field in ('created_at', 'due_at') then
          v_day := ((p_record ->> v_field)::timestamptz at time zone v_zone)::date;
        else
          v_day := (p_record ->> v_field)::date;
        end if;
      else
        return false;
      end if;
      return coalesce(v_day = (p_facts ->> 'day')::date, false);
    when 'payment_received' then
      return exists (select 1 from public.payments p
                      where p.organization_id = p_org and p.id = (p_facts ->> 'payment_id')::uuid
                        and p.status not in ('cancelled', 'failed', 'refunded'));
    when 'payment_confirmed' then
      -- the payment is still confirmed (not moved back to recorded, failed, refunded or cancelled)
      return exists (select 1 from public.payments p
                      where p.organization_id = p_org and p.id = (p_facts ->> 'payment_id')::uuid and p.status = 'confirmed');
    else
      -- a trigger type without a decision is never retried
      return false;
  end case;
end;
$$;
revoke all on function app.automation_event_still_holds(text, jsonb, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
