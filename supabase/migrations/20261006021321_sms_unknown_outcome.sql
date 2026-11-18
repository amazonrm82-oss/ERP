-- =============================================================================
-- SMS-05b (live incident of 18 November 2026): a send whose outcome is not known reads 'unknown', not 'failed'
-- =============================================================================
-- The first real SMS through InforU reached the phone (InforU's own report: Delivered), but the adapter's call was cut off
-- at its timeout, so it answered unknown_timeout (final: never sent twice), the job ended dead, and public.messages showed
-- 'failed'. A message that may have reached the provider is not a failure we know of.
--
-- * public.messages.status takes 'unknown' for an outbound message (constraint messages_status re-added NOT VALID, then
--   validated in its own statement, RVW-102).
-- * app.jobs_record_message() (021267's body, pinned by md5 in test 284): a job that ends with message_outcome 'failed', a
--   provider, and a provider error code starting 'unknown_' writes status 'unknown' (sent_at stays empty). One new block;
--   every other line unchanged. app.jobs.message_outcome keeps its closed list (sent | failed): the queue is unchanged.
-- * public.sms_delivery_status() (021248's body, pinned by md5 in test 353): the report also settles a message in 'unknown',
--   found by its job id (InforU's CustomerMessageId is our job id), to delivered or failed. Never backwards: only 'sent',
--   'unknown' and the older 'failed' + unknown_* rows are moved; a delivered or a reported-failed message stays as it is.
-- Rows written before this migration (failed + unknown_*) are NOT rewritten here (a bulk rewrite needs the owner's
-- go-ahead); a later report still settles them by the line kept from 021248.
-- No row is deleted. No statement starts with drop. Every statement is safe to run twice.

alter table public.messages drop constraint if exists messages_status;
alter table public.messages add constraint messages_status check (
  (direction = 'outbound' and status in ('sent', 'delivered', 'read', 'failed', 'unknown'))
  or (direction = 'inbound' and status = 'received')) not valid;
alter table public.messages validate constraint messages_status;

-- 021267's body plus the unknown block (SMS-05b)
create or replace function app.jobs_record_message() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead uuid;
  v_contact uuid;
  v_status text := new.message_outcome;
  v_provider_id text := new.provider_message_id;
begin
  if new.kind <> 'message.send' or v_status is null then
    return null;
  end if;
  -- RVW-80: a sender-verification code (SMS-01b) goes to the business's own phone, never to a lead or a contact: there is
  -- no timeline to show it on (it named no record, so recording it would only fail the one-record check and warn)
  if new.payload ? 'sender_check_id' then
    return null;
  end if;
  -- MSG-02 (103): a message refused for its filled length tells the owners and admins (once per template a day); never
  -- fails the finish. RVW-89: so does a refusal the business can fix (a field left unfilled, a feature switched off, the
  -- outside-link switch, an invalid review link); a consent refusal is about one customer and tells no one
  if v_status = 'failed' and new.provider is null
     and new.provider_error_code in ('too_long', 'unfilled_field', 'feature_off', 'link_blocked', 'link_invalid') then
    begin
      perform app.message_send_refused(new.organization_id,
                                       case when new.payload ? 'template_id' then (new.payload ->> 'template_id')::uuid end,
                                       new.provider_error_code);
    exception when others then
      raise warning 'jobs_record_message: the refusal notice of job % was not written (%)', new.id, sqlstate;
    end;
  end if;
  -- SMS-05b (18 November 2026): a send that may have reached the provider (the adapter's unknown_* codes: a timeout, a
  -- broken connection, a 5xx or an answer it could not read) is neither sent nor failed: the message reads 'unknown' until
  -- the provider's delivery report settles it (public.sms_delivery_status). The job itself still ends dead (never sent twice).
  if v_status = 'failed' and new.provider is not null and new.provider_error_code like 'unknown\_%' then
    v_status := 'unknown';
  end if;
  if new.payload ? 'lead_id' then
    v_lead := (new.payload ->> 'lead_id')::uuid;
  else
    v_contact := (new.payload ->> 'contact_id')::uuid;
  end if;
  for v_try in 1..2 loop
    begin
      insert into public.messages (organization_id, lead_id, contact_id, channel, direction, status, provider,
                                   provider_message_id, provider_error_code, job_id, occurred_at, sent_at)
      values (new.organization_id, v_lead, v_contact, new.payload ->> 'channel', 'outbound', v_status, new.provider,
              v_provider_id, new.provider_error_code, new.id, now(), case when v_status = 'sent' then now() end)
      on conflict (job_id) do update
        set status = excluded.status, provider = excluded.provider, provider_message_id = excluded.provider_message_id,
            provider_error_code = excluded.provider_error_code, occurred_at = excluded.occurred_at, sent_at = excluded.sent_at;
      return null;
    exception
      -- the lead or contact was purged since the send check: there is no timeline to show it on
      when foreign_key_violation then
        return null;
      -- another message of this business already holds the provider's id: kept without it
      when unique_violation then
        if v_provider_id is null then
          return null;
        end if;
        v_provider_id := null;
      -- recording never fails the finish (a refused finish would send the message again): one warning, the job id only
      when others then
        raise warning 'jobs_record_message: the message of job % was not recorded (%)', new.id, sqlstate;
        return null;
    end;
  end loop;
  return null;
end;
$$;
revoke all on function app.jobs_record_message() from public, anon, authenticated, service_role;

-- 021248's body plus the 'unknown' line (SMS-05b)
create or replace function public.sms_delivery_status(p_provider text, p_items jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
  v_delivered integer := 0;
  v_failed integer := 0;
  v_pending integer := 0;
begin
  if p_provider is distinct from 'inforu' then
    return jsonb_build_object('refused', 'provider');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    return jsonb_build_object('refused', 'items');
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n = 0 then
    return jsonb_build_object('delivered', 0, 'failed', 0, 'pending', 0);
  end if;
  if not app.sms_callback_take('status', v_n, 20000) then
    return jsonb_build_object('rate_limited', true);
  end if;
  with items as (
    select distinct on (x ->> 'id') x ->> 'id' as id, x ->> 'status' as status,
           case when (x ->> 'code') ~ '^[A-Za-z0-9_.:-]{1,64}$' then x ->> 'code' end as code,
           -- final review (1): cast only an id of uuid shape, so another id never makes the batch raise
           case when (x ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (x ->> 'id')::uuid end as job_uuid
      from jsonb_array_elements(p_items) x
     where jsonb_typeof(x) = 'object' and (x ->> 'id') ~ '^[!-~]{1,200}$' and (x ->> 'status') in ('delivered', 'failed')
     order by x ->> 'id', case when x ->> 'status' = 'delivered' then 0 else 1 end
  ),
  done as (
    update public.messages m
       set status = i.status,
           delivered_at = case when i.status = 'delivered' then now() else m.delivered_at end,
           -- final review (2): a message settled from unknown_* as delivered was sent
           sent_at = case when i.status = 'delivered' then coalesce(m.sent_at, now()) else m.sent_at end,
           provider_error_code = case when i.status = 'failed' then coalesce(i.code, 'undelivered') else null end,
           -- delta review (1): a message that ended "unknown" (it may have gone out) gets its provider id now
           provider_message_id = i.id,
           updated_at = now()
      from items i
     where m.provider = p_provider and m.channel = 'sms' and m.direction = 'outbound'
       and ((m.status = 'sent' and m.provider_message_id = i.id)
            -- delta review (1): the job ended "unknown_*" (timeout, broken connection, 5xx, unreadable answer), so
            -- finish_job kept no provider id; InforU's id IS the job id, found by public.messages.job_id
            or (m.status = 'failed' and m.provider_error_code like 'unknown\_%' and m.job_id = i.job_uuid)
            -- SMS-05b: since 021321 such a message reads 'unknown' (the line above keeps the rows written before it)
            or (m.status = 'unknown' and m.job_id = i.job_uuid))
    returning m.status
  )
  select count(*) filter (where status = 'delivered'), count(*) filter (where status = 'failed') into v_delivered, v_failed from done;
  -- review (6): a report for a message.send job whose public.messages row is not written yet (its finish is still to come)
  select count(*) into v_pending
    from (select distinct x ->> 'id' as id from jsonb_array_elements(p_items) x
           where jsonb_typeof(x) = 'object'
             and (x ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') i
   where exists (select 1 from app.jobs j
                  where j.id = i.id::uuid and j.kind = 'message.send'
                    -- delta review (1): only a job still in the queue or one that just finished; never for ever
                    and (j.status in ('queued', 'running', 'failed') or j.finished_at > now() - interval '15 minutes'))
     and not exists (select 1 from public.messages m where m.job_id = i.id::uuid);
  return jsonb_build_object('delivered', v_delivered, 'failed', v_failed, 'pending', v_pending);
end;
$$;
revoke all on function public.sms_delivery_status(text, jsonb) from public, anon, authenticated;
grant execute on function public.sms_delivery_status(text, jsonb) to service_role;
