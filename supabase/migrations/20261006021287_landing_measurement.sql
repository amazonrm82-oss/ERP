-- =============================================================================
-- LND-14: measurement on the landing page, counted in our own database (owner (388) א, 16 November 2026)
-- =============================================================================
-- How many visitors reach the landing page, how many press a sign-up button there, and how many of those finish the sign-up
-- form, by where they came from (utm_source only). No cookie, no browser storage and no visitor id: the owner's answer (388) א
-- asks for the pattern of LND-13's "notify me" (CLAUDE.md hard rule 5):
-- * ONE security definer function granted to service_role only, public.landing_event(kind, source, ip_hash), called by the
--   server only (src/features/landing/measure-server.ts): the landing page `/` when it renders (a visit), the redirect link
--   GET /go/signup (a press on a sign-up button), and the sign-up action after Auth created a NEW account for a visitor who
--   came through that link (a sign-up). No direct table access for any API role.
-- * It keeps daily counters only, per business day (Asia/Jerusalem), kind and source, in app.landing_event_days (schema app,
--   RLS on, no grants). Never a row per visitor.
-- * The source is utm_source only, in a closed shape: trimmed, lower case, [a-z0-9_.-]{1,40}; empty = 'direct'; anything
--   else = 'other' (the server folds it the same way first: landingSource() in src/features/landing/measure.ts). At most
--   app.landing_event_source_cap() (200) different sources a day, shared by the three kinds; a new one past that is counted
--   as 'other' (judged under a per-day advisory lock); 'direct' and 'other' are never held by the cap.
-- * FXS-11 rate limit: the server's keyed IP hash (scope `landing`, an IPv6 sender by its /64) becomes one of 4,096 bucket
--   numbers per kind and only the bucket is kept (app.landing_event_counts): per sender in 10 minutes at most
--   app.landing_event_limit(kind) events (visit 30, signup_click 10, signup 5); over that the event is not counted and the
--   visitor is told nothing (the page and the link work the same). No hash (no INTAKE_IP_HASH_SECRET, or no client address)
--   = not counted.
-- * Read only through public.platform_landing_measurement(days): counts per day and source, for the platform owner, support
--   and readonly staff (aal2 through app.require_platform).
-- * Retention: counters older than 25 months are removed by app.landing_event_purge_rows (the next migration, pasted by hand
--   because it deletes), called by pg_cron crm-landing-measurement-purge through app.run_landing_event_purge(), which does
--   nothing until that function exists.
-- No delete statement, no drop statement. Safe to run twice.

create table if not exists app.landing_event_days (
  day    date not null,
  kind   text not null check (kind in ('visit', 'signup_click', 'signup')),
  source text not null check (source ~ '^[a-z0-9_.-]{1,40}$'),
  n      integer not null default 0 check (n >= 0),
  primary key (day, kind, source)
);
alter table app.landing_event_days enable row level security;
revoke all on table app.landing_event_days from public, anon, authenticated, service_role;

create table if not exists app.landing_event_counts (
  kind         text not null check (kind in ('visit', 'signup_click', 'signup')),
  bucket       integer not null check (bucket between 0 and 4095),
  window_start timestamptz not null,
  n            integer not null,
  primary key (kind, bucket)
);
alter table app.landing_event_counts enable row level security;
revoke all on table app.landing_event_counts from public, anon, authenticated, service_role;

-- the rules in one place (tests read them)
create or replace function app.landing_event_limit(p_kind text) returns integer
language sql immutable
set search_path = ''
as $$
  select case p_kind when 'visit' then 30 when 'signup_click' then 10 when 'signup' then 5 end
$$;
revoke all on function app.landing_event_limit(text) from public, anon, authenticated, service_role;

create or replace function app.landing_event_source_cap() returns integer
language sql immutable
set search_path = ''
as $$
  select 200
$$;
revoke all on function app.landing_event_source_cap() from public, anon, authenticated, service_role;

-- the closed shape of a source: over 200 characters = 'other'; else spaces trimmed (btrim), then [A-Za-z0-9_.-]{1,40} in lower case; mirrored by landingSource() in
-- src/features/landing/measure.ts (shared fixture tests/unit/fixtures/landing-sources.json)
create or replace function app.landing_event_source(p_source text) returns text
language sql immutable
set search_path = ''
as $$
  select case
           when length(p_source) > 200 then 'other'
           when nullif(btrim(coalesce(p_source, '')), '') is null then 'direct'
           when btrim(p_source) ~ '^[A-Za-z0-9_.-]{1,40}$' then lower(btrim(p_source))
           else 'other'
         end
