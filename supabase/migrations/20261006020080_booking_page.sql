-- =============================================================================
-- 0200h Public booking page (CAL-10)
-- =============================================================================
-- "דף קביעת תור ציבורי: חלונות פנויים לפי שעות העבודה והיומן, סוג פגישה, שאלות מקדימות, התראה
-- מינימלית ומספר ימים מרבי קדימה. הקובע נרשם כליד, או מקושר לרשומה קיימת לפי טלפון. הדף נגיש וממותג."
--
-- * public.booking_pages: one page per rep and meeting type (title, intro, the meeting type, an
--   optional lead source, minimum notice, how many days ahead, the slot step, up to 10 questions,
--   on/off) with a secret token (server-made, 32 hex). Owner, 15 October 2026: each person manages their own
--   pages, owners/admins all of them, and a team manager (role manager) the pages of the `member`-role people
--   of the teams they manage or a team below (app.booking_manages_rep; RLS). A page whose rep and business have
--   no working hours cannot be turned on (hint booking_page:no_hours) and answers "not found". Plan: flag `booking_page` (hint feature:booking_page) and
--   the allowance max_booking_pages + max_booking_pages_per_user x full seats (hint
--   limit:max_booking_pages), by a definer trigger with the outsider guard first and an advisory lock.
--   Team pages (booking_team_pages) are not built here.
-- * The public side follows the approved pattern for secret-link pages (owner, 8 October 2026; hard
--   rule 5): a server route calls a security definer function granted to service_role only, which
--   checks the token and does only what the page needs; no table is reached directly.
--   - public.booking_page_public(token, from, ip_hash): the page's public fields and the free slots of up to 7
--     days from `from` (P0002 = not found; {"unavailable": true} for a read-only or suspended business;
--     {"rate_limited": true} past 60 views per IP hash in 10 minutes, nothing computed; views never close a page;
--     counted first in app.booking_view_counts (1,024 reused buckets per page, no row per view, no hash kept)).
--   - public.booking_submit(token, starts_at, payload, ip_hash, user_agent, is_spam): books one slot.
--   Not found: no such token, page off, business closed (app.org_public_pages_open) or without the
--   flag, the rep no longer an active non-viewer member, no working hours for the rep or the business, or the
--   page's meeting type missing or off.
-- * Free slots (app.booking_slots): every `step` minutes of each local day in the business's zone,
--   from now + minimum notice up to today + days ahead; the whole meeting (the type's duration) inside
--   the rep's working hours (the rule of app.member_in_hours, CAP-09: rest days, holidays and leave
--   included, evaluated once per call as a multirange the meeting must lie inside); and clear of the rep's meetings (organized or
--   joined, not cancelled or no-show): the new meeting may not touch another's busy time (its
--   buffers, CAL-10) and its own buffers may not touch another meeting.
-- * booking_submit: name and phone required (the phone links the booking), email optional, answers to
--   the questions (text, up to 1,000 characters; required ones checked). Locks the rep, re-checks the
--   slot (slot_taken; invalid_time for a time never offered), then links by phone: a lead with that phone not in the recycle bin, else a
--   contact not in the bin (its primary phone or a further one, CON-01); else a new lead owned by the rep (open
--   default status; the page's source, else the source "דף קביעת תור" of the lead sources list, made (kind
--   'booking') when the business has none; campaign = the visit's utm_campaign, else the page's title; the
--   visit's campaign keys as intake keeps them). The meeting: the
--   type's name and the person's name as title, the type's format and location, owner = the rep,
--   linked to the lead and/or contact, the answers in its description; buffers come from the type
--   (trigger meetings_buffers). The rep is told by the usual organizer notice. An existing record
--   gets an `inquiry` entry naming the booking. A time no longer free is answered {"status": "slot_taken"}
--   (not raised, so the refused attempt stays counted).
-- * Rate limits (FXS-11 style): app.booking_requests logs each booking attempt (page, outcome, time, keyed IP
--   hash made by the server route), one attempt at a time per page (advisory lock before the counts): at most 5
--   per IP hash in 10 minutes (spam and invalid times included). Owner, 15 October 2026: 200 failed attempts (refused:
--   a real race, a time taken by a meeting made in the last hour, counted once per start time; a time never offered
--   is answered invalid_time and counts per sender only) on a page within an hour close it for an hour (app.booking_page_closures; answered booking:closed) and
--   send one `system` notice to the page's rep and the business's owners. Views only have the per-IP limit
--   (app.booking_view_counts, above).
--   pg_cron `crm-booking-ip-hashes` clears the hashes older than 15 minutes (an update; the rows keep
--   no personal data). No cookies or visitor id.
-- No delete, no drop. Safe to run twice.

