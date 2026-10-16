-- =============================================================================
-- 020295 QR codes by purpose (BIZ-03, part one)
-- =============================================================================
-- "קודי QR לפי מטרה (מרחיב את CAP-03): לטופס, לקביעת תור, לביקורת ב-Google, ומגל 3 גם לדף תשלום. לכל קוד מקור משלו
-- וספירת סריקות, כדי לדעת איזה שלט או פלייר עבד."
-- Part one (lead, 16 October 2026): a code opens a form or a booking page; owners and admins manage the codes; the code's
-- "source" is campaign tagging only (utm_source=qr, utm_campaign = the code's name), the lead's source stays the form's or
-- the page's. No Google review or business-card target yet (questions to the owner).
-- Plan: flag `qr_codes` and quota `max_qr_codes` (every code counts, switched off ones too), owner 13 October 2026.
-- The approved pattern for public secret-link pages (owner, 13 October 2026; CLAUDE.md hard rule 5), with its conditions:
-- a scan is a counter only (no IP, no device, no visitor id); it redirects only to the stored target, never to a URL from
-- the request; a code that does not exist, is off, or whose target is gone or not open answers "not found".
--
-- * public.qr_codes: name, target (a form of kind 'form', or a booking page; composite FKs, set null when the target is
--   deleted, which leaves the code "not found"), is_active, a token (its link: /f/q/<token>; server-made, read only by
--   owners/admins). Owners and admins of a writable business manage it; members do not see it. Audited.
-- * app.qr_code_scan_days: one counter per code and day (the business's zone). app.qr_scan_windows: the rate limit, one
--   row per code (at most 60 counted scans a minute; past that the scan still redirects, it is not counted). No IP anywhere.
-- * public.qr_scan(token): security definer, service_role only. Answers {path, campaign} and counts the scan, or P0002.
-- * public.qr_code_scans(org, days): security definer, owners/admins: totals per code, all time and the last N days.
-- No drop statement, no delete statement. Safe to run twice.

-- ----------------------------------------------------------------------------
-- Codes
-- ----------------------------------------------------------------------------
create table if not exists public.qr_codes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  target_kind     text not null check (target_kind in ('form', 'booking')),
  form_id         uuid,
  booking_page_id uuid,
  token           text not null unique default replace(gen_random_uuid()::text, '-', ''),
  is_active       boolean not null default true,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint qr_codes_form_fk foreign key (organization_id, form_id)
    references public.forms (organization_id, id) on delete set null (form_id),
  constraint qr_codes_booking_page_fk foreign key (organization_id, booking_page_id)
    references public.booking_pages (organization_id, id) on delete set null (booking_page_id),
  -- one target column per kind; an empty one means the target was deleted
  constraint qr_codes_target_shape check (
    (target_kind = 'form' and booking_page_id is null) or (target_kind = 'booking' and form_id is null))
);
create index if not exists qr_codes_org_idx on public.qr_codes (organization_id, created_at);
create index if not exists qr_codes_form_idx on public.qr_codes (organization_id, form_id) where form_id is not null;
create index if not exists qr_codes_booking_page_idx on public.qr_codes (organization_id, booking_page_id) where booking_page_id is not null;

alter table public.qr_codes enable row level security;
revoke all on public.qr_codes from anon, authenticated;
grant select, delete on public.qr_codes to authenticated;
grant insert (organization_id, name, target_kind, form_id, booking_page_id, is_active) on public.qr_codes to authenticated;
grant update (name, target_kind, form_id, booking_page_id, is_active) on public.qr_codes to authenticated;

do $$
begin
  -- owners and admins only: a code leads to a booking page's link, which other members may not hold
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'qr_codes' and policyname = 'qr_codes_select') then
    create policy qr_codes_select on public.qr_codes for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'qr_codes' and policyname = 'qr_codes_insert') then
    create policy qr_codes_insert on public.qr_codes for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'qr_codes' and policyname = 'qr_codes_update') then
    create policy qr_codes_update on public.qr_codes for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'qr_codes' and policyname = 'qr_codes_delete') then
    create policy qr_codes_delete on public.qr_codes for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger qr_codes_touch before update on public.qr_codes
  for each row execute function app.touch_row();
create or replace trigger qr_codes_audit after insert or update or delete on public.qr_codes
  for each row execute function app.audit_row();

-- The target and the plan. The outsider guard first, so a person outside the business gets RLS's plain refusal and learns
-- nothing about its plan or its forms. A target deleted later (the FK sets it null) is not checked again here.
create or replace function app.qr_codes_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if tg_op = 'INSERT' or new.target_kind is distinct from old.target_kind
     or new.form_id is distinct from old.form_id or new.booking_page_id is distinct from old.booking_page_id then
    -- a target is picked; an update may still clear it (that only switches the code off in effect)
    if (tg_op = 'INSERT' or new.target_kind is distinct from old.target_kind)
       and coalesce(new.form_id, new.booking_page_id) is null then
      raise exception 'a QR code opens a form or a booking page' using errcode = 'P0001', hint = 'qr_code:target';
    end if;
    if new.form_id is not null and not exists (select 1 from public.forms f
        where f.organization_id = new.organization_id and f.id = new.form_id and f.kind = 'form') then
      raise exception 'a QR code opens a web form' using errcode = 'P0001', hint = 'qr_code:target';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if not app.org_has_feature(new.organization_id, 'qr_codes') then
      raise exception 'QR codes are not in the plan' using errcode = 'P0001', hint = 'feature:qr_codes';
    end if;
    v_limit := app.org_limit(new.organization_id, 'max_qr_codes');
    if v_limit is not null then
      perform pg_advisory_xact_lock(hashtextextended('qr_codes:' || new.organization_id::text, 0));
      if (select count(*) from public.qr_codes c where c.organization_id = new.organization_id) >= v_limit then
        raise exception 'QR code limit reached' using errcode = 'P0001', hint = 'limit:max_qr_codes';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.qr_codes_check() from public, anon, authenticated;

