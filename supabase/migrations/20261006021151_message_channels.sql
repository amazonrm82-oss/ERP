-- =============================================================================
-- MSG-01: a provider per channel; a message of a channel without a provider waits, unclaimed and uncounted
-- =============================================================================
-- The worker picks a provider per channel (MESSAGING_PROVIDER_EMAIL / _SMS / _WHATSAPP, else MESSAGING_PROVIDER;
-- src/features/messaging/providers/select.ts). public.claim_jobs takes an optional p_channels (the channels the worker
-- has a provider for): a message.send job of another channel is not claimed, so its attempts are never spent and it is
-- sent once that channel gets a provider (OPS-04's "an unconfigured provider waits", per channel). null = every channel
-- (the live site's three arguments still reach it). Nothing else changes; the body is pinned by test 284 (fresh review).
-- The three-argument claim_jobs is renamed to app.claim_jobs_021145_retired and loses every grant (the 0180 pattern).
-- Accepted: while due jobs of an unconfigured channel wait and another channel is configured, app.job_wake_kinds wakes the
-- worker every minute (the kind was claimed in the last day) and the claim finds nothing for them.
-- Every statement is safe to run twice.

-- is this job's channel one the worker asked for? (other kinds, or no list, always)
create or replace function app.job_channel_asked(p_kind text, p_payload jsonb, p_channels text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_channels is null or p_kind <> 'message.send' or coalesce((p_payload ->> 'channel') = any (p_channels), false)
$$;
revoke all on function app.job_channel_asked(text, jsonb, text[]) from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.claim_jobs(text[], integer, integer)') is not null then
    alter function public.claim_jobs(text[], integer, integer) rename to claim_jobs_021145_retired;
    alter function public.claim_jobs_021145_retired(text[], integer, integer) set schema app;
    revoke all on function app.claim_jobs_021145_retired(text[], integer, integer) from public, anon, authenticated, service_role;
  end if;
end;
$$;

create or replace function public.claim_jobs(p_kinds text[], p_limit integer default 20, p_lease_seconds integer default 120,
                                             p_channels text[] default null)
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
                     and app.job_channel_asked(x.kind, x.payload, p_channels)
                   for update skip locked);

  with orgs as (
    select j.organization_id, min(j.next_run_at) as first_at
      from app.jobs j
     where j.kind = any (p_kinds)
       and ((j.status in ('queued', 'failed') and j.next_run_at <= now())
            or (j.status = 'running' and j.locked_until < now()))
       -- never past the last try (review L-b): such a job never takes a place another business's or job's turn needs
       and j.attempts < app.job_max_attempts()
       -- MSG-01: a message of a channel the worker has no provider for is not claimed; it waits, uncounted
       and app.job_channel_asked(j.kind, j.payload, p_channels)
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
           and app.job_channel_asked(j.kind, j.payload, p_channels)
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
       and app.job_channel_asked(j.kind, j.payload, p_channels)
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
revoke all on function public.claim_jobs(text[], integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_jobs(text[], integer, integer, text[]) to service_role;

notify pgrst, 'reload schema';