create table if not exists public.booking_pages (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  user_id            uuid not null,
  token              text not null unique default replace(gen_random_uuid()::text, '-', ''),
  title              text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  intro              text check (char_length(intro) between 1 and 1000),
  meeting_type_id    uuid,
  source_id          uuid,
  min_notice_minutes integer not null default 120 check (min_notice_minutes between 0 and 10080),
  max_days_ahead     integer not null default 30 check (max_days_ahead between 1 and 365),
  slot_step_minutes  integer not null default 30 check (slot_step_minutes in (15, 30, 60)),
  questions          jsonb not null default '[]'::jsonb
                     check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) <= 10),
  is_active          boolean not null default true,
  created_by         uuid references auth.users (id) on delete set null,
  updated_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint booking_pages_member_fk foreign key (organization_id, user_id)
    references public.memberships (organization_id, user_id) on delete cascade,
  constraint booking_pages_type_fk foreign key (organization_id, meeting_type_id)
    references public.meeting_types (organization_id, id) on delete set null (meeting_type_id),
  constraint booking_pages_source_fk foreign key (organization_id, source_id)
    references public.lead_sources (organization_id, id) on delete set null (source_id)
);

create index if not exists booking_pages_org_idx on public.booking_pages (organization_id, user_id);
create index if not exists booking_pages_type_idx on public.booking_pages (organization_id, meeting_type_id) where meeting_type_id is not null;
create index if not exists booking_pages_source_idx on public.booking_pages (organization_id, source_id) where source_id is not null;

alter table public.booking_pages enable row level security;

revoke all on public.booking_pages from anon, authenticated;
grant select, delete on public.booking_pages to authenticated;
grant insert (organization_id, user_id, title, intro, meeting_type_id, source_id, min_notice_minutes, max_days_ahead,
              slot_step_minutes, questions, is_active)
  on public.booking_pages to authenticated;
grant update (user_id, title, intro, meeting_type_id, source_id, min_notice_minutes, max_days_ahead,
              slot_step_minutes, questions, is_active)
  on public.booking_pages to authenticated;

comment on table public.booking_pages is
  'CAL-10: public booking pages: one rep and meeting type each, with a secret token; read by app.booking_* only from outside.';

-- A team manager (role manager, like goals) manages the pages of the `member`-role people of the teams they manage
-- or a team below them (app.manages_team); never an owner's, admin's or another manager's (owner, 15 October 2026).
create or replace function app.booking_manages_rep(p_org uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is not null
     and coalesce(app.membership_role(p_org) = 'manager', false)
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = p_user and m.role = 'member')
     and exists (select 1 from public.team_members tm
                  where tm.organization_id = p_org and tm.user_id = p_user and app.manages_team(tm.team_id))
$$;
revoke all on function app.booking_manages_rep(uuid, uuid) from public, anon;
grant execute on function app.booking_manages_rep(uuid, uuid) to authenticated, service_role;

do $$
begin
  -- each person their own pages, owners and admins all of them, a team manager their people's
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_pages' and policyname = 'booking_pages_select') then
    create policy booking_pages_select on public.booking_pages for select to authenticated
      using (app.is_member(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id) or app.booking_manages_rep(organization_id, user_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_pages' and policyname = 'booking_pages_insert') then
    create policy booking_pages_insert on public.booking_pages for insert to authenticated
      with check (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id) or app.booking_manages_rep(organization_id, user_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_pages' and policyname = 'booking_pages_update') then
    create policy booking_pages_update on public.booking_pages for update to authenticated
      using (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id) or app.booking_manages_rep(organization_id, user_id)))
      with check (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id) or app.booking_manages_rep(organization_id, user_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_pages' and policyname = 'booking_pages_delete') then
    create policy booking_pages_delete on public.booking_pages for delete to authenticated
      using (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id) or app.booking_manages_rep(organization_id, user_id)));
  end if;
end;
$$;

create or replace trigger booking_pages_touch before insert or update on public.booking_pages
  for each row execute function app.touch_row();
