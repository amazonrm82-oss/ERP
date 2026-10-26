-- =============================================================================
-- Subprocessors managed from the platform panel (ADM-01, the remaining part)
-- =============================================================================
-- SPEC 13 ("רשימת קבלני משנה: עמוד ציבורי עם כל ספק שנוגע בנתונים, והודעה
-- מראש על שינוי") and the DPA draft ("על קבלן משנה חדש יודיע המחזיק 14 יום
-- מראש"). Until now the list was hard-coded in src/features/legal/documents.ts.
--
-- public.subprocessors is a platform table (no organization_id, like
-- public.vat_rates). No client reads or writes it directly: platform staff
-- read it through platform_list_subprocessors(), the public page through
-- subprocessors_public_page() (service_role). RLS stays on with a select
-- policy for live rows, so a later read grant shows no cancelled entry.
-- The platform owner (app.require_platform: owner role, aal2) manages it:
--
--   platform_add_subprocessor(name, purpose, data, location, website, from)  -> id
--       a FUTURE entry, at least 14 days ahead (hint 'subprocessor:notice');
--       every active owner of every business gets one 'system' notice
--   platform_update_subprocessor(id, ...)  a future entry; a new name, day,
--       purpose or data categories needs 14 days again and sends a fresh notice
--       An entry in force only takes a location or website that was empty
--       (filling a missing detail)
--   platform_remove_subprocessor(id)       a future entry only: cancelled_at;
--       owners are told it will not join
--   platform_end_subprocessor(id, ends_on) an entry is retired by a future end
--       day (the first day it no longer applies); null clears a future end.
--       An end day is announced (on an upcoming entry under the 14-day rule)
--   platform_list_subprocessors()          every entry, for all platform staff
--   platform_subprocessor_audience()       how many notices an announcement sends
--   subprocessors_public_page()            service_role only (the public page,
--       owner's answer of 26 October 2026): {entries, updated_on} with name,
--       purpose, country, data categories and dates of live entries only;
--       at most 60 reads a minute in total (app.subprocessor_page_reads, no IP,
--       no input), above that {refused: 'rate'}
--
-- An entry whose day has begun in Israel is locked by app.subprocessors_guard
-- for every writer (hint 'subprocessor:in_force'), except a future end day and
-- the fill-once location/website. Nothing is deleted: a removed future entry is
-- cancelled. Every action is written to app.platform_log.
--
-- Announcements (lead's decision, 26 October 2026: tell customers whenever what
-- they were told changes). Each content change of an upcoming entry (name, day,
-- purpose, data categories, end day) notifies every active owner of every
-- business, one per business. app.subprocessor_announcements keeps, per entry,
-- the LATEST announcement (sequence number, kind, fingerprint
-- md5(jsonb_build_array(name, day, purpose, data, end day)), end day); a change
-- is announced whenever it differs from that one, so going back to an earlier
-- version is announced too. An entry in force announces a new, moved or cleared
-- end day; a removed upcoming entry that was announced is announced as not
-- joining. Each announcement reaches a business owner once
-- (app.subprocessor_notices, keyed by the sequence number). Text is compared
-- after collapsing whitespace (app.subprocessor_input), so a spacing fix is not
-- new content. The notice wording is a DRAFT (legal wording is the lawyer's).
-- Moving a start day onto or past the end day is refused with hint
-- 'subprocessor:end_before_start' (before the table's check constraint).
-- The list is not part of a signed text (agreement_texts holds terms, privacy
-- and dpa only), so a change here opens no LEGAL_VERSION.
-- Follow-ups (review of 26 October 2026, kept on purpose): an announcement is sent
-- in the platform owner's own transaction, one notice per owner per business, with
-- no batching (L1); end-day edits of an entry in force have no cool-down, each one
-- is announced (L2).
-- Every statement is safe to run twice.

create table if not exists public.subprocessors (
  id              uuid primary key default gen_random_uuid(),
  name            text not null
                  constraint subprocessors_name_check check (char_length(btrim(name)) between 1 and 120),
  purpose         text not null
                  constraint subprocessors_purpose_check check (char_length(btrim(purpose)) between 1 and 500),
  data_categories text not null
                  constraint subprocessors_data_categories_check check (char_length(btrim(data_categories)) between 1 and 500),
  location        text
                  constraint subprocessors_location_check check (location is null or char_length(btrim(location)) between 1 and 120),
  website         text
                  constraint subprocessors_website_check check (website is null or (char_length(website) <= 200 and website ~ '^https://[^[:space:]]+$')),
  effective_from  date not null,
  -- the first day the entry no longer applies; null = no end
  ends_on         date,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint subprocessors_ends_after_start check (ends_on is null or ends_on > effective_from)
);

comment on table public.subprocessors is
  'ADM-01: the platform''s subprocessors (platform table). In force from effective_from until the day before ends_on. Managed by platform_*_subprocessor; locked once in force.';
comment on column public.subprocessors.ends_on is 'ADM-01: the first day the entry no longer applies; null = no end.';
comment on column public.subprocessors.cancelled_at is 'ADM-01: set when the platform owner removed the entry before its day began; a cancelled entry is never shown.';

create or replace trigger subprocessors_touch before update on public.subprocessors
  for each row execute function app.touch_row();

alter table public.subprocessors enable row level security;
-- no API role reads or writes the table: the definer functions below do (a truncate would also skip the row guard)
revoke all on public.subprocessors from anon, authenticated, service_role;
-- no direct read either (the review's L3): the screens go through the functions below

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'subprocessors' and policyname = 'subprocessors_select') then
    create policy subprocessors_select on public.subprocessors for select to authenticated using (cancelled_at is null);
  end if;
end;
$$;

alter policy subprocessors_select on public.subprocessors using (cancelled_at is null);

-- The list as the legal page showed it until now (src/features/legal/documents.ts, LEGAL_VERSION 2026-10-13),
-- in force from the day of that version. Placed before the guard exists; skipped once any entry exists.
-- created_at keeps the page's order (the list is shown by effective_from, then created_at); both times are the
-- legal version's day, so the page's "last updated" line stays that day.
insert into public.subprocessors (name, purpose, data_categories, location, website, effective_from, created_at, updated_at)
select v.name, v.purpose, v.data_categories, null, null, date '2026-10-13',
       timestamptz '2026-10-13 00:00:00+03' + v.pos * interval '1 millisecond',
       timestamptz '2026-10-13 00:00:00+03' + v.pos * interval '1 millisecond'
  from (values
    (1, 'Supabase', 'מסד הנתונים, ההתחברות, האימות הדו-שלבי ועדכונים בזמן אמת.', 'כל המידע בשירות.'),
    (2, 'Vercel', 'אירוח האתר והשרת שמריץ אותו.', 'המידע שעובר בין הדפדפן לשרת בזמן השימוש, ורשומות שרת (כתובת IP, זמן, הדף שנטען).'),
    (3, 'שירותי הדחיפה של הדפדפנים',
        'העברת התראות לנייד ולמחשב, רק למי שהפעיל אותן. הספק תלוי בדפדפן: Google (כרום ואנדרואיד), Apple (ספארי ואייפון), Mozilla (פיירפוקס) או Microsoft (אדג'').',
        'תוכן ההתראה, מוצפן כך שהספק לא יכול לקרוא אותו.')
  ) as v(pos, name, purpose, data_categories)
 where not exists (select 1 from public.subprocessors)
 order by v.pos;

-- Locks an entry whose day has begun, for every writer.
create or replace function app.subprocessors_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  if tg_op = 'INSERT' then
    if new.effective_from <= v_today or new.cancelled_at is not null or (new.ends_on is not null and new.ends_on <= v_today) then
      raise exception 'a subprocessor can only be added from a day after today'
        using errcode = 'P0001', hint = 'subprocessor:in_force';
    end if;
    return new;
  end if;

  if tg_op <> 'DELETE' and new.ends_on is not null and new.ends_on <= new.effective_from then
    raise exception 'the end day must come after the start day'
      using errcode = 'P0001', hint = 'subprocessor:end_before_start';
  end if;

  if tg_op = 'DELETE' then
    -- clients have no delete grant; a migration or a test may clear a row that never applied
    if old.effective_from <= v_today and old.cancelled_at is null then
      raise exception 'a subprocessor in force cannot be removed; set an end day'
        using errcode = 'P0001', hint = 'subprocessor:in_force';
    end if;
    return old;
  end if;

  -- a cancelled entry never changes again
  if old.cancelled_at is not null then
    raise exception 'a removed subprocessor cannot change'
      using errcode = 'P0001', hint = 'subprocessor:in_force';
  end if;

  if old.effective_from > v_today then
    -- a future entry: anything may change, but it stays in the future
    if new.effective_from <= v_today or (new.ends_on is not null and new.ends_on <= v_today) then
      raise exception 'a subprocessor can only start after today'
        using errcode = 'P0001', hint = 'subprocessor:in_force';
    end if;
    return new;
  end if;

  -- in force (or ended): the facts are fixed
  if new.name is distinct from old.name
     or new.purpose is distinct from old.purpose
     or new.data_categories is distinct from old.data_categories
     or new.effective_from is distinct from old.effective_from
     or new.cancelled_at is distinct from old.cancelled_at
     or (old.location is not null and new.location is distinct from old.location)
     or (old.website is not null and new.website is distinct from old.website) then
    raise exception 'a subprocessor in force cannot be changed; end it and add a new entry'
      using errcode = 'P0001', hint = 'subprocessor:in_force';
  end if;
  if new.ends_on is distinct from old.ends_on
     and ((old.ends_on is not null and old.ends_on <= v_today)
          or (new.ends_on is not null and new.ends_on <= v_today)) then
    raise exception 'an end day can only be set or moved within the future'
      using errcode = 'P0001', hint = 'subprocessor:in_force';
  end if;
  return new;
end;
$$;
revoke all on function app.subprocessors_guard() from public, anon, authenticated;

create or replace trigger subprocessors_guard before insert or update or delete on public.subprocessors
  for each row execute function app.subprocessors_guard();


-- The latest announcement of each entry (one row per entry): what the business owners were last told.
create table if not exists app.subprocessor_announcements (
  subprocessor_id uuid primary key references public.subprocessors (id) on delete cascade,
  seq             integer not null,
  kind            text not null constraint subprocessor_announcements_kind_check check (kind in ('add', 'remove', 'end', 'keep')),
  fingerprint     text,
  ends_on         date,
  announced_at    timestamptz not null default now()
);
alter table app.subprocessor_announcements enable row level security;
revoke all on app.subprocessor_announcements from public, anon, authenticated;

-- Who was told which announcement: one row per entry, announcement (its sequence number), business and owner.
create table if not exists app.subprocessor_notices (
  subprocessor_id uuid not null references public.subprocessors (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  notice_key      text not null,
  sent_at         timestamptz not null default now(),
  primary key (subprocessor_id, organization_id, user_id, notice_key)
);
alter table app.subprocessor_notices enable row level security;
revoke all on app.subprocessor_notices from public, anon, authenticated;
create index if not exists subprocessor_notices_org_idx on app.subprocessor_notices (organization_id);
create index if not exists subprocessor_notices_user_idx on app.subprocessor_notices (user_id);

-- What an upcoming entry tells the owners, as one unambiguous value.
create or replace function app.subprocessor_fingerprint(p_name text, p_from date, p_purpose text, p_data text, p_ends_on date) returns text
language sql immutable
set search_path = ''
as $$
  select md5(jsonb_build_array(p_name, p_from, p_purpose, p_data, p_ends_on)::text)
$$;
revoke all on function app.subprocessor_fingerprint(text, date, text, text, date) from public, anon, authenticated;

-- The owners an announcement reaches: every active owner of every business that is not deleted, once per business
-- (a closed business keeps its owner's system notices, notifications_closed_org).
create or replace function app.subprocessor_audience() returns table (organization_id uuid, user_id uuid)
language sql stable security definer
set search_path = ''
as $$
  select m.organization_id, m.user_id
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
   where m.role = 'owner' and m.status = 'active' and o.deleted_at is null
$$;
revoke all on function app.subprocessor_audience() from public, anon, authenticated;

-- Announces the entry's current state when it differs from its latest announcement. DRAFT wording.
-- Returns the number of notices sent now.
create or replace function app.subprocessor_announce(p_id uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.subprocessors%rowtype;
  v_state app.subprocessor_announcements%rowtype;
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_kind text;
  v_fp text;
  v_title text := 'שינוי ברשימת קבלני המשנה';
  v_body text;
  v_seq integer;
  v_count integer;
begin
  select * into v_row from public.subprocessors s where s.id = p_id;
  if not found then
    return 0;
  end if;
  select * into v_state from app.subprocessor_announcements a where a.subprocessor_id = p_id for update;

  if v_row.cancelled_at is not null then
    -- only an entry the owners were told about is announced as not joining
    if v_state.subprocessor_id is null or v_state.kind = 'remove' then
      return 0;
    end if;
    v_kind := 'remove';
    v_fp := v_state.fingerprint;
    v_body := v_row.name || ' לא יצטרף לרשימת קבלני המשנה. הרשימה המלאה בעמוד קבלני המשנה.';
  elsif v_row.effective_from > v_today then
    v_fp := app.subprocessor_fingerprint(v_row.name, v_row.effective_from, v_row.purpose, v_row.data_categories, v_row.ends_on);
    if v_state.kind = 'add' and v_state.fingerprint = v_fp then
      return 0;
    end if;
    v_kind := 'add';
    v_title := 'קבלן משנה חדש';
    v_body := v_row.name || ' יצטרף לרשימת קבלני המשנה ב-' || to_char(v_row.effective_from, 'DD.MM.YYYY')
              || case when v_row.ends_on is not null
                      then ' ויוסר ממנה ב-' || to_char(v_row.ends_on, 'DD.MM.YYYY') else '' end
              || '. התפקיד: ' || v_row.purpose || ' המידע: ' || v_row.data_categories
              || ' הרשימה המלאה בעמוד קבלני המשנה.';
  else
    -- in force: only its end day can change
    if v_row.ends_on is not distinct from v_state.ends_on then
      return 0;
    end if;
    v_fp := v_state.fingerprint;
    if v_row.ends_on is null then
      v_kind := 'keep';
      v_body := v_row.name || ' יישאר ברשימת קבלני המשנה. הרשימה המלאה בעמוד קבלני המשנה.';
    else
      v_kind := 'end';
      v_body := v_row.name || ' יוסר מרשימת קבלני המשנה ב-' || to_char(v_row.ends_on, 'DD.MM.YYYY')
                || '. הרשימה המלאה בעמוד קבלני המשנה.';
    end if;
  end if;

  insert into app.subprocessor_announcements as a (subprocessor_id, seq, kind, fingerprint, ends_on, announced_at)
  values (p_id, 1, v_kind, v_fp, v_row.ends_on, now())
  on conflict (subprocessor_id) do update
     set seq = a.seq + 1, kind = excluded.kind, fingerprint = excluded.fingerprint,
         ends_on = excluded.ends_on, announced_at = excluded.announced_at
  returning a.seq into v_seq;

  with sent as (
    insert into app.subprocessor_notices (subprocessor_id, organization_id, user_id, notice_key)
    select p_id, t.organization_id, t.user_id, v_seq::text
      from app.subprocessor_audience() t
    on conflict do nothing
    returning organization_id, user_id
  ), notified as (
    insert into public.notifications (organization_id, user_id, type, title, body)
    select s.organization_id, s.user_id, 'system', v_title, v_body
      from sent s
    returning 1
  )
  select count(*) into v_count from notified;
  return v_count;
end;
$$;
revoke all on function app.subprocessor_announce(uuid) from public, anon, authenticated;

-- Checks shared by add and update; raises 22023. Returns the fields with whitespace collapsed (runs of spaces,
-- tabs, line breaks and the no-break and other Unicode spaces become one space; ends trimmed), so a spacing fix is
-- not new content.
create or replace function app.subprocessor_clean(p_text text) returns text
language sql immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p_text, ''),
           '[[:space:]' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233)
             || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+', ' ', 'g')), '')
$$;
revoke all on function app.subprocessor_clean(text) from public, anon, authenticated;

create or replace function app.subprocessor_input(p_name text, p_purpose text, p_data_categories text, p_location text, p_website text, p_effective_from date)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_name text := coalesce(app.subprocessor_clean(p_name), '');
  v_purpose text := coalesce(app.subprocessor_clean(p_purpose), '');
  v_data text := coalesce(app.subprocessor_clean(p_data_categories), '');
  v_location text := app.subprocessor_clean(p_location);
  v_website text := nullif(btrim(coalesce(p_website, '')), '');
begin
  if p_effective_from is null
     or char_length(v_name) not between 1 and 120
     or char_length(v_purpose) not between 1 and 500
     or char_length(v_data) not between 1 and 500
     or char_length(coalesce(v_location, 'x')) > 120
     or (v_website is not null and (char_length(v_website) > 200 or v_website !~ '^https://[^[:space:]]+$')) then
    raise exception 'invalid subprocessor' using errcode = '22023';
  end if;
  return jsonb_build_object('name', v_name, 'purpose', v_purpose, 'data_categories', v_data, 'location', v_location, 'website', v_website);
end;
$$;
revoke all on function app.subprocessor_input(text, text, text, text, text, date) from public, anon, authenticated;

-- The advance notice of the DPA: what an upcoming entry tells the owners changes only at least 14 days before it starts.
create or replace function app.subprocessor_notice_ok(p_effective_from date) returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if p_effective_from < (now() at time zone 'Asia/Jerusalem')::date + 14 then
    raise exception 'a new subprocessor needs 14 days of notice'
      using errcode = 'P0001', hint = 'subprocessor:notice';
  end if;
end;
$$;
revoke all on function app.subprocessor_notice_ok(date) from public, anon, authenticated;

create or replace function public.platform_add_subprocessor(
  p_name text, p_purpose text, p_data_categories text, p_location text, p_website text, p_effective_from date
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_id uuid;
  v_sent integer;
begin
  perform app.require_platform(array[]::text[]);
  v := app.subprocessor_input(p_name, p_purpose, p_data_categories, p_location, p_website, p_effective_from);
  perform app.subprocessor_notice_ok(p_effective_from);
  insert into public.subprocessors (name, purpose, data_categories, location, website, effective_from)
  values (v->>'name', v->>'purpose', v->>'data_categories', v->>'location', v->>'website', p_effective_from)
  returning id into v_id;
  v_sent := app.subprocessor_announce(v_id);
  perform app.log_platform('subprocessor.add', null,
    v || jsonb_build_object('id', v_id, 'effective_from', p_effective_from, 'notices', v_sent));
  return v_id;
end;
$$;
revoke all on function public.platform_add_subprocessor(text, text, text, text, text, date) from public, anon;
grant execute on function public.platform_add_subprocessor(text, text, text, text, text, date) to authenticated;

-- A future entry may be corrected: a change of what it tells the owners (name, day, purpose, data) needs the 14 days
-- and is announced; a location or website quietly. An entry in force only takes a location or website that was empty;
-- anything else is refused by the guard.
create or replace function public.platform_update_subprocessor(
  p_id uuid, p_name text, p_purpose text, p_data_categories text, p_location text, p_website text, p_effective_from date
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.subprocessors%rowtype;
  v jsonb;
  v_sent integer := 0;
  v_future boolean;
begin
  perform app.require_platform(array[]::text[]);
  select * into v_old from public.subprocessors s where s.id = p_id for update;
  if not found or v_old.cancelled_at is not null then
    raise exception 'subprocessor not found' using errcode = 'P0002';
  end if;
  v := app.subprocessor_input(p_name, p_purpose, p_data_categories, p_location, p_website, p_effective_from);
  v_future := v_old.effective_from > (now() at time zone 'Asia/Jerusalem')::date;
  if v_old.name = v->>'name' and v_old.purpose = v->>'purpose' and v_old.data_categories = v->>'data_categories'
     and v_old.location is not distinct from v->>'location' and v_old.website is not distinct from v->>'website'
     and v_old.effective_from = p_effective_from then
    return v_old.id;
  end if;
  if v_future and app.subprocessor_fingerprint(v_old.name, v_old.effective_from, v_old.purpose, v_old.data_categories, v_old.ends_on)
                  <> app.subprocessor_fingerprint(v->>'name', p_effective_from, v->>'purpose', v->>'data_categories', v_old.ends_on) then
    perform app.subprocessor_notice_ok(p_effective_from);
  end if;
  -- the guard refuses what may not change
  update public.subprocessors
     set name = v->>'name', purpose = v->>'purpose', data_categories = v->>'data_categories',
         location = v->>'location', website = v->>'website', effective_from = p_effective_from
   where id = v_old.id;
  v_sent := app.subprocessor_announce(v_old.id);
  perform app.log_platform('subprocessor.update', null,
    jsonb_build_object('id', v_old.id,
      'old', jsonb_build_object('name', v_old.name, 'purpose', v_old.purpose, 'data_categories', v_old.data_categories,
                                'location', v_old.location, 'website', v_old.website, 'effective_from', v_old.effective_from),
      'new', v || jsonb_build_object('effective_from', p_effective_from),
      'notices', v_sent));
  return v_old.id;
end;
$$;
revoke all on function public.platform_update_subprocessor(uuid, text, text, text, text, text, date) from public, anon;
grant execute on function public.platform_update_subprocessor(uuid, text, text, text, text, text, date) to authenticated;

create or replace function public.platform_remove_subprocessor(p_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.subprocessors%rowtype;
  v_sent integer;
begin
  perform app.require_platform(array[]::text[]);
  select * into v_old from public.subprocessors s where s.id = p_id for update;
  if not found or v_old.cancelled_at is not null then
    raise exception 'subprocessor not found' using errcode = 'P0002';
  end if;
  if v_old.effective_from <= (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'a subprocessor in force cannot be removed; set an end day'
      using errcode = 'P0001', hint = 'subprocessor:in_force';
  end if;
  update public.subprocessors set cancelled_at = now() where id = v_old.id;
  v_sent := app.subprocessor_announce(v_old.id);
  perform app.log_platform('subprocessor.remove', null,
    jsonb_build_object('id', v_old.id, 'name', v_old.name, 'effective_from', v_old.effective_from, 'notices', v_sent));
end;
$$;
revoke all on function public.platform_remove_subprocessor(uuid) from public, anon;
grant execute on function public.platform_remove_subprocessor(uuid) to authenticated;

-- Retires an entry from a future day (the first day it no longer applies), or clears a future end with null.
-- On an upcoming entry the end day is part of what it tells the owners: a change needs the 14 days and is announced.
-- On an entry in force a new, moved or cleared end day is announced.
create or replace function public.platform_end_subprocessor(p_id uuid, p_ends_on date) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.subprocessors%rowtype;
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_sent integer;
begin
  perform app.require_platform(array[]::text[]);
  select * into v_old from public.subprocessors s where s.id = p_id for update;
  if not found or v_old.cancelled_at is not null then
    raise exception 'subprocessor not found' using errcode = 'P0002';
  end if;
  if (v_old.ends_on is not null and v_old.ends_on <= v_today) or (p_ends_on is not null and p_ends_on <= v_today) then
    raise exception 'an end day can only be set or moved within the future'
      using errcode = 'P0001', hint = 'subprocessor:in_force';
  end if;
  if p_ends_on is not null and p_ends_on <= v_old.effective_from then
    raise exception 'the end day must come after the start day'
      using errcode = 'P0001', hint = 'subprocessor:end_before_start';
  end if;
  if p_ends_on is not distinct from v_old.ends_on then
    return;
  end if;
  if v_old.effective_from > v_today then
    perform app.subprocessor_notice_ok(v_old.effective_from);
  end if;
  update public.subprocessors set ends_on = p_ends_on where id = v_old.id;
  v_sent := app.subprocessor_announce(v_old.id);
  perform app.log_platform('subprocessor.end', null,
    jsonb_build_object('id', v_old.id, 'name', v_old.name, 'old_ends_on', v_old.ends_on, 'ends_on', p_ends_on, 'notices', v_sent));
end;
$$;
revoke all on function public.platform_end_subprocessor(uuid, date) from public, anon;
grant execute on function public.platform_end_subprocessor(uuid, date) to authenticated;

-- The platform screen: every entry, removed ones included, for all platform staff.
create or replace function public.platform_list_subprocessors() returns setof public.subprocessors
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return query
    select s.* from public.subprocessors s
     order by s.effective_from desc, s.created_at desc, s.id;
end;
$$;
revoke all on function public.platform_list_subprocessors() from public, anon;
grant execute on function public.platform_list_subprocessors() to authenticated;

-- How many notices an announcement sends now (one per business per active owner), for the screen's confirmation.
create or replace function public.platform_subprocessor_audience() returns integer
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array[]::text[]);
  return (select count(*)::integer from app.subprocessor_audience());
end;
$$;
revoke all on function public.platform_subprocessor_audience() from public, anon;
grant execute on function public.platform_subprocessor_audience() to authenticated;

-- The public page's read counter: one row, the current minute and its reads. No IP, no input.
create table if not exists app.subprocessor_page_reads (
  id      integer primary key constraint subprocessor_page_reads_one check (id = 1),
  minute  timestamptz not null,
  reads   integer not null
);
alter table app.subprocessor_page_reads enable row level security;
revoke all on app.subprocessor_page_reads from public, anon, authenticated;

create or replace function app.subprocessor_page_reads_per_minute() returns integer
language sql immutable
set search_path = ''
as $$ select 60 $$;
revoke all on function app.subprocessor_page_reads_per_minute() from public, anon, authenticated;

-- The public subprocessors page (owner, 26 October 2026, answer (ב): a new use of the service-role key under the
-- public-page pattern). Granted to service_role only; no arguments. Returns only name, purpose, country, data
-- categories and dates of live entries (in force now, or upcoming with their dates; not cancelled, not ended), oldest
-- first, and the day of the list's latest change in Israel: a live entry added or changed, an entry removed, or an
-- entry that ended. No ids, no internal times, no website. At most app.subprocessor_page_reads_per_minute() reads a
-- minute in total; above that it answers {refused: 'rate'}, which the server treats as a failed read.
create or replace function public.subprocessors_public_page() returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_reads integer;
  v_entries jsonb;
  v_updated date;
begin
  insert into app.subprocessor_page_reads as r (id, minute, reads)
  values (1, v_minute, 1)
  on conflict (id) do update
     -- a late commit never moves the minute back: it counts toward the newer minute
     set minute = greatest(r.minute, excluded.minute),
         reads = case when r.minute >= excluded.minute then r.reads + 1 else 1 end
  returning r.reads into v_reads;
  if v_reads > app.subprocessor_page_reads_per_minute() then
    return jsonb_build_object('refused', 'rate');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', s.name, 'purpose', s.purpose, 'country', s.location, 'data_categories', s.data_categories,
           'effective_from', to_char(s.effective_from, 'YYYY-MM-DD'),
           'ends_on', to_char(s.ends_on, 'YYYY-MM-DD'))
         order by s.effective_from, s.created_at, s.id), '[]'::jsonb)
    into v_entries
    from public.subprocessors s
   where s.cancelled_at is null
     and (s.ends_on is null or s.ends_on > v_today);

  select max(d) into v_updated
    from (
      select (greatest(s.created_at, s.updated_at) at time zone 'Asia/Jerusalem')::date as d
        from public.subprocessors s
       where s.cancelled_at is null and (s.ends_on is null or s.ends_on > v_today)
      union all
      select (s.cancelled_at at time zone 'Asia/Jerusalem')::date
        from public.subprocessors s
       where s.cancelled_at is not null
      union all
      select s.ends_on
        from public.subprocessors s
       where s.cancelled_at is null and s.ends_on <= v_today
    ) changes;

  return jsonb_build_object('entries', v_entries, 'updated_on', to_char(v_updated, 'YYYY-MM-DD'));
end;
$$;
revoke all on function public.subprocessors_public_page() from public, anon, authenticated;
grant execute on function public.subprocessors_public_page() to service_role;
