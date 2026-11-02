-- =============================================================================
-- OPS-04: a background job queue in the database, with a worker the database wakes
-- =============================================================================
-- Owner's answer (26 October 2026, DECISIONS.md "OPS-04"): (א) a queue inside the database and a worker the
-- database wakes through a route on our server, like the push dispatcher. The worker that sends queued
-- messages through a provider is the approved wave 3 service-key use (1) (CLAUDE.md hard rule 5).
-- * app.jobs (schema app, RLS on, no grants): kind from a closed list (app.job_kinds(); this round only
--   'message.send'), organization (cascade), payload jsonb holding ids and codes only, never personal text
--   (constraint jobs_payload_ok, app.job_payload_ok), status queued | running | done | failed | dead | refused,
--   attempts, next_run_at, the lease (lease_id, locked_until), last_error (redacted by app.job_error_redact).
--   failed = an attempt failed and the job waits for its next try at next_run_at; dead = no more tries;
--   refused = the send check said no (HEB-09 pause, consent, closed business, gone record, no address) and the
--   job never runs again.
-- * app.enqueue_job(org, kind, payload, run_at) (definer, no grants for any API role): server-side SQL enqueues.
-- * public.claim_jobs(kinds, limit, lease_seconds) (service_role only): fair per business (each business's
--   earliest due job first, then each one's second, ...), FOR UPDATE SKIP LOCKED, a lease per claim, a job whose
--   lease ran out is claimable again and a lease that ran out on the last try makes it dead.
-- * public.finish_job(job, lease, ok, error, final, started) (service_role only): only the holder of a LIVE
--   lease (the lease id and locked_until > now()) finishes; anything else answers 'stale' and changes nothing.
--   A failure waits app.job_backoff(attempts) (1, 4, 16, 64 minutes, at most 6 hours) and is dead after
--   app.job_max_attempts() tries (5) or when final. started = false hands a claimed job back untried: queued
--   again at once, the attempt not counted ('released').
-- * public.job_message_may_send(job, lease) (service_role only): the ONE check of the send handler; a lease that
--   is not live answers 'stale' and changes nothing, so an old holder never gets "yes" after a reclaim. It answers
--   {may_send} or {may_send: false, reason} and never returns an address or a name; a refusal also ends the job
--   ('refused', last_error 'refused:<reason>') in the same transaction, so nothing is sent for it later.
--   Owner's answers 52-55 (DECISIONS.md "תור העבודות ושליחת הודעות ללקוחות", 2 November 2026):
--   (53) א, (54) ב: a business that cannot write (app.org_writable: soft-deleted, suspended, cancelled or
--   read-only, the rule app.send_meeting_reminders skips by) sends nothing: 'business_closed', cancelled at once.
--   An optional payload `event_at` (the meeting, the due date) whose time has passed: 'event_passed', cancelled.
--   (52) ג: while the business paused sending (HEB-09 app.customer_sending_paused) the job WAITS: the answer is
--   {may_send: false, reason: 'sending_paused', retry: true}, the job goes back to 'queued' 5 minutes later and
--   the attempt is not counted; once the pause has lasted more than 24 hours (org_sending_pauses.paused_at) it is
--   cancelled: 'pause_expired'. The business's other message jobs due within the 5 minutes are moved with it in one
--   update. After the resume, a job that waited through a pause of more than 24 hours (marked waiting, made during
--   it, or made before it and due by its end) is cancelled as 'pause_expired' too, even if it was never checked
--   during the pause. Then app.consent_suppressed (null = cannot check = refused).
--   Every cancellation is counted in app.job_cancel_counts (per business and reason, no job ids) and written to
--   app.platform_log by app.flush_job_cancellations (each crm-jobs-wake run) as ONE entry per business:
--   action 'jobs.cancelled', details {counts: {reason: n}, total}; never one entry per job, no personal data.
--   (55) א: only this function reads customer records, and it answers may_send, reason and retry only.
-- * app.wake_job_worker(): pg_cron 'crm-jobs-wake' every minute wakes /api/jobs/run through pg_net when queued
--   work is due, with the push dispatcher's shared secret. Only for a kind a worker asked for in the last day
--   (app.job_kind_seen.last_claimed_at, stamped by claim_jobs), or at most once an hour per kind otherwise
--   (last_woken_at): a kind with no ready handler (no provider configured) wakes the route hourly, not every
--   minute, and a kind that becomes ready is picked up within the hour (app.job_wake_kinds). The URL is app.settings 'jobs_run_url', or derived
--   from 'push_dispatch_url'. The owner fills app.settings; this migration writes none.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Rules (pure)
-- ----------------------------------------------------------------------------
create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

-- A payload holds ids and codes only. message.send: {channel: email|sms|whatsapp} and exactly one of lead_id /
-- contact_id (a lower-case uuid), and optionally event_at (the time the message is about, ISO 8601 with a zone,
-- owner (52) ג); no other key.
-- Adding a job kind needs the owner's approval and its own "In use" line in CLAUDE.md (owner (55) א; test 284).
create or replace function app.job_payload_ok(p_kind text, p_payload jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then false
    when p_kind = 'message.send' then
      coalesce(
        (select bool_and(k in ('channel', 'lead_id', 'contact_id', 'event_at')) from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
      and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
      and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

create or replace function app.job_max_attempts() returns integer
language sql immutable
set search_path = ''
as $$ select 5 $$;
revoke all on function app.job_max_attempts() from public, anon, authenticated;

-- the wait after the n-th failed try: 1, 4, 16, 64 minutes ..., at most 6 hours
create or replace function app.job_backoff(p_attempts integer) returns interval
language sql immutable
set search_path = ''
as $$
  select least(interval '1 minute' * power(4, least(greatest(coalesce(p_attempts, 1), 1), 10) - 1), interval '6 hours')
$$;
revoke all on function app.job_backoff(integer) from public, anon, authenticated;

-- an error kept on a job: no email address, no run of 6+ digits (phones, ids of cards), 300 characters
create or replace function app.job_error_redact(p_error text) returns text
language sql immutable
set search_path = ''
as $$
  select nullif(left(
    regexp_replace(
      regexp_replace(btrim(coalesce(p_error, '')), '[^[:space:]<>"'',;:]+@[^[:space:]<>"'',;:]+', '[email]', 'g'),
      '[+]?[0-9][0-9 ()-]{4,}[0-9]', '[number]', 'g'),
    300), '')
$$;
revoke all on function app.job_error_redact(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The queue
-- ----------------------------------------------------------------------------
create table if not exists app.jobs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  kind             text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued',
  attempts         integer not null default 0,
  next_run_at      timestamptz not null default now(),
  lease_id         uuid,
  locked_until     timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  constraint jobs_kind_known check (kind = any (app.job_kinds())),
  constraint jobs_status_known check (status in ('queued', 'running', 'done', 'failed', 'dead', 'refused')),
  constraint jobs_payload_ok check (app.job_payload_ok(kind, payload)),
  constraint jobs_attempts_range check (attempts >= 0),
  constraint jobs_lease_shape check ((status = 'running') = (lease_id is not null and locked_until is not null)),
  constraint jobs_error_length check (last_error is null or char_length(last_error) <= 300)
);

comment on table app.jobs is
  'OPS-04: background jobs (ids only in payload); claimed by the worker route /api/jobs/run through public.claim_jobs';

alter table app.jobs enable row level security;
revoke all on app.jobs from public, anon, authenticated, service_role;

create index if not exists jobs_due_idx on app.jobs (next_run_at) where status in ('queued', 'failed');
-- full, so it also covers the organization foreign key (test 130); claim_jobs reads each business's due jobs through it
create index if not exists jobs_org_idx on app.jobs (organization_id, next_run_at);
create index if not exists jobs_lease_idx on app.jobs (locked_until) where status = 'running';

-- per kind: when a worker last asked for it (claim_jobs) and when the database last woke the worker for it
create table if not exists app.job_kind_seen (
  kind             text primary key,
  last_claimed_at  timestamptz,
  last_woken_at    timestamptz,
  constraint job_kind_seen_known check (kind = any (app.job_kinds()))
);
alter table app.job_kind_seen enable row level security;
revoke all on app.job_kind_seen from public, anon, authenticated, service_role;
-- one row per known kind, made here (a new kind adds its row in its migration), so claims only update
insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- cancelled message jobs waiting to be counted in app.platform_log (owner (52)-(54): counts only, per business)
create table if not exists app.job_cancel_counts (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  reason           text not null,
  pending          integer not null default 0 check (pending >= 0),
  primary key (organization_id, reason)
);
alter table app.job_cancel_counts enable row level security;
revoke all on app.job_cancel_counts from public, anon, authenticated, service_role;

-- one platform_log entry per business with what was cancelled since the last flush; the counters go back to 0
create or replace function app.flush_job_cancellations() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entries integer;
begin
  with taken as (
    select c.organization_id, c.reason, c.pending
      from app.job_cancel_counts c
     where c.pending > 0
     for update skip locked
  ), zeroed as (
    update app.job_cancel_counts c set pending = 0
      from taken t
     where c.organization_id = t.organization_id and c.reason = t.reason
    returning t.organization_id, t.reason, t.pending
  ), logged as (
    insert into app.platform_log (actor_id, action, organization_id, details)
    select null, 'jobs.cancelled', z.organization_id,
           jsonb_build_object('counts', jsonb_object_agg(z.reason, z.pending), 'total', sum(z.pending))
      from zeroed z
     group by z.organization_id
    returning 1
  )
  select count(*) into v_entries from logged;
  return v_entries;
end;
$$;
revoke all on function app.flush_job_cancellations() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Enqueue (server-side SQL only)
-- ----------------------------------------------------------------------------
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
-- Claim: fair per business, skip locked, a lease per job
-- ----------------------------------------------------------------------------
create or replace function public.claim_jobs(p_kinds text[], p_limit integer default 20, p_lease_seconds integer default 120)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
  v_result jsonb;
begin
  if p_kinds is null or cardinality(p_kinds) = 0 then
    return '[]'::jsonb;
  end if;

  -- a worker asked for these kinds now (app.job_wake_kinds wakes it every minute for them); at most once a minute
  -- per kind, and never waiting on another worker's open claim (skip locked)
  update app.job_kind_seen s set last_claimed_at = now()
   where s.kind in (select x.kind from app.job_kind_seen x
                     where x.kind = any (p_kinds)
                       and (x.last_claimed_at is null or x.last_claimed_at < now() - interval '1 minute')
                     for update skip locked);

  -- a lease that ran out on the last try: the job is dead
  update app.jobs j
     set status = 'dead', lease_id = null, locked_until = null, finished_at = now(),
         last_error = 'lease expired'
   where j.id in (select x.id from app.jobs x
                   where x.status = 'running' and x.locked_until < now()
                     and x.attempts >= app.job_max_attempts() and x.kind = any (p_kinds)
                   for update skip locked);

  with orgs as (
    select j.organization_id, min(j.next_run_at) as first_at
      from app.jobs j
     where j.kind = any (p_kinds)
       and ((j.status in ('queued', 'failed') and j.next_run_at <= now())
            or (j.status = 'running' and j.locked_until < now()))
       -- never past the last try (review L-b): such a job never takes a place another business's or job's turn needs
       and j.attempts < app.job_max_attempts()
     group by j.organization_id
     order by first_at
     limit 500
  ), cand as (
    select c.id, c.rn, c.next_run_at
      from orgs o
      cross join lateral (
        select j.id, j.next_run_at, row_number() over (order by j.next_run_at, j.id) as rn
          from app.jobs j
         where j.organization_id = o.organization_id
           and j.kind = any (p_kinds)
           and ((j.status in ('queued', 'failed') and j.next_run_at <= now())
                or (j.status = 'running' and j.locked_until < now()))
           and j.attempts < app.job_max_attempts()
         order by j.next_run_at, j.id
         limit v_limit
      ) c
  ), picked as (
    select j.id, c.rn, c.next_run_at as due_at
      from app.jobs j
      join cand c on c.id = j.id
     where ((j.status in ('queued', 'failed') and j.next_run_at <= now())
            or (j.status = 'running' and j.locked_until < now()))
       -- never past the last try: a job the dead-on-last-try update skipped (locked) waits for the next claim
       and j.attempts < app.job_max_attempts()
     order by c.rn, c.next_run_at, c.id
     limit v_limit
     for update of j skip locked
  ), claimed as (
    update app.jobs j
       set status = 'running', attempts = j.attempts + 1, lease_id = gen_random_uuid(),
           locked_until = now() + v_lease, started_at = now()
      from picked p
     where j.id = p.id
    returning j.id, j.lease_id, j.kind, j.organization_id, j.payload, j.attempts, p.rn, p.due_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'lease', c.lease_id, 'kind', c.kind, 'organization_id', c.organization_id,
           'payload', c.payload, 'attempt', c.attempts) order by c.rn, c.due_at, c.id), '[]'::jsonb)
    into v_result
    from claimed c;
  return v_result;
end;
$$;
revoke all on function public.claim_jobs(text[], integer, integer) from public, anon, authenticated;
grant execute on function public.claim_jobs(text[], integer, integer) to service_role;

-- ----------------------------------------------------------------------------
-- Finish: only the live lease; backoff; dead after the last try
-- ----------------------------------------------------------------------------
create or replace function public.finish_job(p_job uuid, p_lease uuid, p_ok boolean, p_error text default null,
                                             p_final boolean default false, p_started boolean default true)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs%rowtype;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.status <> 'running' or p_lease is null or v_job.lease_id is distinct from p_lease
     or not (v_job.locked_until > now()) then
    return 'stale';
  end if;
  if not coalesce(p_started, true) then
    -- claimed but never started: back to the queue at once, the attempt not counted
    update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null
     where j.id = p_job;
    return 'released';
  end if;
  if coalesce(p_ok, false) then
    update app.jobs j set status = 'done', lease_id = null, locked_until = null, finished_at = now(), last_error = null
     where j.id = p_job;
    return 'done';
  end if;
  if coalesce(p_final, false) or v_job.attempts >= app.job_max_attempts() then
    update app.jobs j set status = 'dead', lease_id = null, locked_until = null, finished_at = now(),
                          last_error = coalesce(app.job_error_redact(p_error), 'failed')
     where j.id = p_job;
    return 'dead';
  end if;
  update app.jobs j set status = 'failed', lease_id = null, locked_until = null,
                        next_run_at = now() + app.job_backoff(v_job.attempts),
                        last_error = coalesce(app.job_error_redact(p_error), 'failed')
   where j.id = p_job;
  return 'failed';
end;
$$;
revoke all on function public.finish_job(uuid, uuid, boolean, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.finish_job(uuid, uuid, boolean, text, boolean, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- The send check: may this message.send job go out now? (no personal data in the answer)
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
      v_suppressed := app.consent_suppressed(v_job.organization_id, v_channel, v_address);
      if v_suppressed is null then
        v_reason := 'consent_unknown';
      elsif v_suppressed then
        v_reason := 'consent_suppressed';
      end if;
    end if;
  end if;

  if v_reason is null then
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

-- ----------------------------------------------------------------------------
-- Waking the worker
-- ----------------------------------------------------------------------------
-- the kinds to wake the worker for now: due work of a kind a worker asked for in the last day, or of any kind
-- whose last wake was more than an hour ago (or never)
create or replace function app.job_wake_kinds() returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(d.kind order by d.kind), '{}'::text[])
    from (select distinct j.kind from app.jobs j
           where (j.status in ('queued', 'failed') and j.next_run_at <= now())
              or (j.status = 'running' and j.locked_until < now())) d
    left join app.job_kind_seen s on s.kind = d.kind
   where s.last_claimed_at > now() - interval '1 day'
      or s.last_woken_at is null or s.last_woken_at <= now() - interval '1 hour'
$$;
revoke all on function app.job_wake_kinds() from public, anon, authenticated;

create or replace function app.wake_job_worker() returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url text := coalesce(
    nullif((select s.value from app.settings s where s.key = 'jobs_run_url'), ''),
    replace(nullif((select s.value from app.settings s where s.key = 'push_dispatch_url'), ''), '/api/push/dispatch', '/api/jobs/run'));
  v_secret text := nullif((select s.value from app.settings s where s.key = 'push_dispatch_secret'), '');
  v_kinds text[];
begin
  perform app.flush_job_cancellations();
  if v_url is null or v_secret is null or not exists (select 1 from pg_extension where extname = 'pg_net') then
    return false;
  end if;
  v_kinds := app.job_wake_kinds();
  if cardinality(v_kinds) = 0 then
    return false;
  end if;
  update app.job_kind_seen s set last_woken_at = now() where s.kind = any (v_kinds);
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
    using v_url, jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return true;
end;
$$;
revoke all on function app.wake_job_worker() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-jobs-wake', '* * * * *', 'select app.wake_job_worker();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