create or replace trigger booking_pages_audit after insert or update or delete on public.booking_pages
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- What a person may write: an active rep, an active meeting type, well-formed questions
-- ----------------------------------------------------------------------------
create or replace function app.booking_pages_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_ids text[] := '{}';
begin
  new.intro := nullif(btrim(new.intro), '');
  -- the questions: [{id, label, required}], ids unique (also server writes)
  for v_item in select value from jsonb_array_elements(new.questions) loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item ->> 'id', '') !~ '^[a-z0-9_-]{1,40}$'
       or char_length(btrim(coalesce(v_item ->> 'label', ''))) not between 1 and 200
       or jsonb_typeof(v_item -> 'required') is distinct from 'boolean'
       or (select count(*) from jsonb_object_keys(v_item)) <> 3
       or (v_item ->> 'id') = any (v_ids) then
      raise exception 'invalid booking questions' using errcode = '22023', hint = 'booking_page:questions';
    end if;
    v_ids := v_ids || (v_item ->> 'id');
  end loop;
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- someone who may not write here is refused by RLS (plain 42501) right after
  if not app.can_write(new.organization_id) then
    return new;
  end if;
  if tg_op = 'INSERT' or new.user_id is distinct from old.user_id then
    if not exists (select 1 from public.memberships m
                    where m.organization_id = new.organization_id and m.user_id = new.user_id
                      and m.status = 'active' and m.role <> 'viewer') then
      raise exception 'the rep is not an active member' using errcode = '22023', hint = 'booking_page:user';
    end if;
  end if;
  if new.meeting_type_id is not null and (tg_op = 'INSERT' or new.meeting_type_id is distinct from old.meeting_type_id) then
    if not exists (select 1 from public.meeting_types t
                    where t.organization_id = new.organization_id and t.id = new.meeting_type_id and t.is_active) then
      raise exception 'the meeting type is not active' using errcode = '22023', hint = 'booking_page:type';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.booking_pages_check() from public, anon, authenticated;

create or replace trigger booking_pages_check before insert or update on public.booking_pages
  for each row execute function app.booking_pages_check();

-- Working hours: the rep's own, else the business's (none = no times at all)
create or replace function app.booking_rep_has_hours(p_org uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = p_user and p.working_hours is not null)
      or exists (select 1 from public.org_calendar_settings c where c.organization_id = p_org and c.working_hours is not null)
$$;
revoke all on function app.booking_rep_has_hours(uuid, uuid) from public, anon, authenticated;

-- A page without hours is not published: a person cannot turn one on (or create it on, or move it to a rep
-- without hours while on). Definer, so the rep's profile is read whoever writes; the outsider guard first.
create or replace function app.booking_pages_hours() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not app.can_write(new.organization_id) then
    return new;
  end if;
  if new.is_active
     and (tg_op = 'INSERT' or not old.is_active or new.user_id is distinct from old.user_id)
     and not app.booking_rep_has_hours(new.organization_id, new.user_id) then
    raise exception 'the rep has no working hours' using errcode = '22023', hint = 'booking_page:no_hours';
  end if;
  return new;
end;
$$;
revoke all on function app.booking_pages_hours() from public, anon, authenticated;

create or replace trigger booking_pages_hours before insert or update on public.booking_pages
  for each row execute function app.booking_pages_hours();

-- The plan: the flag, and the allowance (business-wide + per full seat); null = no cap
create or replace function app.booking_pages_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_base numeric;
  v_per_user numeric;
  v_seats integer;
  v_cap numeric;
begin
  -- an outsider is refused by RLS (plain 42501) right after; answering here would tell about the business
  if auth.uid() is not null and not app.can_write(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'booking_page') then
    raise exception 'booking pages are not in the plan' using errcode = 'P0001', hint = 'feature:booking_page';
  end if;
  v_base := app.org_limit(new.organization_id, 'max_booking_pages');
  v_per_user := app.org_limit(new.organization_id, 'max_booking_pages_per_user');
  -- a null (unlimited) value of either key is unlimited, like the other quotas
  if v_base is null or v_per_user is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('booking_pages:' || new.organization_id::text, 0));
  select count(*) into v_seats from public.memberships m
   where m.organization_id = new.organization_id and m.status = 'active' and m.seat_type = 'full';
  v_cap := coalesce(v_base, 0) + coalesce(v_per_user, 0) * v_seats;
  if (select count(*) from public.booking_pages b where b.organization_id = new.organization_id)
     >= v_cap then
    raise exception 'booking page limit reached' using errcode = 'P0001', hint = 'limit:max_booking_pages';
  end if;
  return new;
end;
$$;
revoke all on function app.booking_pages_quota() from public, anon, authenticated;

create or replace trigger booking_pages_quota before insert on public.booking_pages
  for each row execute function app.booking_pages_quota();

