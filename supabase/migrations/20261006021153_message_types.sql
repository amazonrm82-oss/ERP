-- =============================================================================
-- CNS-07 / MSG-04: every message has a type; service is a closed list of types; marketing needs a recorded consent
-- =============================================================================
-- Owner 3 November 2026, answer (73) א (DECISIONS.md):
-- * The OPS-04 payload of message.send takes `message_type` from the closed list app.message_types() (app.job_payload_ok);
--   app.enqueue_job requires it (hint job:message_type). Mirrored by MESSAGE_TYPES in
--   src/features/messaging/providers/types.ts (unit test reads this file).
-- * Service is a CLOSED list of types, never a flag a business sets: app.service_message_types() = meeting_reminder,
--   requested_document (a document the customer asked for), collection, verification_code (= SERVICE_MESSAGE_TYPES).
--   Every other type, and a job queued before this migration (no type), is marketing.
-- * The send check (public.job_message_may_send; pinned by test 284, needs a fresh review), after the record and address:
--   - service: refused only when the address is on the business's blocklist (CNS-06, 'listed') or blocked by a privacy
--     erasure ('blocked'): app.consent_service_blocked, the address's business-wide state; an ordinary opt-out from
--     marketing does not stop it. Cannot check (no key, an address not hashed yet) = refused ('consent_unknown').
--   - marketing: app.consent_suppressed as before (opt-out, erasure, blocklist; null = refused), then a recorded grant for
--     the channel, app.consent_granted (the address's business-wide state: the latest entry a grant; none, a cancelled
--     import grant or an awaiting tick = no), else 'consent_missing'.
--   Senders judge by the address across the business, never by a record's card (CLAUDE.md, Blocklist).
-- * The type stays on app.jobs; the message log (public.messages) does not keep it (owner (75) א).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The closed lists
-- ----------------------------------------------------------------------------
create or replace function app.message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code', 'marketing']::text[] $$;
revoke all on function app.message_types() from public, anon, authenticated;

