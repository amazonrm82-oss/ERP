-- =============================================================================
-- "תודיעו לי כשנפתח" on the landing page (LND-13, built with LND-20 v2)
-- =============================================================================
-- Owner, 13 October 2026 (CLAUDE.md hard rule 5, the landing page "notify me"): an anonymous visitor leaves an email
-- address to hear when a coming-soon plan opens. The approved pattern for an anonymous write:
-- * ONE security definer function granted to service_role only, public.landing_waitlist_submit(), called by the route
--   POST /api/forms/plan-notify (src/features/landing/waitlist-server.ts); no direct table access for any API role.
-- * It stores only the email (trimmed, lower case), the plan, the consent (an unticked box the visitor ticks; the
--   wording is a DRAFT, its version is stored) and the date, in app.landing_waitlist (schema app, RLS on, no grants).
-- * The plan comes from the closed list of coming-soon plans (public.plans.availability = 'coming_soon' right now).
-- * One row per email and plan; the visitor gets the same answer {status:'received'} whether the row is new or not.
-- * FXS-11 rate limit: the server's keyed IP hash (scope `waitlist`) is turned into one of 1,024 bucket numbers and
--   only the bucket is kept (app.landing_waitlist_counts): 5 tries per sender in 10 minutes, then {rate_limited:true}.
--   No hash, address, cookie or visitor id is stored. An IPv6 sender is counted by its /64 (publicSenderAddress, as
--   OPS-02 and PRK-02). Without a hash (no INTAKE_IP_HASH_SECRET, or no client address) nothing is stored: the route
--   refuses first and the function answers {rate_limited:true} too (fail closed; the notify form is not essential).
-- * A system-wide cap on stored rows (review of 12 November 2026): at most 200 new rows an hour and 1,000 a day across
--   all senders (app.landing_waitlist_totals, two counter rows, no address), then {rate_limited:true} for everyone.
-- * The honeypot field is checked by the route BEFORE the database: a hit is answered like a success and stored nowhere.
-- * Used only for that one message (with an unsubscribe link; the sender is not built yet: it deletes a row once it is
--   sent) and deleted after 12 months by app.purge_old_landing_waitlist (the next migration, pasted by hand because it
--   deletes; pg_cron crm-landing-waitlist-purge).
-- * Read only through platform functions: public.platform_landing_waitlist_counts() (counts per plan, every platform
--   role) and public.platform_landing_waitlist(plan) (the addresses, the platform OWNER only, each read logged).
-- No delete statement, no drop statement. Safe to run twice.

create table if not exists app.landing_waitlist (
  id                      uuid primary key default gen_random_uuid(),
  email                   text not null check (char_length(email) between 3 and 254 and email = lower(email) and email !~ '\s'),
  plan_key                text not null references public.plans (key) on delete cascade,
  consent                 boolean not null check (consent),
  consent_wording_version text not null check (consent_wording_version ~ '^[a-z0-9-]{1,40}$'),
  created_at              timestamptz not null default now(),
  constraint landing_waitlist_once unique (email, plan_key)
);
create index if not exists landing_waitlist_created_idx on app.landing_waitlist (created_at);
create index if not exists landing_waitlist_plan_idx on app.landing_waitlist (plan_key);
alter table app.landing_waitlist enable row level security;
revoke all on table app.landing_waitlist from public, anon, authenticated, service_role;

create table if not exists app.landing_waitlist_counts (
  bucket       integer primary key check (bucket between 0 and 1023),
  window_start timestamptz not null,
  n            integer not null
);
alter table app.landing_waitlist_counts enable row level security;
revoke all on table app.landing_waitlist_counts from public, anon, authenticated, service_role;

-- the system-wide cap: one row per window kind, new stored rows only, no address
create table if not exists app.landing_waitlist_totals (
  kind         text primary key check (kind in ('hour', 'day')),
  window_start timestamptz not null,
  n            integer not null
);
alter table app.landing_waitlist_totals enable row level security;
revoke all on table app.landing_waitlist_totals from public, anon, authenticated, service_role;
insert into app.landing_waitlist_totals (kind, window_start, n)
values ('hour', now(), 0), ('day', now(), 0)
on conflict (kind) do nothing;

-- the caps, one place (tests read them)
create or replace function app.landing_waitlist_cap(p_kind text) returns integer
language sql immutable
set search_path = ''
as $$
  select case p_kind when 'hour' then 200 when 'day' then 1000 end
$$;
revoke all on function app.landing_waitlist_cap(text) from public, anon, authenticated, service_role;