create or replace trigger qr_codes_check before insert or update on public.qr_codes
  for each row execute function app.qr_codes_check();

-- ----------------------------------------------------------------------------
-- Scan counters: a number per code and day, nothing about the person who scanned
-- ----------------------------------------------------------------------------
create table if not exists app.qr_code_scan_days (
  qr_code_id uuid not null references public.qr_codes (id) on delete cascade,
  day        date not null,
  scans      integer not null default 0 check (scans >= 0),
  primary key (qr_code_id, day)
);
alter table app.qr_code_scan_days enable row level security;
revoke all on app.qr_code_scan_days from public, anon, authenticated;

-- the rate limit: the current minute's count per code (one row per code, reused)
create table if not exists app.qr_scan_windows (
  qr_code_id   uuid primary key references public.qr_codes (id) on delete cascade,
  window_start timestamptz not null,
  scans        integer not null
);
alter table app.qr_scan_windows enable row level security;
revoke all on app.qr_scan_windows from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The scan: where the code leads, counted
-- ----------------------------------------------------------------------------
-- Answers only the stored target's public path and the code's name (the campaign tag); never an id, a count or anything
-- else about the business. Not found (P0002) unless the code is on, the plan holds the flag, the business's public pages
-- are open (app.org_public_pages_open) and the target is live: an active web form, or a booking page that its own page
-- would show (app.booking_page_state). A scan is counted only while the code's minute holds fewer than 60 counted scans.
create or replace function public.qr_scan(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_code public.qr_codes;
  v_path text;
  v_page public.booking_pages;
  v_zone text;
  v_window integer;
begin
  select * into v_code from public.qr_codes c where c.token = coalesce(p_token, '');
  if v_code.id is null or not v_code.is_active
     or not app.org_public_pages_open(v_code.organization_id)
     or not app.org_has_feature(v_code.organization_id, 'qr_codes') then
    raise exception 'QR code not found' using errcode = 'P0002';
  end if;

  if v_code.target_kind = 'form' then
    select '/f/' || f.token into v_path
      from public.forms f
     where f.organization_id = v_code.organization_id and f.id = v_code.form_id and f.kind = 'form' and f.is_active;
  else
    select * into v_page from public.booking_pages b
     where b.organization_id = v_code.organization_id and b.id = v_code.booking_page_id;
    if v_page.id is not null and app.booking_page_state(v_page) <> 'not_found' then
      v_path := '/f/book/' || v_page.token;
    end if;
  end if;
  if v_path is null then
    raise exception 'QR code not found' using errcode = 'P0002';
  end if;

  -- the rate limit: counted first, so it is exact under parallel scans; only the code's own row is locked
  insert into app.qr_scan_windows as w (qr_code_id, window_start, scans)
  values (v_code.id, now(), 1)
  on conflict (qr_code_id) do update
    set window_start = case when w.window_start > now() - interval '1 minute' then w.window_start else now() end,
        scans = case when w.window_start > now() - interval '1 minute' then w.scans + 1 else 1 end
  returning w.scans into v_window;
  if v_window <= 60 then
    select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_code.organization_id;
    insert into app.qr_code_scan_days as d (qr_code_id, day, scans)
    values (v_code.id, (now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date, 1)
    on conflict (qr_code_id, day) do update set scans = d.scans + 1;
  end if;

  return jsonb_build_object('path', v_path, 'campaign', v_code.name);
end;
$$;
revoke all on function public.qr_scan(text) from public, anon, authenticated;
grant execute on function public.qr_scan(text) to service_role;

-- ----------------------------------------------------------------------------
-- The counts, for the business's owners and admins
-- ----------------------------------------------------------------------------
-- One row per code of the business that has any scan: all time, the last p_days days (the business's zone, today included)
-- and the last day with a scan.
create or replace function public.qr_code_scans(p_org uuid, p_days integer default 30) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  if not app.is_admin(p_org) then
    raise exception 'QR code counts are for owners and admins' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'days must be between 1 and 366' using errcode = '22023';
  end if;
  select (now() at time zone coalesce(app.intake_zone(o.timezone), 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = p_org;
  return coalesce((
    select jsonb_agg(jsonb_build_object('qr_code_id', s.qr_code_id, 'total', s.total, 'recent', s.recent,
                                        'last_day', s.last_day) order by s.qr_code_id)
      from (
        select d.qr_code_id, sum(d.scans) as total,
               coalesce(sum(d.scans) filter (where d.day > v_today - p_days), 0) as recent,
               max(d.day) as last_day
          from app.qr_code_scan_days d
          join public.qr_codes c on c.id = d.qr_code_id and c.organization_id = p_org
         group by d.qr_code_id) s), '[]'::jsonb);
end;
$$;
revoke all on function public.qr_code_scans(uuid, integer) from public, anon;
grant execute on function public.qr_code_scans(uuid, integer) to authenticated;