-- ----------------------------------------------------------------------------
-- Attempts, for the rate limits (schema app: no API access)
-- ----------------------------------------------------------------------------
create table if not exists app.booking_requests (
  id              bigint generated always as identity primary key,
  page_id         uuid not null,
  organization_id uuid not null,
  ip_hash         text,
  -- refused = a real race (counts toward closing the page); invalid = a time never offered (per sender only)
  outcome         text not null check (outcome in ('booked', 'spam', 'refused', 'invalid')),
  -- the start time asked for, on a refused row only (one refused row per page and start time an hour)
  starts_at       timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists booking_requests_page_idx on app.booking_requests (page_id, created_at);
create index if not exists booking_requests_hash_idx on app.booking_requests (created_at) where ip_hash is not null;
alter table app.booking_requests enable row level security;
revoke all on app.booking_requests from public, anon, authenticated, service_role;

-- Views (review of 15 October 2026): no row per view. A fixed set of counters per page, 1,024 buckets picked by the
-- keyed IP hash; each counts the views of its 10-minute window and is reused by the next window (an update, never
-- a delete). No hash is stored, so nothing personal stays; senders sharing a bucket share its count (rare, and only
-- ever stricter).
create table if not exists app.booking_view_counts (
  page_id      uuid not null,
  bucket       integer not null check (bucket between 0 and 1023),
  window_start timestamptz not null,
  views        integer not null,
  primary key (page_id, bucket)
);
alter table app.booking_view_counts enable row level security;
revoke all on app.booking_view_counts from public, anon, authenticated, service_role;

-- A page closed for an hour after 200 failed attempts within an hour (owner, 15 October 2026)
create table if not exists app.booking_page_closures (
  page_id         uuid primary key,
  organization_id uuid not null,
  closed_until    timestamptz not null,
  created_at      timestamptz not null default now()
);
alter table app.booking_page_closures enable row level security;
revoke all on app.booking_page_closures from public, anon, authenticated, service_role;

-- A keyed IP hash is kept only for the rate-limit window
create or replace function app.clear_booking_ip_hashes() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update app.booking_requests r set ip_hash = null
   where r.ip_hash is not null and r.created_at < now() - interval '15 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.clear_booking_ip_hashes() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-booking-ip-hashes', '*/10 * * * *', 'select app.clear_booking_ip_hashes();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The page behind a token, and whether it can be shown
-- ----------------------------------------------------------------------------
-- 'not_found' | 'unavailable' (read-only or suspended business) | 'open'
create or replace function app.booking_page_state(p_page public.booking_pages) returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_page.id is null or not p_page.is_active then 'not_found'
    when not app.org_public_pages_open(p_page.organization_id) then 'not_found'
    when not app.org_has_feature(p_page.organization_id, 'booking_page') then 'not_found'
    when not exists (select 1 from public.memberships m
                      where m.organization_id = p_page.organization_id and m.user_id = p_page.user_id
                        and m.status = 'active' and m.role <> 'viewer') then 'not_found'
    when not exists (select 1 from public.meeting_types t
                      where t.organization_id = p_page.organization_id and t.id = p_page.meeting_type_id
                        and t.is_active) then 'not_found'
    when not app.booking_rep_has_hours(p_page.organization_id, p_page.user_id) then 'not_found'
    when not app.org_writable(p_page.organization_id) then 'unavailable'
    else 'open'
  end
$$;
revoke all on function app.booking_page_state(public.booking_pages) from public, anon, authenticated;

-- The free starts of a page's meeting on the local days [p_from, p_from + p_days) (at most 7), within the page's window.
-- The rule of app.member_in_hours (CAP-09), evaluated as ranges (review of 15 October 2026: one pass instead of a call
-- every 15 minutes): the rep's hours (their own in their zone, else the business's in its zone; "23:59" = to midnight),
-- minus the business's rest days and holidays (its zone) and the rep's leave (the rep's zone, else the business's), as one
-- multirange; a start is free when the whole meeting [start, end) lies inside it and clears the rep's meetings.
-- p_ignore_since: meetings made at or after it do not block (null = all block; '-infinity' = none block). It tells a
-- real race (a time taken by a meeting made in the last hour) from a time that was never offered.
create or replace function app.booking_slots(p_page_id uuid, p_from date, p_days integer, p_ignore_since timestamptz default null)
returns setof timestamptz
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_page public.booking_pages;
  v_type public.meeting_types;
  v_org_zone text;
  v_zone text;
  v_own jsonb;
  v_profile_zone text;
  v_org_hours jsonb;
  v_hours jsonb;
  v_hours_zone text;
  v_today date;
  v_first date;
  v_last date;
  v_avail tstzmultirange;
  v_closed tstzmultirange;
