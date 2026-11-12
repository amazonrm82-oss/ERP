-- =============================================================================
-- SMS-05 (owner's answer (318) א, 12 November 2026): InforU's two callbacks, wave 3 use (2), one definer function each
-- =============================================================================
-- InforU (one Mexuz platform account) posts to our routes (src/features/inforu-callbacks/webhook-server.ts):
--   /api/sms/inforu/status/<secret>   delivery reports (DeliveryNotificationUrl, sent with every message)
--   /api/sms/inforu/inbound/<secret>  replies to the platform's number (set up by InforU's support)
-- InforU does not sign either callback (its documentation names none), so the secret is a long random path segment
-- (INFORU_WEBHOOK_SECRET, set by the owner in Vercel), compared timing-safe BEFORE any database call; a wrong or missing
-- secret is refused without reading or logging the body. Then each route calls ONE service_role function:
--
-- * public.sms_delivery_status(p_provider text, p_items jsonb) returns jsonb: items [{id, status: delivered|failed, code?}]
--   (at most 500 a call). It updates ONLY public.messages rows of that provider (closed list: 'inforu') whose
--   provider_message_id is the item's id, outbound SMS still 'sent': delivered -> status 'delivered' + delivered_at;
--   failed -> 'failed' + the short code. Never backwards (a delivered message stays delivered), never another column.
--   Answers counts only: {delivered, failed, pending}. pending = items whose id is a message.send job still queued,
--   running or waiting to retry, or finished in the last 15 minutes, with no public.messages row of that job yet (the
--   report came before the job's finish wrote it): the route answers 503 so InforU posts it again (review (6)); a job
--   older than that is never pending, so a report never earns a 503 for ever (delta review (1)). A message whose job
--   ended "unknown_*" (it may have been sent; finish_job keeps no provider id on a failure) is found by its job_id, which
--   is InforU's id, and settled by the report: delivered, or failed with InforU's code, its provider id written then. 20,000 items a minute in total (app.sms_callback_counts), then {rate_limited: true}.
-- * public.sms_inbound_reply(p_provider text, p_phone text, p_body text) returns jsonb: an opt-out reply only
--   (app.sms_optout_reply, the whole message, SMS-03) is judged; anything else answers 'ignored' and reads nothing. The
--   replies come to ONE platform number, so the business is not named by the reply: it goes to EVERY business that sent an
--   SMS through this provider in the last 90 days to a lead or contact holding that number now, in pages of 100 within the
--   call (review (4): none is dropped), each through the existing public.sms_inbound_optout (blocklist + withdrawn consent,
--   idempotent, its own 600 a minute per business). An opt-out to every business that recently wrote to the number is the
--   safe side (lead's choice, question for the owner). Limits (review (5)), before anything is read: 5 opt-out replies per
--   number in 10 minutes (app.sms_inbound_number_counts, 65,536 buckets of an HMAC of the number with consent_hash_key, an
--   unkeyed hash without the key, no number kept), then
--   1,200 a minute in total; over either = {rate_limited: true, scope}; a business at its own limit is counted in
--   'limited'. The route answers 503 on any limit, so InforU posts it again; a repeat changes nothing already written.
--   Answers counts only.
-- No row is deleted here. No statement starts with drop. Every statement is safe to run twice.

-- the delivery report finds its message by the provider's id alone (InforU does not name the business)
create index if not exists messages_provider_message_idx on public.messages (provider, provider_message_id)
  where provider_message_id is not null;

create table if not exists app.sms_callback_counts (
  kind    text primary key check (kind in ('status', 'inbound')),
  minute  timestamptz not null,
  n       integer not null
);
alter table app.sms_callback_counts enable row level security;
revoke all on app.sms_callback_counts from public, anon, authenticated, service_role;

-- review (5): one number's opt-out replies, by bucket only (never the number)
create table if not exists app.sms_inbound_number_counts (
  bucket        integer primary key check (bucket between 0 and 65535),
  window_start  timestamptz not null,
  n             integer not null
);
alter table app.sms_inbound_number_counts enable row level security;
revoke all on app.sms_inbound_number_counts from public, anon, authenticated, service_role;

-- counts p_n in this minute for the kind; false once over the cap
create or replace function app.sms_callback_take(p_kind text, p_n integer, p_cap integer) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_n integer;
begin
  insert into app.sms_callback_counts as c (kind, minute, n) values (p_kind, v_minute, p_n)
  on conflict (kind) do update
    set minute = excluded.minute, n = case when c.minute = excluded.minute then c.n + excluded.n else excluded.n end
  returning n into v_n;
  return v_n <= p_cap;
end;
$$;
revoke all on function app.sms_callback_take(text, integer, integer) from public, anon, authenticated, service_role;

-- counts one reply of the number in its 10-minute window; false once over the cap
create or replace function app.sms_inbound_number_take(p_phone text, p_cap integer) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / 600) * 600);
  v_key text;
  v_bucket integer;
  v_n integer;