create or replace function app.service_message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code']::text[] $$;
revoke all on function app.service_message_types() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The payload rule and the enqueue
-- ----------------------------------------------------------------------------
create or replace function app.job_payload_ok(p_kind text, p_payload jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then false
    when p_kind = 'message.send' then
      coalesce(
        (select bool_and(k in ('channel', 'lead_id', 'contact_id', 'event_at', 'message_type')) from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
      and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
      and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      -- CNS-07: the message's type, from the closed list (enqueue_job requires it; a job queued before 021147 has none and is
      -- judged as marketing)
      and (not (p_payload ? 'message_type')
           or (jsonb_typeof(p_payload -> 'message_type') = 'string'
               and (p_payload ->> 'message_type') = any (app.message_types())))
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

create or replace function app.enqueue_job(p_org uuid, p_kind text, p_payload jsonb, p_run_at timestamptz default null)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_org is null or p_kind is null or not (p_kind = any (app.job_kinds())) then
    raise exception 'unknown job kind' using errcode = '22023', hint = 'job:kind';
  end if;
  if not app.job_payload_ok(p_kind, p_payload) then
    raise exception 'job payload holds ids and codes only' using errcode = '22023', hint = 'job:payload';
  end if;
  -- CNS-07: every message is classified when it is queued
  if p_kind = 'message.send' and not (p_payload ? 'message_type') then
    raise exception 'a message has a type' using errcode = '22023', hint = 'job:message_type';
  end if;
  if p_payload ? 'event_at' then
    begin
      perform (p_payload ->> 'event_at')::timestamptz;
    exception when others then
      raise exception 'job payload holds ids and codes only' using errcode = '22023', hint = 'job:payload';
    end;
  end if;
  insert into app.jobs (organization_id, kind, payload, next_run_at)
  values (p_org, p_kind, p_payload, greatest(coalesce(p_run_at, now()), now()))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.enqueue_job(uuid, text, jsonb, timestamptz) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The address's business-wide consent, for the two kinds of message
-- ----------------------------------------------------------------------------
-- marketing: is the latest entry for the address and channel a grant? (no entry = false; cannot check = null)
create or replace function app.consent_granted(p_org uuid, p_channel text, p_value text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_value text;
  v_hash text;
begin
  if p_org is null or p_channel is null or p_channel not in ('email', 'sms', 'whatsapp', 'phone') then
    return null;
  end if;
  v_kind := app.consent_address_kind(p_channel);
  v_value := case when v_kind = 'email' then nullif(lower(btrim(p_value)), '') else app.normalize_phone(p_value) end;
  if v_value is null or not app.consent_key_present() then
    return null;
  end if;
  v_hash := app.consent_address_hash(p_org, v_kind, v_value);
  if v_hash is null then
    return null;
  end if;
  -- no entry, or the latest one is not a grant = false
  return coalesce(app.consent_state_of(p_org, p_channel, v_hash, null, null) = 'in', false);
end;
$$;
revoke all on function app.consent_granted(uuid, text, text) from public, anon, authenticated, service_role;

-- service: is the address on the blocklist ('listed') or blocked by a privacy erasure ('blocked')? An ordinary opt-out
-- is not a block here. Cannot check = null: no key, no hash, or an erasure entry of the channel still waiting for its hash
create or replace function app.consent_service_blocked(p_org uuid, p_channel text, p_value text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_value text;
  v_hash text;
begin
  if p_org is null or p_channel is null or p_channel not in ('email', 'sms', 'whatsapp', 'phone') then
    return null;
  end if;
  v_kind := app.consent_address_kind(p_channel);
  v_value := case when v_kind = 'email' then nullif(lower(btrim(p_value)), '') else app.normalize_phone(p_value) end;
  if v_value is null then
    return null;
  end if;
  if not app.consent_key_present() then
    raise warning 'consent hash key (app.settings consent_hash_key) is missing: blocks cannot be checked, nothing is sent';
    return null;
  end if;
  v_hash := app.consent_address_hash(p_org, v_kind, v_value);
  if v_hash is null then
    return null;
  end if;
  if app.consent_state_of(p_org, p_channel, v_hash, null, null) in ('listed', 'blocked') then
    return true;
  end if;
  -- an opt-out still waiting for its hash might be this address's erasure: cannot tell, so cannot send (fail closed, the
  -- rule of app.consent_suppressed)
  if exists (select 1 from public.consents c
              where c.organization_id = p_org and c.channel = p_channel and c.address_hash is null
                and c.hash_version = 1 and c.state in ('withdrawn', 'denied')
                and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)) then
    return null;
  end if;
  return false;
end;
$$;
revoke all on function app.consent_service_blocked(uuid, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The send check: _messages.sql's body with the two rules
-- ----------------------------------------------------------------------------
create or replace function public.job_message_may_send(p_job uuid, p_lease uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs%rowtype;
  v_channel text;
  v_record uuid;
  v_found boolean := false;
  v_email text;
  v_phone text;
  v_address text;
  v_suppressed boolean;
  v_blocked boolean;
  v_reason text;
  v_event_at timestamptz;
  v_paused_at timestamptz;
  v_pause public.org_sending_pauses%rowtype;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.kind <> 'message.send' or v_job.status <> 'running'
     or p_lease is null or v_job.lease_id is distinct from p_lease or not (v_job.locked_until > now()) then
    return jsonb_build_object('may_send', false, 'reason', 'stale');
  end if;

  v_channel := v_job.payload ->> 'channel';
  if v_job.payload ? 'lead_id' then
    v_record := (v_job.payload ->> 'lead_id')::uuid;
    select true, l.email, l.phone into v_found, v_email, v_phone
      from public.leads l
     where l.organization_id = v_job.organization_id and l.id = v_record and l.deleted_at is null;
  else
    v_record := (v_job.payload ->> 'contact_id')::uuid;
    select true, c.email, c.phone into v_found, v_email, v_phone
      from public.contacts c
     where c.organization_id = v_job.organization_id and c.id = v_record and c.deleted_at is null;
  end if;

  if v_job.payload ? 'event_at' then
    begin
      v_event_at := (v_job.payload ->> 'event_at')::timestamptz;
    exception when others then
      v_event_at := '-infinity';
    end;
  end if;

  if not app.org_writable(v_job.organization_id) then
    v_reason := 'business_closed';
  elsif v_event_at is not null and v_event_at < now() then
    v_reason := 'event_passed';
  elsif app.customer_sending_paused(v_job.organization_id) then
    select p.paused_at into v_paused_at from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if coalesce(v_paused_at, now()) < now() - interval '24 hours' then
      v_reason := 'pause_expired';
    else
      -- (52) ג: wait for the business to resume; not refused, the attempt not counted
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = now() + interval '5 minutes', last_error = 'waiting:sending_paused'
       where j.id = p_job;
      -- the business's other message jobs already due wait with it, in one update (no attempt is counted: they were
      -- not claimed), so a paused business does not churn the queue one job at a time. Only jobs already due: a job
      -- due later is marked when its own time comes, so one due after the resume never carries the mark (review)
      update app.jobs j set next_run_at = now() + interval '5 minutes', last_error = 'waiting:sending_paused'
       where j.organization_id = v_job.organization_id and j.kind = 'message.send' and j.id <> p_job
         and j.status in ('queued', 'failed') and j.next_run_at <= now();
      return jsonb_build_object('may_send', false, 'reason', 'sending_paused', 'retry', true);
    end if;
  end if;

  -- (52) ג after the resume: the business's latest pause lasted more than 24 hours and this job waited through it
  -- (it was told to wait, or it was made before the resume and due by its end) = cancelled, even when no check
  -- happened during the pause (worker down, hourly wake). A job made during the pause for a time after the resume
  -- never waited and is sent (review M-1). Only the latest pause is known: a re-pause before an older long pause's
  -- backlog drained forgets it (review L-a, accepted)
  if v_reason is null then
    select * into v_pause from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if found and not v_pause.paused and v_pause.paused_at is not null and v_pause.resumed_at is not null
       and v_pause.resumed_at - v_pause.paused_at > interval '24 hours'
       and (v_job.last_error = 'waiting:sending_paused'
            or (v_job.created_at <= v_pause.resumed_at and v_job.next_run_at <= v_pause.resumed_at)) then
      v_reason := 'pause_expired';
    end if;
  end if;

  if v_reason is not null then
    null;
  elsif not coalesce(v_found, false) then
    v_reason := 'record_gone';
  else
    v_address := nullif(btrim(case when v_channel = 'email' then v_email else v_phone end), '');
    if v_address is null then
      v_reason := 'no_address';
    else
      if (v_job.payload ->> 'message_type') = any (app.service_message_types()) then
        -- CNS-07, owner (73) א: a service message goes after an ordinary opt-out from marketing, never to an address on
        -- the blocklist or blocked by a privacy erasure (the address, business-wide; cannot check = refused)
        v_blocked := app.consent_service_blocked(v_job.organization_id, v_channel, v_address);
        if v_blocked is null then
          v_reason := 'consent_unknown';
        elsif v_blocked then
          v_reason := 'consent_blocked';
        end if;
      else
        -- marketing (every type not in the service list, or none): no opt-out, and a recorded grant for the channel
        v_suppressed := app.consent_suppressed(v_job.organization_id, v_channel, v_address);
        if v_suppressed is null then
          v_reason := 'consent_unknown';
        elsif v_suppressed then
          v_reason := 'consent_suppressed';
        elsif app.consent_granted(v_job.organization_id, v_channel, v_address) is not true then
          v_reason := 'consent_missing';
        end if;
      end if;
    end if;
  end if;

  if v_reason is null then
    -- MSG-03: this lease passed the check; finish_job records the message only for such an attempt
    update app.jobs j set send_checked_lease = p_lease where j.id = p_job;
    return jsonb_build_object('may_send', true);
  end if;
  update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                        last_error = 'refused:' || v_reason
   where j.id = p_job;
  insert into app.job_cancel_counts (organization_id, reason, pending)
  values (v_job.organization_id, v_reason, 1)
  on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + 1;
  return jsonb_build_object('may_send', false, 'reason', v_reason);
end;
$$;
revoke all on function public.job_message_may_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.job_message_may_send(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
