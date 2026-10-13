-- =============================================================================
-- 0102 Personal calendar feed (CAL-07)
-- =============================================================================
-- "A personal, secret ICS link that shows the Mexuz calendar in Google Calendar,
-- Outlook and the phone (read only)."
--
-- One link per person per organization. Only a SHA-256 hash of the token is
-- kept, in app.calendar_feeds (schema app: no API access, no client grants, RLS
-- on without policies, like app.mfa_recovery_codes). So the link is shown once,
-- when it is made; a new link replaces the old one, and turning it off clears
-- the hash. Either way the old link stops working at once.
--
-- The calendar app fetches the link with no session. That is a public
-- secret-link page (owner's decision, 8 October 2026; CLAUDE.md hard rule 5):
-- the server route calls one security definer function, granted to
-- service_role only, that checks the token and does only what the feed needs:
-- public.calendar_feed_events(token). It returns the meetings the person
-- organizes or takes part in, from 30 days back to 365 days ahead, at most
-- 2,000, with title, times, place, video link and status only (never the
-- description, the outcome or the linked customer).
--
-- Suspending a member turns their links off (trigger memberships_calendar_feed_off
-- clears the hash), so making them active again does not quietly revive an old
-- link that may have been handed around meanwhile; they make a new one.
--
-- When the feed is empty-handed (the function answers {ok: false}, the route
-- answers 404): an unknown or turned-off token, a membership that is suspended
-- or gone (a removed member's row goes with the membership, on delete cascade),
-- and an organization that is suspended, cancelled or deleted. A read-only
-- organization keeps its feed: its members still read their calendar in the app.
-- (Additions spec 22.9 stops booking pages and payment links of a read-only or
-- suspended organization; this is the member's own calendar, so only
-- suspension stops it.)
-- Fetch limit: 60 fetches per link per 10 minutes, then {ok: false, reason: 'rate'}.
--
-- Signed-in functions (the "my account" page): calendar_feed_status(org),
-- calendar_feed_create(org) (returns the token, once), calendar_feed_revoke(org).
-- They act on the caller's own row only. Making a link needs an active
-- membership with two-step verification passed where required
-- (app.membership_role), not a support session.
-- Every statement is safe to run twice.

create table if not exists app.calendar_feeds (
  organization_id   uuid not null,
  user_id           uuid not null,
  -- hex SHA-256 of the token; null = the link is turned off
  token_hash        text unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz,
  last_used_at      timestamptz,
  -- fetch limit: the start of the current 10-minute window and fetches in it
  window_started_at timestamptz,
  window_count      integer not null default 0,
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);

-- RVW-15: every app table has RLS on (no policies, not forced); clients have no grants
alter table app.calendar_feeds enable row level security;
revoke all on app.calendar_feeds from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- A suspended member's link is turned off for good (a new one is needed later)
-- ----------------------------------------------------------------------------
create or replace function app.calendar_feed_off_on_suspend() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'active' and old.status is distinct from new.status then
    update app.calendar_feeds f
       set token_hash = null, created_at = null, last_used_at = null, window_started_at = null, window_count = 0
     where f.organization_id = new.organization_id and f.user_id = new.user_id and f.token_hash is not null;
  end if;
  return null;
end;
$$;
revoke all on function app.calendar_feed_off_on_suspend() from public, anon, authenticated;

create or replace trigger memberships_calendar_feed_off after update of status on public.memberships
  for each row execute function app.calendar_feed_off_on_suspend();

-- ----------------------------------------------------------------------------
-- The caller's link in an organization: is there one, since when, last fetch
-- ----------------------------------------------------------------------------
create or replace function public.calendar_feed_status(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.calendar_feeds;
begin
  if p_org is null or app.membership_role(p_org) is null then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  select * into v_row
    from app.calendar_feeds f
   where f.organization_id = p_org and f.user_id = auth.uid();
  return jsonb_build_object(
    'active', coalesce(v_row.token_hash is not null, false),
    'created_at', case when v_row.token_hash is not null then v_row.created_at end,
    'last_used_at', case when v_row.token_hash is not null then v_row.last_used_at end
  );
end;
$$;
revoke all on function public.calendar_feed_status(uuid) from public, anon;
grant execute on function public.calendar_feed_status(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- A new link: 48 random bytes (three v4 UUIDs, 366 random bits) as 64
-- characters of base64url. Replaces the caller's old link. Returned once.
-- ----------------------------------------------------------------------------
create or replace function public.calendar_feed_create(p_org uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if p_org is null or app.membership_role(p_org) is null then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations o
     where o.id = p_org and o.deleted_at is null
       and o.status in ('trial', 'active', 'past_due', 'read_only')
  ) then
    raise exception 'the organization is not active' using errcode = 'P0001', hint = 'org:suspended';
  end if;

  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');

  insert into app.calendar_feeds as f (organization_id, user_id, token_hash, created_at, last_used_at, window_started_at, window_count)
  values (p_org, auth.uid(), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), now(), null, null, 0)
  on conflict (organization_id, user_id) do update
    set token_hash = excluded.token_hash,
        created_at = excluded.created_at,
        last_used_at = null,
        window_started_at = null,
        window_count = 0;

  return v_token;
end;
$$;
revoke all on function public.calendar_feed_create(uuid) from public, anon;
grant execute on function public.calendar_feed_create(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Turning the caller's link off. Only lessens access, so no membership check:
-- the caller's own row is the only one it can reach.
-- ----------------------------------------------------------------------------
create or replace function public.calendar_feed_revoke(p_org uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update app.calendar_feeds f
     set token_hash = null, created_at = null, last_used_at = null, window_started_at = null, window_count = 0
   where f.organization_id = p_org and f.user_id = auth.uid();
end;
$$;
revoke all on function public.calendar_feed_revoke(uuid) from public, anon;
grant execute on function public.calendar_feed_revoke(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The feed itself, for the server route only (service_role).
-- {ok: true, calendar: {name, time_zone}, events: [...]} or {ok: false[, reason: 'rate']}
-- ----------------------------------------------------------------------------
create or replace function public.calendar_feed_events(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_feed app.calendar_feeds;
  v_org public.organizations;
  v_events jsonb;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{64}$' then
    return jsonb_build_object('ok', false);
  end if;

  -- count the fetch (and find the link) in one statement
  update app.calendar_feeds f
     set window_started_at = case when f.window_started_at is null or f.window_started_at <= now() - interval '10 minutes'
                                  then now() else f.window_started_at end,
         window_count = case when f.window_started_at is null or f.window_started_at <= now() - interval '10 minutes'
                             then 1 else f.window_count + 1 end,
         last_used_at = now()
   where f.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  returning f.* into v_feed;

  if v_feed.user_id is null then
    return jsonb_build_object('ok', false);
  end if;

  if not exists (
    select 1 from public.memberships m
     where m.organization_id = v_feed.organization_id and m.user_id = v_feed.user_id and m.status = 'active'
  ) then
    return jsonb_build_object('ok', false);
  end if;

  select * into v_org
    from public.organizations o
   where o.id = v_feed.organization_id and o.deleted_at is null
     and o.status in ('trial', 'active', 'past_due', 'read_only');
  if v_org.id is null then
    return jsonb_build_object('ok', false);
  end if;

  if v_feed.window_count > 60 then
    return jsonb_build_object('ok', false, 'reason', 'rate');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id,
           'title', e.title,
           'starts_at', e.starts_at,
           'ends_at', e.ends_at,
           'location', e.location,
           'video_url', e.video_url,
           'status', e.status,
           'updated_at', e.updated_at
         ) order by e.starts_at, e.id), '[]'::jsonb)
    into v_events
    from (
      select mt.id, mt.title, mt.starts_at, mt.ends_at, mt.location, mt.video_url, mt.status, mt.updated_at
        from public.meetings mt
       where mt.organization_id = v_feed.organization_id
         and mt.starts_at >= now() - interval '30 days'
         and mt.starts_at < now() + interval '365 days'
         and (mt.owner_id = v_feed.user_id
              or exists (select 1 from public.meeting_participants mp
                          where mp.organization_id = mt.organization_id and mp.meeting_id = mt.id
                            and mp.user_id = v_feed.user_id))
       order by mt.starts_at, mt.id
       limit 2000
    ) e;

  return jsonb_build_object(
    'ok', true,
    'calendar', jsonb_build_object('name', v_org.name, 'time_zone', v_org.timezone),
    'events', v_events
  );
end;
$$;
revoke all on function public.calendar_feed_events(text) from public, anon, authenticated;
grant execute on function public.calendar_feed_events(text) to service_role;