-- the consent wordings the landing page has shown (a new wording is a new version, added here by a migration);
-- mirrored by WAITLIST_CONSENT_VERSION in src/features/landing/waitlist.ts
create or replace function app.landing_waitlist_wording_known(p_version text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_version in ('waitlist-draft-1')
$$;
revoke all on function app.landing_waitlist_wording_known(text) from public, anon, authenticated, service_role;

create or replace function public.landing_waitlist_submit(
  p_email text, p_plan text, p_consent boolean, p_wording_version text, p_ip_hash text
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_bucket integer;
  v_n      integer;
  v_full   boolean;
  v_id     uuid;
begin
  -- no sender hash = no limit can be kept: nothing is stored (fail closed)
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- the sender first, before anything is read: only the bucket number of the keyed hash is kept
  v_bucket := ((hashtextextended('waitlist:' || p_ip_hash, 0) % 1024) + 1024) % 1024;
  insert into app.landing_waitlist_counts as c (bucket, window_start, n)
  values (v_bucket, now(), 1)
  on conflict (bucket) do update
    set window_start = case when c.window_start > now() - interval '10 minutes' then c.window_start else now() end,
        n = case when c.window_start > now() - interval '10 minutes' then c.n + 1 else 1 end
  returning c.n into v_n;
  if v_n > 5 then
    return jsonb_build_object('rate_limited', true);
  end if;

  if char_length(v_email) > 254 or v_email !~ '^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$' then
    return jsonb_build_object('status', 'invalid', 'field', 'email');
  end if;
  if coalesce(p_consent, false) is not true or not app.landing_waitlist_wording_known(p_wording_version) then
    return jsonb_build_object('status', 'invalid', 'field', 'consent');
  end if;
  if not exists (select 1 from public.plans p where p.key = p_plan and p.availability = 'coming_soon') then
    return jsonb_build_object('status', 'invalid', 'field', 'plan');
  end if;

  -- the system-wide cap: both window rows locked in one order (day, then hour), rolled over when their window ended, and
  -- judged before the insert, so the answer is the same whether the address would have been new or not
  perform 1 from app.landing_waitlist_totals t where t.kind in ('day', 'hour') order by t.kind for update;
  update app.landing_waitlist_totals t
     set window_start = now(), n = 0
   where t.kind in ('day', 'hour')
     and t.window_start <= now() - case t.kind when 'hour' then interval '1 hour' else interval '1 day' end;
  select bool_or(t.n >= app.landing_waitlist_cap(t.kind)) into v_full
    from app.landing_waitlist_totals t where t.kind in ('day', 'hour');
  if v_full is distinct from false then
    return jsonb_build_object('rate_limited', true);
  end if;

  insert into app.landing_waitlist (email, plan_key, consent, consent_wording_version)
  values (v_email, p_plan, true, p_wording_version)
  on conflict (email, plan_key) do nothing
  returning id into v_id;
  if v_id is not null then
    update app.landing_waitlist_totals set n = n + 1 where kind in ('hour', 'day');
  end if;
  -- the same answer whether the address was new or not
  return jsonb_build_object('status', 'received');
end;
$$;
revoke all on function public.landing_waitlist_submit(text, text, boolean, text, text) from public, anon, authenticated, service_role;
grant execute on function public.landing_waitlist_submit(text, text, boolean, text, text) to service_role;

-- how many addresses wait per plan (any platform role; counts only)
create or replace function public.platform_landing_waitlist_counts() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return coalesce((
    select jsonb_object_agg(w.plan_key, w.n)
      from (select plan_key, count(*) as n from app.landing_waitlist group by plan_key) w), '{}'::jsonb);
end;
$$;
revoke all on function public.platform_landing_waitlist_counts() from public, anon, authenticated, service_role;
grant execute on function public.platform_landing_waitlist_counts() to authenticated;

-- the addresses of one plan, for the platform owner only; every read is logged (plan and count, no address)
create or replace function public.platform_landing_waitlist(p_plan text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform app.require_platform(array[]::text[]);
  select coalesce(jsonb_agg(jsonb_build_object('email', w.email, 'consent_wording_version', w.consent_wording_version,
                                               'created_at', w.created_at) order by w.created_at), '[]'::jsonb)
    into v_rows
    from app.landing_waitlist w
   where w.plan_key = p_plan;
  perform app.log_platform('landing_waitlist.read', null, jsonb_build_object('plan', p_plan, 'count', jsonb_array_length(v_rows)));
  return v_rows;
end;
$$;
revoke all on function public.platform_landing_waitlist(text) from public, anon, authenticated, service_role;
grant execute on function public.platform_landing_waitlist(text) to authenticated;