$$;
revoke all on function app.landing_event_source(text) from public, anon, authenticated, service_role;

create or replace function public.landing_event(p_kind text, p_source text, p_ip_hash text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_source text := app.landing_event_source(p_source);
  v_day    date := (now() at time zone 'Asia/Jerusalem')::date;
  v_bucket integer;
  v_n      integer;
begin
  if p_kind is null or p_kind not in ('visit', 'signup_click', 'signup') then
    return jsonb_build_object('counted', false);
  end if;
  -- no sender hash = no limit can be kept: not counted
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('counted', false);
  end if;
  -- the sender first: only the bucket number of the keyed hash is kept
  v_bucket := ((hashtextextended('landing:' || p_ip_hash, 0) % 4096) + 4096) % 4096;
  insert into app.landing_event_counts as c (kind, bucket, window_start, n)
  values (p_kind, v_bucket, now(), 1)
  on conflict (kind, bucket) do update
    set window_start = case when c.window_start > now() - interval '10 minutes' then c.window_start else now() end,
        n = case when c.window_start > now() - interval '10 minutes' then c.n + 1 else 1 end
  returning c.n into v_n;
  if v_n > app.landing_event_limit(p_kind) then
    return jsonb_build_object('counted', false);
  end if;

  -- a new source past the day's cap is counted as 'other'. The cap is shared by the three kinds (distinct sources of the day);
  -- 'direct' and 'other' are never held by it.
  -- Only a source new that day takes the day's lock, then judges again, so two new sources cannot both pass the last place.
  if v_source not in ('other', 'direct')
     and not exists (select 1 from app.landing_event_days d where d.day = v_day and d.source = v_source) then
    perform pg_advisory_xact_lock(hashtext('landing_sources:' || v_day::text));
    if not exists (select 1 from app.landing_event_days d where d.day = v_day and d.source = v_source)
       and (select count(distinct d.source) from app.landing_event_days d where d.day = v_day) >= app.landing_event_source_cap() then
      v_source := 'other';
    end if;
  end if;

  insert into app.landing_event_days as d (day, kind, source, n)
  values (v_day, p_kind, v_source, 1)
  on conflict (day, kind, source) do update set n = d.n + 1;
  return jsonb_build_object('counted', true);
end;
$$;
revoke all on function public.landing_event(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.landing_event(text, text, text) to service_role;

-- the platform screen: the last p_days business days (1..90), per day and source; counts only
create or replace function public.platform_landing_measurement(p_days integer default 30) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_to   date := (now() at time zone 'Asia/Jerusalem')::date;
  v_from date := v_to - (least(greatest(coalesce(p_days, 30), 1), 90) - 1);
begin
  perform app.require_platform(array['support', 'readonly']);
  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'days', v_days,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', r.day, 'source', r.source, 'visits', r.visits, 'signup_clicks', r.clicks, 'signups', r.signups)
             order by r.day desc, r.source)
        from (select d.day, d.source,
                     sum(d.n) filter (where d.kind = 'visit')::integer as visits,
                     sum(d.n) filter (where d.kind = 'signup_click')::integer as clicks,
                     sum(d.n) filter (where d.kind = 'signup')::integer as signups
                from app.landing_event_days d
               where d.day between v_from and v_to
               group by d.day, d.source) r), '[]'::jsonb));
end;
$$;
revoke all on function public.platform_landing_measurement(integer) from public, anon, authenticated, service_role;
grant execute on function public.platform_landing_measurement(integer) to authenticated;

-- retention: the delete lives in the next migration (pasted by hand); until it exists this does nothing
create or replace function app.run_landing_event_purge() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  if to_regprocedure('app.landing_event_purge_rows(integer)') is null then
    return 0;
  end if;
  execute 'select app.landing_event_purge_rows($1)' into v_n using 20000;
  return coalesce(v_n, 0);
end;
$$;
revoke all on function app.run_landing_event_purge() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-landing-measurement-purge', '43 2 * * *', 'select app.run_landing_event_purge();');
  end if;
end;
$$;
