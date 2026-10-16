-- =============================================================================
-- 0201 Booking: the customer's personal link to cancel or change (CAL-10b)
-- =============================================================================
-- Owner, 15 October 2026: "קישור אישי סודי לביטול ולשינוי, בדפוס הקישורים הסודיים. סף ברירת מחדל 24 שעות, לכל דף
-- 0–72. מתחת לסף: 'לביטול יש להתקשר' עם טלפון העסק. שינוי = ביטול + קביעה חדשה. הביטול מתועד ומודיע לנציג."
--
-- * booking_submit (redefined: the CAL-10 body with the refusal moved into app.booking_refusal) also makes a
--   personal link for the new meeting and answers its token once, in the confirmation. Only the SHA-256 of the
--   token is kept, in app.booking_manage_links (one per meeting, cascades with it), like app.calendar_feeds.
-- * booking_pages.cancel_notice_hours (0..72, default 24): up to how many hours before the start the customer may
--   cancel or change online. Later (or once the meeting started, or it is not planned) the page says "לביטול יש
--   להתקשר" with the business's phone (organizations.phone), only when it is set.
-- * The approved pattern for secret-link pages (hard rule 5): a server route calls one security definer function per
--   action, granted to service_role only, which checks the token and does only what the page needs:
--   - public.booking_manage_public(token, from, ip_hash): the meeting's time, type (name, format, location) and rep,
--     the business's name and brand, what may be done, and, when a change is possible, the free times of a week of
--     the page (the meeting itself never blocks them). No ids, no notes, no customer details.
--   - public.booking_manage_cancel(token, ip_hash): cancels the meeting, records it on its lead's or contact's
--     timeline (a `system` entry) and tells the rep (new kind meeting_cancelled, mutable like meeting_scheduled).
--   - public.booking_manage_change(token, starts_at, ip_hash): a cancel plus a new booking of the same page, through
--     the same slots, refusals and limits as booking_submit; the new meeting keeps the lead/contact, title and notes,
--     gets its own link (answered once), and the old link then shows "cancelled".
--   Not found (P0002): no such token, the meeting gone, or the business closed (app.org_public_pages_open). A
--   read-only business: {"unavailable": true}.
-- * Limits as CAL-10: views per sender in the page's view counters (60 in 10 minutes); cancel and change attempts per
--   sender in app.booking_requests (5 in 10 minutes, with the page's bookings), new outcomes 'cancelled' and 'changed'.
-- * app.booking_slots gets p_ignore_meeting (the meeting being moved). Its old signature is renamed and closed off
--   first (one function, never two overloads), like RPT-02.
-- * Senders (review of CAL-10b): the server sends one keyed hash of the address for every booking page and link; the
--   database scopes it to the page (app.booking_sender), so a visitor is a different sender on every page and business,
--   and a page's bookings, views, cancels and changes count against the same sender (booking_page_public is redefined
--   for that line only).
-- * A cancel tells the organizer and the active participants (meeting_cancelled). A change carries the participants
--   onto the new meeting and tells the old and new organizer and the participants once ("moved"); the usual
--   meeting_scheduled notices are held back while it runs (app.booking_moving, honoured by
--   app.notify_meeting_organizer and app.notify_meeting_participant, both redefined here for that line only).
-- No drop statement, no delete. Safe to run twice.

-- ----------------------------------------------------------------------------
-- The new notification kind (shared ground, cleared for this branch): kept in step with
-- src/features/notifications/settings.ts (unit test).
-- ----------------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_kinds,
  add constraint notifications_kinds check (type in (
    'system', 'assigned', 'task_reminder', 'inquiry', 'automation',
    'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
    'automation_failed', 'quote', 'payment', 'response_overdue'));