begin
  select * into v_page from public.booking_pages b where b.id = p_page_id;
  select * into v_type from public.meeting_types t where t.organization_id = v_page.organization_id and t.id = v_page.meeting_type_id;
  if v_page.id is null or v_type.id is null then
    return;
  end if;
  select app.intake_zone(o.timezone) into v_org_zone from public.organizations o where o.id = v_page.organization_id;
  select p.working_hours, p.timezone into v_own, v_profile_zone from public.profiles p where p.id = v_page.user_id;
  v_zone := case when v_profile_zone is null then v_org_zone else app.intake_zone(v_profile_zone) end;
  select c.working_hours into v_org_hours from public.org_calendar_settings c where c.organization_id = v_page.organization_id;
  -- working hours are needed: the rep's own or the business's (none = no slots, not "all day")
  if v_org_zone is null or (v_own is null and v_org_hours is null) then
    return;
  end if;
  v_hours := coalesce(v_own, v_org_hours);
  v_hours_zone := case when v_own is not null then v_zone else v_org_zone end;

  v_today := (now() at time zone v_org_zone)::date;
  v_first := greatest(p_from, v_today);
  v_last := least(p_from + least(greatest(p_days, 1), 7) - 1, v_today + v_page.max_days_ahead);
  if v_first > v_last then
    return;
  end if;

  -- the hours, a day around the window on each side (zones differ)
  select coalesce(range_agg(tstzrange(b.lo, b.hi)), '{}'::tstzmultirange)
    into v_avail
    from generate_series((v_first - 2)::timestamp, (v_last + 2)::timestamp, interval '1 day') g(day)
    cross join lateral (select g.day::date as d) dd
    cross join lateral (select v_hours -> (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[extract(dow from dd.d)::int + 1] as v) dv
    cross join lateral jsonb_array_elements(case when jsonb_typeof(dv.v) = 'array' then dv.v
                                                 when jsonb_typeof(dv.v) = 'object' then jsonb_build_array(dv.v)
                                                 else '[]'::jsonb end) r
    cross join lateral (
      select (dd.d + (r.value ->> 'start')::time) at time zone v_hours_zone as lo,
             case when r.value ->> 'end' = '23:59' then (dd.d + 1)::timestamp at time zone v_hours_zone
                  else (dd.d + (r.value ->> 'end')::time) at time zone v_hours_zone end as hi) b
   -- a range that a clock change empties (or turns around) holds nothing
   where jsonb_typeof(v_hours) = 'object' and b.lo < b.hi;

  -- closed: the business's rest days and holidays (its zone), the rep's leave (the rep's zone)
  select coalesce(range_agg(x.r), '{}'::tstzmultirange) into v_closed
    from (
      select tstzrange(g.day at time zone v_org_zone, (g.day + interval '1 day') at time zone v_org_zone) as r
        from generate_series((v_first - 2)::timestamp, (v_last + 2)::timestamp, interval '1 day') g(day)
       where app.org_rest_day(v_page.organization_id, g.day::date)
      union all
      select tstzrange(l.starts_on::timestamp at time zone v_zone, (l.ends_on + 1)::timestamp at time zone v_zone)
        from public.member_leaves l
       where l.organization_id = v_page.organization_id and l.user_id = v_page.user_id
         and l.ends_on >= v_first - 2 and l.starts_on <= v_last + 2
    ) x;
  v_avail := v_avail - v_closed;

  return query
  with candidates as (
    select (local_t at time zone v_org_zone) as starts_at
      from generate_series(v_first::timestamp, v_last::timestamp + interval '1 day' - make_interval(mins => v_page.slot_step_minutes),
                           make_interval(mins => v_page.slot_step_minutes)) local_t
  )
  select c.starts_at
    from candidates c
   where c.starts_at >= now() + make_interval(mins => v_page.min_notice_minutes)
     and v_avail @> tstzrange(c.starts_at, c.starts_at + make_interval(mins => v_type.duration_minutes))
     and not exists (
       select 1 from public.meetings mt
        where mt.organization_id = v_page.organization_id
          and mt.status not in ('cancelled', 'no_show')
          and (p_ignore_since is null or mt.created_at < p_ignore_since)
          and (mt.owner_id = v_page.user_id
               or exists (select 1 from public.meeting_participants mp
                           where mp.organization_id = v_page.organization_id and mp.meeting_id = mt.id
                             and mp.user_id = v_page.user_id))
          -- a first cut on the index: buffers are at most 240 minutes each
          and mt.starts_at < c.starts_at + make_interval(mins => v_type.duration_minutes + v_type.buffer_after_minutes) + interval '240 minutes'
          and mt.ends_at > c.starts_at - make_interval(mins => v_type.buffer_before_minutes) - interval '240 minutes'
          and (
            -- the new meeting inside another's busy time
            (mt.starts_at - make_interval(mins => mt.buffer_before_minutes) < c.starts_at + make_interval(mins => v_type.duration_minutes)
             and mt.ends_at + make_interval(mins => mt.buffer_after_minutes) > c.starts_at)
            -- or its own buffers on another meeting
            or (mt.starts_at < c.starts_at + make_interval(mins => v_type.duration_minutes + v_type.buffer_after_minutes)
                and mt.ends_at > c.starts_at - make_interval(mins => v_type.buffer_before_minutes))))
   order by c.starts_at;
end;
$$;
revoke all on function app.booking_slots(uuid, date, integer, timestamptz) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The public page
-- ----------------------------------------------------------------------------
create or replace function public.booking_page_public(p_token text, p_from date default null, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_page public.booking_pages;
  v_state text;
  v_zone text;
  v_today date;
  v_from date;
  v_result jsonb;
  v_bucket integer;
  v_views integer;
begin
  select * into v_page from public.booking_pages b where b.token = coalesce(p_token, '');
  v_state := app.booking_page_state(v_page);
  if v_state = 'not_found' then
    raise exception 'booking page not found' using errcode = 'P0002';
  end if;
  -- read only or suspended, or closed for an hour after too many failed attempts: "not available now"
  if v_state = 'unavailable'
     or exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
    return jsonb_build_object('unavailable', true);
  end if;

  -- view limit (FXS-11 style): 60 per sender in 10 minutes, then "try again later" without working out any times.
  -- Views never close a page (owner, 15 October 2026). The view is counted first and the returned count decides, so
  -- the limit is exact under parallel load; the only lock is the bucket's row (one sender, or the rare senders that
  -- share its bucket). A view without a sender hash is not counted.
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(p_ip_hash, 0) % 1024) + 1024) % 1024;
    insert into app.booking_view_counts as vc (page_id, bucket, window_start, views)
    values (v_page.id, v_bucket, now(), 1)
    on conflict (page_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_page.organization_id;
  v_today := (now() at time zone v_zone)::date;
  v_from := least(greatest(coalesce(p_from, v_today), v_today), v_today + v_page.max_days_ahead);

  -- only what the page shows: no ids, no contact details of the rep or the business
  select jsonb_build_object(
           'title', v_page.title,
           'intro', v_page.intro,
           'business', o.name,
           'rep', coalesce(nullif(btrim(p.full_name), ''), o.name),
           'brand', jsonb_build_object('logo', o.logo_path, 'color', o.brand_color),
           'built_with', app.show_built_with(o.id),
           'time_zone', v_zone,
           'meeting', jsonb_build_object('name', t.name, 'duration_minutes', t.duration_minutes,
                                         'format', coalesce(t.meeting_format, 'in_person'), 'location', t.location),
           'questions', v_page.questions,
           'today', v_today,
           'last_day', v_today + v_page.max_days_ahead,
           'from', v_from,
           'slots', coalesce((select jsonb_agg(s order by s) from app.booking_slots(v_page.id, v_from, 7) s), '[]'::jsonb))
    into v_result
    from public.organizations o
    join public.meeting_types t on t.organization_id = o.id and t.id = v_page.meeting_type_id
    left join public.profiles p on p.id = v_page.user_id
   where o.id = v_page.organization_id;

  return v_result;
end;
$$;
revoke all on function public.booking_page_public(text, date, text) from public, anon, authenticated;
grant execute on function public.booking_page_public(text, date, text) to service_role;

-- ----------------------------------------------------------------------------
-- Booking one slot
-- ----------------------------------------------------------------------------
-- After a refused attempt: 200 failed attempts on the page within an hour close it for an hour, and one
-- `system` notice goes to the page's rep and the business's active owners (called under the page's lock).
create or replace function app.booking_page_close_check(p_page public.booking_pages) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if (select count(*) from app.booking_requests r
       where r.page_id = p_page.id and r.outcome = 'refused' and r.created_at > now() - interval '1 hour') < 200 then
    return;
  end if;
  insert into app.booking_page_closures as c (page_id, organization_id, closed_until)
  values (p_page.id, p_page.organization_id, now() + interval '1 hour')
  on conflict (page_id) do update set closed_until = excluded.closed_until, created_at = now()
   where c.closed_until <= now();
  if not found then
    return;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body)
  select p_page.organization_id, u.user_id, 'system', 'דף קביעת תור נסגר לשעה',
         left('הדף "' || p_page.title || '" קיבל הרבה ניסיונות קביעה שנכשלו בזמן קצר, ולכן נסגר לשעה. '
              || 'אחרי שעה הוא ייפתח שוב מעצמו.', 1000)
    from (select p_page.user_id as user_id
          union
          select m.user_id from public.memberships m
           where m.organization_id = p_page.organization_id and m.role = 'owner' and m.status = 'active') u;
end;
$$;
revoke all on function app.booking_page_close_check(public.booking_pages) from public, anon, authenticated, service_role;

create or replace function public.booking_submit(
  p_token      text,
  p_starts_at  timestamptz,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_page public.booking_pages;
  v_state text;
  v_type public.meeting_types;
  v_zone text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_answers_in jsonb := case when jsonb_typeof(p_payload -> 'answers') = 'object' then p_payload -> 'answers' else '{}'::jsonb end;
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  v_phone_e164 text;
  v_question jsonb;
  v_answer text;
  v_lines text[] := '{}';
  v_lead uuid;
  v_contact uuid;
  v_status uuid;
  v_meeting uuid;
  v_ends_at timestamptz;
  v_rep text;
  v_new_lead boolean := false;
  v_source uuid;
begin
  select * into v_page from public.booking_pages b where b.token = coalesce(p_token, '');
  v_state := app.booking_page_state(v_page);
  if v_state = 'not_found' then
    raise exception 'booking page not found' using errcode = 'P0002';
  end if;
  if v_state = 'unavailable' then
    raise exception 'booking is not available' using errcode = 'P0001', hint = 'booking:unavailable';
  end if;

  -- one attempt at a time per page, so a burst in parallel meets the counts (review of 15 October 2026)
  perform pg_advisory_xact_lock(hashtextextended('booking_submit:' || v_page.id::text, 0));
  -- closed for an hour after too many failed attempts (owner, 15 October 2026)
  if exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
    raise exception 'the page is closed for now' using errcode = 'P0001', hint = 'booking:closed';
  end if;
  -- per sender 5 attempts in 10 minutes (spam included)
  if p_ip_hash is not null and (
    select count(*) from app.booking_requests r
     where r.page_id = v_page.id and r.ip_hash = p_ip_hash and r.created_at > now() - interval '10 minutes'
  ) >= 5 then
    raise exception 'too many attempts' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
    values (v_page.id, v_page.organization_id, p_ip_hash, 'spam');
    return jsonb_build_object('status', 'spam');
  end if;

  -- the person and the answers
  v_phone_e164 := app.normalize_phone(v_phone);
  if v_full_name is null then
    raise exception 'a name is required' using errcode = '22023', hint = 'booking:full_name';
  end if;
  if v_phone_e164 is null then
    raise exception 'a valid phone is required' using errcode = '22023', hint = 'booking:phone';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023', hint = 'booking:email';
  end if;
  for v_question in select value from jsonb_array_elements(v_page.questions) loop
    v_answer := case when jsonb_typeof(v_answers_in -> (v_question ->> 'id')) = 'string'
                     then nullif(left(btrim(v_answers_in ->> (v_question ->> 'id')), 1000), '') end;
    if v_answer is null and (v_question -> 'required') = 'true'::jsonb then
      raise exception 'an answer is required' using errcode = '22023', hint = 'booking:answer';
    end if;
    if v_answer is not null then
      v_lines := v_lines || ((v_question ->> 'label') || ': ' || v_answer);
    end if;
  end loop;

  -- one booking at a time per rep, then the slot must still be free
  perform pg_advisory_xact_lock(hashtextextended('booking:' || v_page.organization_id::text || ':' || v_page.user_id::text, 0));
  select * into v_type from public.meeting_types t where t.organization_id = v_page.organization_id and t.id = v_page.meeting_type_id;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_page.organization_id;
  -- A time the page would not offer even with no meeting at all (null, off the grid, outside the window or the hours,
  -- in the past) is answered invalid_time and counts per sender only. A time taken by a meeting made in the last hour
  -- is a real race: answered slot_taken and counted toward closing the page. A time taken by an older meeting was
  -- never offered free: answered slot_taken, counted per sender only (review of 15 October 2026). All are answered,
  -- not raised, so the attempt stays counted.
  if p_starts_at is null or not exists (
    select 1 from app.booking_slots(v_page.id, (p_starts_at at time zone v_zone)::date, 1, '-infinity') s where s = p_starts_at) then
    insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
    values (v_page.id, v_page.organization_id, p_ip_hash, 'invalid');
    return jsonb_build_object('status', 'invalid_time');
  end if;
  if not exists (
    select 1 from app.booking_slots(v_page.id, (p_starts_at at time zone v_zone)::date, 1) s where s = p_starts_at) then
    -- a race counts once per start time an hour: re-posts of a time already counted are logged as invalid, so
    -- closing a page takes about 200 different real races, not one booking and 200 re-posts (final review)
    if exists (select 1 from app.booking_slots(v_page.id, (p_starts_at at time zone v_zone)::date, 1, now() - interval '1 hour') s
                where s = p_starts_at)
       and not exists (select 1 from app.booking_requests r
                        where r.page_id = v_page.id and r.outcome = 'refused' and r.starts_at = p_starts_at
                          and r.created_at > now() - interval '1 hour') then
      insert into app.booking_requests (page_id, organization_id, ip_hash, outcome, starts_at)
      values (v_page.id, v_page.organization_id, p_ip_hash, 'refused', p_starts_at);
      perform app.booking_page_close_check(v_page);
    else
      insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
      values (v_page.id, v_page.organization_id, p_ip_hash, 'invalid');
    end if;
    return jsonb_build_object('status', 'slot_taken');
  end if;
  v_ends_at := p_starts_at + make_interval(mins => v_type.duration_minutes);

  -- linked by phone: a live lead (and the contact it became), else a contact (CON-01: any of its phones)
  select l.id, l.converted_contact_id into v_lead, v_contact
    from public.leads l
   where l.organization_id = v_page.organization_id and l.deleted_at is null and l.phone_e164 = v_phone_e164
   order by l.created_at desc
   limit 1;
  -- the contact the lead became, unless it is in the recycle bin
  if v_contact is not null and not exists (select 1 from public.contacts c
                                            where c.organization_id = v_page.organization_id and c.id = v_contact
                                              and c.deleted_at is null) then
    v_contact := null;
  end if;
  if v_lead is null then
    select c.id into v_contact
      from public.contacts c
     where c.organization_id = v_page.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_page.organization_id and c2.phone_e164 = v_phone_e164
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_page.organization_id and ch.value_e164 = v_phone_e164)
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead is null and v_contact is null then
    select s.id into v_status from public.lead_statuses s
     where s.organization_id = v_page.organization_id and s.kind = 'open'
     order by s.is_default desc, s.position
     limit 1;
    if v_status is null then
      raise exception 'the organization has no open lead status' using errcode = 'P0001';
    end if;
    -- the page's source, else "דף קביעת תור" from the lead sources list (made once when missing)
    v_source := v_page.source_id;
    if v_source is null then
      -- one find-or-create at a time per business, so two bookings never make the source twice
      perform pg_advisory_xact_lock(hashtextextended('booking_source:' || v_page.organization_id::text, 0));
      select s.id into v_source from public.lead_sources s
       where s.organization_id = v_page.organization_id
         and (s.kind = 'booking' or btrim(s.name) = 'דף קביעת תור')
       order by s.is_active desc, (s.kind = 'booking') desc, s.created_at
       limit 1;
      if v_source is null then
        insert into public.lead_sources (organization_id, name, kind)
        values (v_page.organization_id, 'דף קביעת תור', 'booking')
        returning id into v_source;
      end if;
    end if;
    perform set_config('app.intake', 'on', true);
    insert into public.leads (organization_id, status_id, source_id, owner_id,
                              full_name, phone, email,
                              campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid)
    values (v_page.organization_id, v_status, v_source, v_page.user_id,
            v_full_name, v_phone, v_email,
            coalesce(v_attr ->> 'utm_campaign', v_page.title),
            jsonb_strip_nulls(jsonb_build_object(
              'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
              'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
              'utm_content', v_attr -> 'utm_content', 'extra', v_attr -> 'extra')),
            v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
            v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid')
    returning id into v_lead;
    perform set_config('app.intake', '', true);
    v_new_lead := true;
  end if;

  insert into public.meetings (organization_id, title, meeting_type, meeting_type_id, starts_at, ends_at,
                               location, description, owner_id, lead_id, contact_id)
  values (v_page.organization_id,
          left(v_type.name || ': ' || v_full_name, 300),
          coalesce(v_type.meeting_format, 'in_person'),
          v_type.id, p_starts_at, v_ends_at,
          v_type.location,
          left(array_to_string(array['נקבעה בדף קביעת התור "' || v_page.title || '".'] || v_lines, chr(10)), 5000),
          v_page.user_id, v_lead, v_contact)
  returning id into v_meeting;

  -- an existing record: the booking on its timeline (a new lead's own row says it)
  if not v_new_lead then
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (v_page.organization_id, 'inquiry', null, v_lead, v_contact,
            jsonb_build_object('booking_page_id', v_page.id, 'booking_page_title', v_page.title, 'meeting_id', v_meeting,
                               'full_name', v_full_name, 'phone', v_phone, 'email', v_email));
  end if;

  insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
  values (v_page.id, v_page.organization_id, p_ip_hash, 'booked');

  select coalesce(nullif(btrim(p.full_name), ''), o.name) into v_rep
    from public.organizations o left join public.profiles p on p.id = v_page.user_id
   where o.id = v_page.organization_id;
  -- only what the confirmation shows
  return jsonb_build_object(
    'status', 'booked',
    'starts_at', p_starts_at,
    'ends_at', v_ends_at,
    'time_zone', v_zone,
    'meeting', jsonb_build_object('name', v_type.name, 'format', coalesce(v_type.meeting_format, 'in_person'), 'location', v_type.location),
    'rep', v_rep);
end;
$$;
revoke all on function public.booking_submit(text, timestamptz, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.booking_submit(text, timestamptz, jsonb, text, text, boolean) to service_role;

notify pgrst, 'reload schema';