begin
  -- delta review (5): the bucket is an HMAC of the number with consent_hash_key, like the other address buckets, so
  -- nobody can tell which numbers share one; without the key, an unkeyed hash (the limit still holds, warned once a call)
  select nullif(s.value, '') into v_key from app.settings s where s.key = 'consent_hash_key';
  if v_key is null then
    raise warning 'consent hash key (app.settings consent_hash_key) is missing: the SMS reply limit uses an unkeyed bucket';
    v_bucket := (abs(hashtextextended('sms_inbound:' || p_phone, 0)) % 65536)::integer;
  else
    v_bucket := (abs(('x' || left(encode(extensions.hmac(convert_to('sms_inbound:' || p_phone, 'UTF8'),
                                                           convert_to(v_key, 'UTF8'), 'sha256'), 'hex'), 8))::bit(32)::bigint)
                 % 65536)::integer;
  end if;
  insert into app.sms_inbound_number_counts as c (bucket, window_start, n) values (v_bucket, v_window, 1)
  on conflict (bucket) do update
    set window_start = excluded.window_start, n = case when c.window_start = excluded.window_start then c.n + 1 else 1 end
  returning n into v_n;
  return v_n <= p_cap;
end;
$$;
revoke all on function app.sms_inbound_number_take(text, integer) from public, anon, authenticated, service_role;

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
            or (m.status = 'failed' and m.provider_error_code like 'unknown\_%' and m.job_id = i.job_uuid))
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

create or replace function public.sms_inbound_reply(p_provider text, p_phone text, p_body text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_org uuid;
  v_last uuid := null;
  v_batch integer;
  v_answer jsonb;
  v_businesses integer := 0;
  v_done integer := 0;
  v_limited integer := 0;
begin
  if p_provider is distinct from 'inforu' then
    return jsonb_build_object('refused', 'provider');
  end if;
  -- only an opt-out reply is judged; an ordinary reply reads nothing and counts nothing
  if not app.sms_optout_reply(p_body) then
    return jsonb_build_object('status', 'ignored');
  end if;
  v_phone := app.normalize_phone(p_phone);
  if v_phone is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- review (5): one number first, so it cannot use up the total
  if not app.sms_inbound_number_take(v_phone, 5) then
    return jsonb_build_object('rate_limited', true, 'scope', 'number');
  end if;
  if not app.sms_callback_take('inbound', 1, 1200) then
    return jsonb_build_object('rate_limited', true, 'scope', 'all');
  end if;
  -- review (4): every business, in pages of 100 by id, through the (organization_id, phone_e164) indexes, then the
  -- record's own messages (its index)
  loop
    v_batch := 0;
    for v_org in
      select o.id
        from public.organizations o
       where o.deleted_at is null and (v_last is null or o.id > v_last)
         and (exists (select 1 from public.leads l
                       where l.organization_id = o.id and l.phone_e164 = v_phone
                         and exists (select 1 from public.messages m
                                      where m.organization_id = o.id and m.lead_id = l.id and m.provider = p_provider
                                        and m.channel = 'sms' and m.direction = 'outbound'
                                        and m.occurred_at > now() - interval '90 days'))
              or exists (select 1 from public.contacts c
                          where c.organization_id = o.id and c.phone_e164 = v_phone
                            and exists (select 1 from public.messages m
                                         where m.organization_id = o.id and m.contact_id = c.id and m.provider = p_provider
                                           and m.channel = 'sms' and m.direction = 'outbound'
                                           and m.occurred_at > now() - interval '90 days')))
       order by o.id
       limit 100
    loop
      v_batch := v_batch + 1;
      v_last := v_org;
      v_businesses := v_businesses + 1;
      v_answer := public.sms_inbound_optout(v_org, v_phone, p_body);
      if (v_answer ->> 'status') = 'rate_limited' or coalesce((v_answer ->> 'rate_limited')::boolean, false) then
        v_limited := v_limited + 1;
      elsif (v_answer ->> 'status') is distinct from 'ignored' then
        v_done := v_done + 1;
      end if;
    end loop;
    exit when v_batch < 100;
  end loop;
  return jsonb_build_object('status', case when v_businesses = 0 then 'no_business' else 'done' end,
                            'businesses', v_businesses, 'opted_out', v_done, 'limited', v_limited);
end;
$$;
revoke all on function public.sms_inbound_reply(text, text, text) from public, anon, authenticated;
grant execute on function public.sms_inbound_reply(text, text, text) to service_role;