alter table public.notification_settings
  drop constraint if exists notification_settings_kinds,
  add constraint notification_settings_kinds check (
    muted <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                   'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                   'automation_failed', 'quote', 'payment', 'response_overdue']
    and no_push <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                         'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                         'automation_failed', 'quote', 'payment', 'response_overdue']);

-- ----------------------------------------------------------------------------
-- A page's sender: the server's keyed hash of the address, scoped to the page (null stays null)
-- ----------------------------------------------------------------------------
create or replace function app.booking_sender(p_page uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_page is null then null
              else encode(sha256(convert_to(p_page::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.booking_sender(uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The meeting notices: none of the usual ones while a customer's change runs (CAL-10b); the bodies of 0068 and 020065
-- ----------------------------------------------------------------------------
create or replace function app.notify_meeting_organizer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_notice record;
begin
  if new.owner_id is null or new.owner_id is not distinct from auth.uid() then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.owner_id is not distinct from old.owner_id then
    return null;
  end if;
  if current_setting('app.bulk_transfer', true) = 'on' then
    return null;
  end if;
  -- CAL-10b: a meeting moved by the customer through their personal link sends one "moved" notice instead
  if current_setting('app.booking_moving', true) = 'on' then
    return null;
  end if;
  select * into v_notice from app.meeting_notice(new.organization_id, new.id, new.owner_id);
  if not coalesce(v_notice.notify, false) then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (new.organization_id, new.owner_id, 'meeting_scheduled', v_notice.title, v_notice.body, 'meeting', new.id);
  return null;
end;
$$;


create or replace function app.notify_meeting_participant() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_notice record;
  v_series uuid;
  v_count integer;
begin
  if new.user_id is not distinct from auth.uid() then
    return null;
  end if;
  -- CAL-10b: a meeting moved by the customer through their personal link sends one "moved" notice instead
  if current_setting('app.booking_moving', true) = 'on' then
    return null;
  end if;
  -- a suspended member is not told
  if not exists (select 1 from public.memberships m
                  where m.organization_id = new.organization_id and m.user_id = new.user_id and m.status = 'active') then
    return null;
  end if;
  -- CAL-09: one notice per series while it is unread and new
  select mt.series_id into v_series
    from public.meetings mt
   where mt.organization_id = new.organization_id and mt.id = new.meeting_id;
  if v_series is not null and exists (
    select 1 from public.notifications n
      join public.meetings m on m.organization_id = n.organization_id and m.id = n.entity_id
     where n.organization_id = new.organization_id and n.user_id = new.user_id
       and n.type = 'meeting_scheduled' and n.entity_type = 'meeting' and n.read_at is null
       -- review of CAL-09: only a notice of the last 15 minutes (the series was just made); a separate
       -- invitation to the series later is told
       and n.created_at > now() - interval '15 minutes'
       and m.series_id = v_series and m.id <> new.meeting_id) then
    return null;
  end if;
  select * into v_notice from app.meeting_notice(new.organization_id, new.meeting_id, new.user_id);
  if not coalesce(v_notice.notify, false) then
    return null;
  end if;
  if v_series is not null and current_setting('app.meeting_series_creating', true) = v_series::text then
    select count(*) into v_count from public.meetings m
     where m.organization_id = new.organization_id and m.series_id = v_series;
    v_notice.body := v_notice.body || ' · סדרה של ' || v_count || ' פגישות';
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (new.organization_id, new.user_id, 'meeting_scheduled', v_notice.title, v_notice.body, 'meeting', new.meeting_id);
  return null;
end;
$$;


-- ----------------------------------------------------------------------------
-- The page's threshold
-- ----------------------------------------------------------------------------
alter table public.booking_pages
  add column if not exists cancel_notice_hours smallint not null default 24;
alter table public.booking_pages
  drop constraint if exists booking_pages_cancel_notice_hours,
  add constraint booking_pages_cancel_notice_hours check (cancel_notice_hours between 0 and 72);
grant insert (cancel_notice_hours), update (cancel_notice_hours) on public.booking_pages to authenticated;

-- ----------------------------------------------------------------------------
-- Attempts: cancels and changes count per sender with the page's bookings
-- ----------------------------------------------------------------------------
alter table app.booking_requests
  drop constraint if exists booking_requests_outcome_check,
  add constraint booking_requests_outcome_check check (outcome in ('booked', 'spam', 'refused', 'invalid', 'cancelled', 'changed'));

-- ----------------------------------------------------------------------------
-- The personal links: the hash only, one per meeting
-- ----------------------------------------------------------------------------
create table if not exists app.booking_manage_links (
  token_hash      text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null,
  meeting_id      uuid not null,
  page_id         uuid not null,
  created_at      timestamptz not null default now(),
  unique (meeting_id),
  constraint booking_manage_links_meeting_fk foreign key (organization_id, meeting_id)
    references public.meetings (organization_id, id) on delete cascade
);
alter table app.booking_manage_links enable row level security;
revoke all on app.booking_manage_links from public, anon, authenticated, service_role;

-- A new link for a meeting: 64 hex characters, answered once; only the hash is stored.
create or replace function app.booking_manage_issue(p_org uuid, p_meeting uuid, p_page uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into app.booking_manage_links (token_hash, organization_id, meeting_id, page_id)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_org, p_meeting, p_page);
  return v_token;
end;
$$;
revoke all on function app.booking_manage_issue(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.booking_slots: the meeting being moved never blocks (CAL-10b). The old signature steps aside first.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('app.booking_slots(uuid, date, integer, timestamptz)') is not null then
    alter function app.booking_slots(uuid, date, integer, timestamptz) rename to booking_slots_020100_retired;
    revoke all on function app.booking_slots_020100_retired(uuid, date, integer, timestamptz)
      from public, anon, authenticated, service_role;
  end if;
end;
$$;

create or replace function app.booking_slots(p_page_id uuid, p_from date, p_days integer, p_ignore_since timestamptz default null,
                                             p_ignore_meeting uuid default null)
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
          -- CAL-10b: the meeting being moved never blocks its own new time
          and (p_ignore_meeting is null or mt.id <> p_ignore_meeting)
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
revoke all on function app.booking_slots(uuid, date, integer, timestamptz, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- A time that cannot be booked (CAL-10's rule, shared by booking_submit and booking_manage_change): null when the
-- time is free. A time the page would not offer even with no meeting at all is invalid_time (counts per sender
-- only); a time taken by a meeting made in the last hour is a real race, counted once per start time toward
-- closing the page; a time an older meeting holds was never offered free (per sender only).
-- ----------------------------------------------------------------------------
create or replace function app.booking_refusal(p_page public.booking_pages, p_starts_at timestamptz, p_ip_hash text,
                                               p_zone text, p_ignore_meeting uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_starts_at is null or not exists (
    select 1 from app.booking_slots(p_page.id, (p_starts_at at time zone p_zone)::date, 1, '-infinity', p_ignore_meeting) s
     where s = p_starts_at) then
    insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
    values (p_page.id, p_page.organization_id, p_ip_hash, 'invalid');
    return jsonb_build_object('status', 'invalid_time');
  end if;
  if not exists (
    select 1 from app.booking_slots(p_page.id, (p_starts_at at time zone p_zone)::date, 1, null, p_ignore_meeting) s
     where s = p_starts_at) then
    if exists (select 1 from app.booking_slots(p_page.id, (p_starts_at at time zone p_zone)::date, 1, now() - interval '1 hour',
                                               p_ignore_meeting) s
                where s = p_starts_at)
       and not exists (select 1 from app.booking_requests r
                        where r.page_id = p_page.id and r.outcome = 'refused' and r.starts_at = p_starts_at
                          and r.created_at > now() - interval '1 hour') then
      insert into app.booking_requests (page_id, organization_id, ip_hash, outcome, starts_at)
      values (p_page.id, p_page.organization_id, p_ip_hash, 'refused', p_starts_at);
      perform app.booking_page_close_check(p_page);
    else
      insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
      values (p_page.id, p_page.organization_id, p_ip_hash, 'invalid');
    end if;
    return jsonb_build_object('status', 'slot_taken');
  end if;
  return null;
end;
$$;
revoke all on function app.booking_refusal(public.booking_pages, timestamptz, text, text, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- booking_page_public: 020080's body with the sender scoped to the page
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
  -- the sender's hash, scoped to this page (CAL-10b review): the same visitor is a different sender on every page
  p_ip_hash := app.booking_sender(v_page.id, p_ip_hash);
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
-- booking_submit: CAL-10's body (020080), the refusal through app.booking_refusal, and the personal link
-- ----------------------------------------------------------------------------
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
  v_refusal jsonb;
begin
  select * into v_page from public.booking_pages b where b.token = coalesce(p_token, '');
  p_ip_hash := app.booking_sender(v_page.id, p_ip_hash);
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
  -- invalid_time / slot_taken as in CAL-10 (app.booking_refusal; answered, not raised, so the attempt stays counted)
  v_refusal := app.booking_refusal(v_page, p_starts_at, p_ip_hash, v_zone, null);
  if v_refusal is not null then
    return v_refusal;
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
  -- only what the confirmation shows, and the personal link to cancel or change (CAL-10b; only its hash is kept)
  return jsonb_build_object(
    'status', 'booked',
    'starts_at', p_starts_at,
    'ends_at', v_ends_at,
    'time_zone', v_zone,
    'meeting', jsonb_build_object('name', v_type.name, 'format', coalesce(v_type.meeting_format, 'in_person'), 'location', v_type.location),
    'rep', v_rep,
    'manage_token', app.booking_manage_issue(v_page.organization_id, v_meeting, v_page.id));
end;
$$;
revoke all on function public.booking_submit(text, timestamptz, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.booking_submit(text, timestamptz, jsonb, text, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- The link's meeting, page and threshold
-- ----------------------------------------------------------------------------
-- The link of a token (64 hex), or nothing.
create or replace function app.booking_manage_link(p_token text) returns app.booking_manage_links
language sql stable security definer
set search_path = ''
as $$
  select l.* from app.booking_manage_links l
   where coalesce(p_token, '') ~ '^[0-9a-f]{64}$'
     and l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;
revoke all on function app.booking_manage_link(text) from public, anon, authenticated, service_role;

-- May the customer still cancel or change online: a planned meeting that starts more than the page's threshold from
-- now (24 hours when the page is gone).
create or replace function app.booking_manage_open(p_meeting public.meetings, p_hours integer) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_meeting.status = 'planned'
     and p_meeting.starts_at > now() + make_interval(hours => coalesce(p_hours, 24))
$$;
revoke all on function app.booking_manage_open(public.meetings, integer) from public, anon, authenticated, service_role;

-- The cancel: the meeting cancelled, a `system` entry on its lead's / contact's timeline, its organizer and active
-- participants told once each (meeting_cancelled; muting follows their settings). A change passes the new time and the
-- new organizer (the page's rep now), who is told too; only active members are told.
create or replace function app.booking_manage_cancel_meeting(p_meeting public.meetings, p_moved_to timestamptz,
                                                             p_new_owner uuid default null) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_when text;
  v_to text;
begin
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_meeting.organization_id;
  v_when := to_char(p_meeting.starts_at at time zone v_zone, 'DD.MM.YYYY HH24:MI');
  v_to := to_char(p_moved_to at time zone v_zone, 'DD.MM.YYYY HH24:MI');
  update public.meetings m set status = 'cancelled'
   where m.organization_id = p_meeting.organization_id and m.id = p_meeting.id;
  if p_meeting.lead_id is not null or p_meeting.contact_id is not null then
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (p_meeting.organization_id, 'system',
            case when p_moved_to is null
                 then 'הפגישה של ' || v_when || ' בוטלה על ידי הלקוח בקישור האישי.'
                 else 'הלקוח העביר בקישור האישי את הפגישה של ' || v_when || ' ל-' || v_to || '.' end,
            p_meeting.lead_id, p_meeting.contact_id,
            jsonb_build_object('kind', case when p_moved_to is null then 'booking_cancelled' else 'booking_changed' end,
                               'meeting_id', p_meeting.id));
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select p_meeting.organization_id, m.user_id, 'meeting_cancelled',
         left(case when p_moved_to is null then 'הלקוח ביטל פגישה: ' else 'הלקוח העביר פגישה: ' end || p_meeting.title, 200),
         case when p_moved_to is null then v_when else v_when || ' ← ' || v_to end,
         'meeting', p_meeting.id
    from public.memberships m
   where m.organization_id = p_meeting.organization_id and m.status = 'active'
     and m.user_id in (select p_meeting.owner_id
                       union
                       select p_new_owner
                       union
                       select mp.user_id from public.meeting_participants mp
                        where mp.organization_id = p_meeting.organization_id and mp.meeting_id = p_meeting.id);
end;
$$;
revoke all on function app.booking_manage_cancel_meeting(public.meetings, timestamptz, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The personal page
-- ----------------------------------------------------------------------------
create or replace function public.booking_manage_public(p_token text, p_from date default null, p_ip_hash text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.booking_manage_links;
  v_meeting public.meetings;
  v_page public.booking_pages;
  v_zone text;
  v_today date;
  v_from date;
  v_hours integer;
  v_open boolean;
  v_change jsonb;
  v_status text;
  v_bucket integer;
  v_views integer;
  v_result jsonb;
begin
  v_link := app.booking_manage_link(p_token);
  p_ip_hash := app.booking_sender(v_link.page_id, p_ip_hash);
  select * into v_meeting from public.meetings m where m.organization_id = v_link.organization_id and m.id = v_link.meeting_id;
  if v_meeting.id is null or not app.org_public_pages_open(v_meeting.organization_id) then
    raise exception 'booking link not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_meeting.organization_id) then
    return jsonb_build_object('unavailable', true);
  end if;
  -- the view limit of the page (CAL-10): 60 per sender in 10 minutes, counted first
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(p_ip_hash, 0) % 1024) + 1024) % 1024;
    insert into app.booking_view_counts as vc (page_id, bucket, window_start, views)
    values (v_link.page_id, v_bucket, now(), 1)
    on conflict (page_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_page from public.booking_pages b where b.organization_id = v_meeting.organization_id and b.id = v_link.page_id;
  v_hours := coalesce(v_page.cancel_notice_hours, 24);
  v_open := app.booking_manage_open(v_meeting, v_hours);
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_meeting.organization_id;
  v_status := case when v_meeting.status = 'planned' and v_meeting.ends_at <= now() then 'past'
                   when v_meeting.status = 'planned' then 'planned'
                   when v_meeting.status = 'cancelled' then 'cancelled'
                   else 'past' end;

  -- a change: the page still open and not closed for the hour; a week of its times, the meeting itself not blocking
  if v_open and v_page.id is not null and app.booking_page_state(v_page) = 'open'
     and not exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
    v_today := (now() at time zone v_zone)::date;
    v_from := least(greatest(coalesce(p_from, v_today), v_today), v_today + v_page.max_days_ahead);
    v_change := jsonb_build_object(
      'today', v_today,
      'last_day', v_today + v_page.max_days_ahead,
      'from', v_from,
      'slots', coalesce((select jsonb_agg(s order by s)
                           from app.booking_slots(v_page.id, v_from, 7, null, v_meeting.id) s
                          where s <> v_meeting.starts_at), '[]'::jsonb));
  end if;

  -- only what the page shows: no ids, no notes, nothing of the customer
  select jsonb_build_object(
           'status', v_status,
           'starts_at', v_meeting.starts_at,
           'ends_at', v_meeting.ends_at,
           'time_zone', v_zone,
           'meeting', jsonb_build_object('name', coalesce(t.name, 'פגישה'),
                                         'format', coalesce(v_meeting.meeting_type, 'in_person'),
                                         'location', v_meeting.location),
           'rep', coalesce(nullif(btrim(p.full_name), ''), o.name),
           'business', o.name,
           'brand', jsonb_build_object('logo', o.logo_path, 'color', o.brand_color),
           'built_with', app.show_built_with(o.id),
           'notice_hours', v_hours,
           'can_cancel', v_open,
           -- too late to do it here: call the business, when its phone is set
           'call_phone', case when v_status = 'planned' and not v_open then nullif(btrim(o.phone), '') end,
           'change', v_change)
    into v_result
    from public.organizations o
    left join public.meeting_types t on t.organization_id = o.id and t.id = v_meeting.meeting_type_id
    left join public.profiles p on p.id = v_meeting.owner_id
   where o.id = v_meeting.organization_id;
  return v_result;
end;
$$;
revoke all on function public.booking_manage_public(text, date, text) from public, anon, authenticated;
grant execute on function public.booking_manage_public(text, date, text) to service_role;

-- ----------------------------------------------------------------------------
-- Cancel and change
-- ----------------------------------------------------------------------------
-- What both start with: the link, the meeting locked, the sender's limit, the threshold. Raises the answer to give.
create or replace function app.booking_manage_begin(p_token text, p_ip_hash text, out link app.booking_manage_links,
                                                    out meeting public.meetings, out page public.booking_pages, out sender text)
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  link := app.booking_manage_link(p_token);
  sender := app.booking_sender(link.page_id, p_ip_hash);
  select * into meeting from public.meetings m
   where m.organization_id = link.organization_id and m.id = link.meeting_id
   for update;
  if meeting.id is null or not app.org_public_pages_open(meeting.organization_id) then
    raise exception 'booking link not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(meeting.organization_id) then
    raise exception 'booking is not available' using errcode = 'P0001', hint = 'booking:unavailable';
  end if;
  -- the page's lock, as booking_submit, so a burst in parallel meets the counts
  perform pg_advisory_xact_lock(hashtextextended('booking_submit:' || link.page_id::text, 0));
  if sender is not null and (
    select count(*) from app.booking_requests r
     where r.page_id = link.page_id and r.ip_hash = sender and r.created_at > now() - interval '10 minutes'
  ) >= 5 then
    raise exception 'too many attempts' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  select * into page from public.booking_pages b where b.organization_id = meeting.organization_id and b.id = link.page_id;
  if meeting.status = 'planned' and not app.booking_manage_open(meeting, page.cancel_notice_hours) then
    raise exception 'too late to change online' using errcode = 'P0001', hint = 'booking:too_late';
  end if;
end;
$$;
revoke all on function app.booking_manage_begin(text, text) from public, anon, authenticated, service_role;

create or replace function public.booking_manage_cancel(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_begin record;
begin
  v_begin := app.booking_manage_begin(p_token, p_ip_hash);
  -- once is enough: a second cancel answers the same and tells no one again
  if (v_begin.meeting).status = 'cancelled' then
    return jsonb_build_object('status', 'cancelled');
  end if;
  if (v_begin.meeting).status <> 'planned' then
    raise exception 'the meeting is over' using errcode = 'P0001', hint = 'booking:too_late';
  end if;
  perform app.booking_manage_cancel_meeting(v_begin.meeting, null);
  insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
  values ((v_begin.link).page_id, (v_begin.link).organization_id, v_begin.sender, 'cancelled');
  return jsonb_build_object('status', 'cancelled');
end;
$$;
revoke all on function public.booking_manage_cancel(text, text) from public, anon, authenticated;
grant execute on function public.booking_manage_cancel(text, text) to service_role;

create or replace function public.booking_manage_change(p_token text, p_starts_at timestamptz, p_ip_hash text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_begin record;
  v_page public.booking_pages;
  v_old public.meetings;
  v_type public.meeting_types;
  v_zone text;
  v_refusal jsonb;
  v_meeting uuid;
  v_ends_at timestamptz;
  v_rep text;
begin
  v_begin := app.booking_manage_begin(p_token, p_ip_hash);
  v_old := v_begin.meeting;
  v_page := v_begin.page;
  if v_old.status <> 'planned' then
    raise exception 'the meeting cannot be changed' using errcode = 'P0001', hint = 'booking:too_late';
  end if;
  -- the page must still take bookings, as booking_submit
  if v_page.id is null or app.booking_page_state(v_page) <> 'open' then
    raise exception 'booking is not available' using errcode = 'P0001', hint = 'booking:unavailable';
  end if;
  if exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
    raise exception 'the page is closed for now' using errcode = 'P0001', hint = 'booking:closed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('booking:' || v_page.organization_id::text || ':' || v_page.user_id::text, 0));
  select * into v_type from public.meeting_types t where t.organization_id = v_page.organization_id and t.id = v_page.meeting_type_id;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_page.organization_id;
  v_refusal := app.booking_refusal(v_page, p_starts_at, v_begin.sender, v_zone, v_old.id);
  if v_refusal is not null then
    return v_refusal;
  end if;
  v_ends_at := p_starts_at + make_interval(mins => v_type.duration_minutes);

  perform app.booking_manage_cancel_meeting(v_old, p_starts_at, v_page.user_id);
  -- the "moved" notice above is the only one: no meeting_scheduled for the new meeting or its participants
  perform set_config('app.booking_moving', 'on', true);
  insert into public.meetings (organization_id, title, meeting_type, meeting_type_id, starts_at, ends_at,
                               location, description, owner_id, lead_id, contact_id)
  values (v_page.organization_id, v_old.title, coalesce(v_type.meeting_format, 'in_person'), v_type.id,
          p_starts_at, v_ends_at, v_type.location,
          left(coalesce(v_old.description || chr(10), '') || 'הועברה בקישור האישי מ-'
               || to_char(v_old.starts_at at time zone v_zone, 'DD.MM.YYYY HH24:MI') || '.', 5000),
          v_page.user_id, v_old.lead_id, v_old.contact_id)
  returning id into v_meeting;
  -- the participants come along (the new organizer is not their own participant)
  insert into public.meeting_participants (organization_id, meeting_id, user_id, created_by)
  select mp.organization_id, v_meeting, mp.user_id, mp.created_by
    from public.meeting_participants mp
   where mp.organization_id = v_old.organization_id and mp.meeting_id = v_old.id and mp.user_id <> v_page.user_id;
  perform set_config('app.booking_moving', '', true);
  insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
  values (v_page.id, v_page.organization_id, v_begin.sender, 'changed');

  select coalesce(nullif(btrim(p.full_name), ''), o.name) into v_rep
    from public.organizations o left join public.profiles p on p.id = v_page.user_id
   where o.id = v_page.organization_id;
  return jsonb_build_object(
    'status', 'booked',
    'starts_at', p_starts_at,
    'ends_at', v_ends_at,
    'time_zone', v_zone,
    'meeting', jsonb_build_object('name', v_type.name, 'format', coalesce(v_type.meeting_format, 'in_person'), 'location', v_type.location),
    'rep', v_rep,
    'manage_token', app.booking_manage_issue(v_page.organization_id, v_meeting, v_page.id));
end;
$$;
revoke all on function public.booking_manage_change(text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.booking_manage_change(text, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
