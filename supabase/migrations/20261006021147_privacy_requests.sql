-- =============================================================================
-- PRK-02: data-subject requests ("בקשות פרטיות")
-- =============================================================================
-- Spec (SPEC-ADDITIONS 18.9, PRK-02, wave 3): a public form to ask for access, correction or erasure; a request log with
-- status and target date; an identity-verification step; execution through PRV-02 (person export) and PRV-03 (person
-- erasure). Privacy, so every plan, no plan key (CLAUDE.md, "Plans and capabilities").
--
-- Owner, 26 October 2026 (hard rule 5, wave 3 use (3)): the public page collects only the request type, a name, one contact
-- channel and text; it never shows or confirms that data exists (the same answer always); honeypot and rate limit as LND-13;
-- the request reaches the owner as a `system` notice with a 30-day count. The approved pattern: the server route calls ONE
-- security definer function granted to service_role only (public.privacy_request_submit), plus the page's display read
-- (public.privacy_request_page: the business's display name, logo and colour only); no direct table access.
--
-- * app.privacy_request_links: one secret link per business (SHA-256 of the token only, no grants). Owners and admins create
--   (a new one replaces the old one), revoke and read its state through public.privacy_request_link_create/revoke/status
--   (definer; audited `privacy_request_link`, never the token).
-- * public.privacy_requests: the request log, in the business. Server rows only (no insert grant); owners and admins read
--   and, in a business that is not deleted, suspended or cancelled (app.privacy_requests_workable: a read-only business still
--   handles privacy requests; privacy is never locked), move the status, mark the identity check (method from a closed list, optional note; once),
--   link one lead or contact, and refuse with a reason. The privacy officer (PRK-06) is told, but the mark adds no rights.
--   Status new | verifying | in_progress | done | refused; in_progress and done need the identity check; done and refused
--   close the request (closed_at/by, then frozen). target_date = the day received in the business's zone + 30 days.
-- * Rate limits (FXS-11): the sender is the server's keyed IP hash (scope `privacy`), scoped again per business by
--   app.privacy_request_sender (the server hashes an IPv6 visitor by its /64, as OPS-02); only bucket numbers are kept (1,024
--   per business and kind), never a hash, so nothing is left to clear after the window. The sender is judged first, then the
--   link. Views: 60 per sender, then 300 per link, in 10 minutes. Submissions: 3 per sender in 10 minutes and 10 per sender a
--   day (honeypot hits included, answered like the rest and never stored), then 50 stored requests per link a day. No sender
--   hash = only the link's own limits (fail open, as the other public pages).
-- * Notices: the first 5 requests of a business's day (its zone) are told one by one; after that one notice a day
--   "התקבלו עוד בקשות פרטיות היום" whose body counts them (app.privacy_request_notice_days).
-- * Junk is closed as refused with a reason (the screen offers "בקשה לא רצינית / ספאם"); nothing is deleted.
-- * Erasure: a privacy erasure of the linked lead or contact (app.audit_erase_core, through its own `erase` audit entry, also
--   PRV-01's retention erasure) empties the request's name, contact, text, identity note and refusal reason, and erases the
--   request's own audit entries (trigger audit_log_privacy_requests_erase on public.audit_log). Every link a request ever had
--   (a person's unlink or switch, a purge's FK set-null) stays in server-only former_lead_ids / former_contact_ids, so a later
--   erasure of that record still finds it. A merge moves the duplicate's requests to the kept record through the `merged` entry.
-- * Updates are audited (app.audit_row); the insert is not (the table is the log, and the text stays out of audit_log).
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- The request log
-- ----------------------------------------------------------------------------
create table if not exists public.privacy_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  request_type      text not null,
  requester_name    text,
  contact_kind      text not null,
  contact_value     text,
  details           text,
  status            text not null default 'new',
  received_at       timestamptz not null default now(),
  target_date       date not null,
  verify_method     text,
  verify_note       text,
  verified_at       timestamptz,
  verified_by       uuid references auth.users (id) on delete set null,
  refusal_reason    text,
  lead_id           uuid,
  contact_id        uuid,
  former_lead_ids   uuid[] not null default '{}',
  former_contact_ids uuid[] not null default '{}',
  closed_at         timestamptz,
  closed_by         uuid references auth.users (id) on delete set null,
  erased_at         timestamptz,
  updated_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  constraint privacy_requests_type check (request_type in ('access', 'correction', 'erasure')),
  constraint privacy_requests_status check (status in ('new', 'verifying', 'in_progress', 'done', 'refused')),
  constraint privacy_requests_contact_kind check (contact_kind in ('email', 'phone')),
  constraint privacy_requests_values check (
    (requester_name is null or char_length(requester_name) between 1 and 200)
    and (contact_value is null or char_length(contact_value) between 1 and 254)
    and (details is null or char_length(details) <= 2000)
    and (verify_note is null or char_length(verify_note) between 1 and 500)
    and (refusal_reason is null or char_length(refusal_reason) between 1 and 500)),
  -- the personal fields are filled until a privacy erasure empties them
  constraint privacy_requests_person check (erased_at is not null or (requester_name is not null and contact_value is not null)),
  constraint privacy_requests_verify_method check (verify_method is null or verify_method in ('id_document', 'known_details', 'signed_form', 'other')),
  constraint privacy_requests_one_link check (lead_id is null or contact_id is null),
  constraint privacy_requests_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete set null (lead_id),
  constraint privacy_requests_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete set null (contact_id)
);

create index if not exists privacy_requests_lead_idx on public.privacy_requests (organization_id, lead_id);
create index if not exists privacy_requests_contact_idx on public.privacy_requests (organization_id, contact_id);
create index if not exists privacy_requests_received_idx on public.privacy_requests (organization_id, received_at desc);

comment on table public.privacy_requests is
  'PRK-02: data-subject requests (access, correction, erasure) from the business''s public privacy page; owners/admins only';

alter table public.privacy_requests enable row level security;
revoke all on public.privacy_requests from anon, authenticated;
grant select on public.privacy_requests to authenticated;
grant update (status, verify_method, verify_note, refusal_reason, lead_id, contact_id) on public.privacy_requests to authenticated;

-- a read-only business still handles privacy requests (privacy is never locked); a deleted, suspended or cancelled one does not
create or replace function app.privacy_requests_workable(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.organizations o
                  where o.id = p_org and o.deleted_at is null and not app.org_status_closed(o.status))
$$;
revoke all on function app.privacy_requests_workable(uuid) from public, anon;
grant execute on function app.privacy_requests_workable(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'privacy_requests' and policyname = 'privacy_requests_select') then
    create policy privacy_requests_select on public.privacy_requests for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'privacy_requests' and policyname = 'privacy_requests_update') then
    create policy privacy_requests_update on public.privacy_requests for update to authenticated
      using (app.is_admin(organization_id) and app.privacy_requests_workable(organization_id))
      with check (app.is_admin(organization_id) and app.privacy_requests_workable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The rules of a person's change (invoker: current_user tells a person from the server)
-- ----------------------------------------------------------------------------
create or replace function app.privacy_requests_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- every link the request ever had is kept, for a later privacy erasure of that record (a person's unlink or switch, a
  -- merge, a purge's FK set-null)
  if old.lead_id is not null and new.lead_id is distinct from old.lead_id and not (old.lead_id = any (new.former_lead_ids)) then
    new.former_lead_ids := new.former_lead_ids || old.lead_id;
  end if;
  if old.contact_id is not null and new.contact_id is distinct from old.contact_id and not (old.contact_id = any (new.former_contact_ids)) then
    new.former_contact_ids := new.former_contact_ids || old.contact_id;
  end if;
  -- the FK's own set-null (a purge, at depth > 1) changes nothing else: let it through, a closed request included
  if pg_trigger_depth() > 1
     and (new.lead_id is null or new.lead_id is not distinct from old.lead_id)
     and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)
     and (new.status, new.verify_method, new.verify_note, new.refusal_reason)
         is not distinct from (old.status, old.verify_method, old.verify_note, old.refusal_reason) then
    return new;
  end if;

  -- closing stamps who and when, for every writer
  if new.status in ('done', 'refused') and old.status not in ('done', 'refused') then
    new.closed_at := now();
    new.closed_by := auth.uid();
  end if;

  -- a server write (a definer function) is not a person's change
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- an outsider gets RLS's plain refusal and learns nothing
  if not app.is_admin(new.organization_id) then
    return new;
  end if;

  if old.status in ('done', 'refused') then
    raise exception 'a closed privacy request does not change' using errcode = 'P0001', hint = 'privacy_request:closed';
  end if;

  -- the identity check: a method from the closed list, an optional note, marked once
  if old.verified_at is not null then
    if new.verify_method is distinct from old.verify_method or new.verify_note is distinct from old.verify_note then
      raise exception 'the identity check is already marked' using errcode = 'P0001', hint = 'privacy_request:verified';
    end if;
  elsif new.verify_method is not null then
    new.verify_note := nullif(btrim(new.verify_note), '');
    new.verified_at := now();
    new.verified_by := auth.uid();
  elsif new.verify_note is not null then
    raise exception 'pick how the identity was checked' using errcode = 'P0001', hint = 'privacy_request:verify_method';
  end if;

  if new.status in ('in_progress', 'done') and new.verified_at is null then
    raise exception 'check the identity first' using errcode = 'P0001', hint = 'privacy_request:not_verified';
  end if;

  new.refusal_reason := nullif(btrim(new.refusal_reason), '');
  if new.status = 'refused' and new.refusal_reason is null then
    raise exception 'a refusal needs a reason' using errcode = 'P0001', hint = 'privacy_request:refusal_reason';
  end if;
  if new.status <> 'refused' and new.refusal_reason is not null then
    raise exception 'a reason belongs to a refusal' using errcode = 'P0001', hint = 'privacy_request:refusal_reason';
  end if;

  -- a link names a live record of this business that the person reads
  if new.lead_id is not null and new.lead_id is distinct from old.lead_id
     and not exists (select 1 from public.leads l
                      where l.organization_id = new.organization_id and l.id = new.lead_id and l.deleted_at is null) then
    raise exception 'link a live lead' using errcode = 'P0001', hint = 'privacy_request:link';
  end if;
  if new.contact_id is not null and new.contact_id is distinct from old.contact_id
     and not exists (select 1 from public.contacts c
                      where c.organization_id = new.organization_id and c.id = new.contact_id and c.deleted_at is null) then
    raise exception 'link a live contact' using errcode = 'P0001', hint = 'privacy_request:link';
  end if;
  return new;
end;
$$;
revoke all on function app.privacy_requests_check() from public, anon, authenticated;

create or replace trigger privacy_requests_check before update on public.privacy_requests
  for each row execute function app.privacy_requests_check();
create or replace trigger privacy_requests_touch before insert or update on public.privacy_requests
  for each row execute function app.touch_row();
create or replace trigger privacy_requests_audit after update on public.privacy_requests
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- The business's secret link, and the rate-limit buckets
-- ----------------------------------------------------------------------------
create table if not exists app.privacy_request_links (
  organization_id     uuid primary key references public.organizations (id) on delete cascade,
  token_hash          text unique,
  created_by          uuid,
  created_at          timestamptz,
  view_window_start   timestamptz,
  view_count          integer not null default 0,
  submit_window_start timestamptz,
  submit_count        integer not null default 0
);
alter table app.privacy_request_links enable row level security;
revoke all on app.privacy_request_links from public, anon, authenticated, service_role;

create table if not exists app.privacy_request_counts (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null check (kind in ('view', 'submit', 'submit_day')),
  bucket          integer not null check (bucket between 0 and 1023),
  window_start    timestamptz not null,
  n               integer not null,
  primary key (organization_id, kind, bucket)
);
alter table app.privacy_request_counts enable row level security;
revoke all on app.privacy_request_counts from public, anon, authenticated, service_role;

-- the server's keyed IP hash, scoped again per business; only its bucket number is kept
create or replace function app.privacy_request_sender(p_org uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_org is null or p_hash !~ '^[0-9a-f]{64}$' then null
              else encode(sha256(convert_to('privacy:' || p_org::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.privacy_request_sender(uuid, text) from public, anon, authenticated, service_role;

-- one count per sender, kind and window; true while within p_max (no sender = not counted)
create or replace function app.privacy_request_count(p_org uuid, p_kind text, p_hash text, p_max integer, p_window interval) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sender text := app.privacy_request_sender(p_org, p_hash);
  v_bucket integer;
  v_n integer;
begin
  if v_sender is null then
    return true;
  end if;
  v_bucket := ((hashtextextended(v_sender, 0) % 1024) + 1024) % 1024;
  insert into app.privacy_request_counts as c (organization_id, kind, bucket, window_start, n)
  values (p_org, p_kind, v_bucket, now(), 1)
  on conflict (organization_id, kind, bucket) do update
    set window_start = case when c.window_start > now() - p_window then c.window_start else now() end,
        n = case when c.window_start > now() - p_window then c.n + 1 else 1 end
  returning c.n into v_n;
  return v_n <= p_max;
end;
$$;
revoke all on function app.privacy_request_count(uuid, text, text, integer, interval) from public, anon, authenticated, service_role;

-- PRK-02 review: the first 5 requests of a business's day are told one by one, the rest in one notice that counts them
create table if not exists app.privacy_request_notice_days (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  day             date not null,
  received        integer not null default 0,
  extra_notice_at timestamptz,
  primary key (organization_id, day)
);
alter table app.privacy_request_notice_days enable row level security;
revoke all on app.privacy_request_notice_days from public, anon, authenticated, service_role;

-- the link behind a token, while the business's public pages are open (else not found)
create or replace function app.privacy_request_link_of(p_token text) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select l.organization_id from app.privacy_request_links l
   where coalesce(p_token, '') ~ '^[A-Za-z0-9_-]{64}$'
     and l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     and app.org_public_pages_open(l.organization_id)
$$;
revoke all on function app.privacy_request_link_of(text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Staff: the link (owners and admins)
-- ----------------------------------------------------------------------------
create or replace function public.privacy_request_link_create(p_org uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.privacy_requests_workable(p_org) then
    raise exception 'the organization is closed' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  insert into app.privacy_request_links as l (organization_id, token_hash, created_by, created_at)
  values (p_org, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), now())
  on conflict (organization_id) do update
    set token_hash = excluded.token_hash, created_by = excluded.created_by, created_at = excluded.created_at,
        view_window_start = null, view_count = 0, submit_window_start = null, submit_count = 0;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'privacy_request_link', 'organizations', p_org, jsonb_build_object('link', 'created'));
  return v_token;
end;
$$;
revoke all on function public.privacy_request_link_create(uuid) from public, anon;
grant execute on function public.privacy_request_link_create(uuid) to authenticated;

create or replace function public.privacy_request_link_revoke(p_org uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  update app.privacy_request_links l
     set token_hash = null, created_at = null, view_window_start = null, view_count = 0, submit_window_start = null, submit_count = 0
   where l.organization_id = p_org and l.token_hash is not null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'privacy_request_link', 'organizations', p_org, jsonb_build_object('link', 'revoked'));
  end if;
  return v_count > 0;
end;
$$;
revoke all on function public.privacy_request_link_revoke(uuid) from public, anon;
grant execute on function public.privacy_request_link_revoke(uuid) to authenticated;

create or replace function public.privacy_request_link_status(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_created timestamptz;
begin
  if not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select l.created_at into v_created from app.privacy_request_links l
   where l.organization_id = p_org and l.token_hash is not null;
  return jsonb_build_object('active', v_created is not null, 'created_at', v_created,
                            'pages_open', app.org_public_pages_open(p_org));
end;
$$;
revoke all on function public.privacy_request_link_status(uuid) from public, anon;
grant execute on function public.privacy_request_link_status(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The public page (service_role only): what the page shows
-- ----------------------------------------------------------------------------
create or replace function public.privacy_request_page(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_org_id uuid := app.privacy_request_link_of(p_token);
  v_org public.organizations;
  v_count integer;
  v_built_with boolean;
begin
  if v_org_id is null then
    raise exception 'privacy page not found' using errcode = 'P0002';
  end if;
  -- the sender first, so one sender's views never fill the link's window
  if not app.privacy_request_count(v_org_id, 'view', p_ip_hash, 60, interval '10 minutes') then
    return jsonb_build_object('rate_limited', true);
  end if;
  update app.privacy_request_links l
     set view_window_start = case when l.view_window_start > now() - interval '10 minutes' then l.view_window_start else now() end,
         view_count = case when l.view_window_start > now() - interval '10 minutes' then l.view_count + 1 else 1 end
   where l.organization_id = v_org_id
  returning l.view_count into v_count;
  if v_count > 300 then
    return jsonb_build_object('rate_limited', true);
  end if;

  select * into v_org from public.organizations o where o.id = v_org_id;
  begin
    v_built_with := coalesce(app.show_built_with(v_org_id), true);
  exception when others then
    v_built_with := true;
  end;
  -- the business's display name and brand only: nothing about any person or record
  return jsonb_build_object(
    'business', v_org.name,
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'built_with', v_built_with);
end;
$$;
revoke all on function public.privacy_request_page(text, text) from public, anon, authenticated;
grant execute on function public.privacy_request_page(text, text) to service_role;

-- the body of the day's extra notice: a count only
create or replace function app.privacy_request_extra_text(p_count integer) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_count = 1 then 'עוד בקשה אחת התקבלה היום. כל הבקשות ברשימת בקשות הפרטיות.'
              else 'עוד ' || p_count || ' בקשות התקבלו היום. כל הבקשות ברשימת בקשות הפרטיות.' end
$$;
revoke all on function app.privacy_request_extra_text(integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The public page (service_role only): a request arrives
-- ----------------------------------------------------------------------------
-- Answers {status: 'received'} for every accepted or honeypot submission, or {rate_limited: true}; the answer never
-- depends on whether the business holds anything about the person. Bad input: 22023 hint privacy_request:invalid.
create or replace function public.privacy_request_submit(
  p_token    text,
  p_payload  jsonb,
  p_ip_hash  text default null,
  p_is_spam  boolean default false
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_org_id uuid := app.privacy_request_link_of(p_token);
  v_type text;
  v_name text;
  v_kind text;
  v_value text;
  v_details text;
  v_count integer;
  v_zone text;
  v_target date;
  v_id uuid;
  v_officer uuid;
  v_today date;
  v_received integer;
  v_extra timestamptz;
begin
  if v_org_id is null then
    raise exception 'privacy page not found' using errcode = 'P0002';
  end if;
  -- every try counts against the sender, the honeypot's included, before anything counts toward the link
  if not app.privacy_request_count(v_org_id, 'submit', p_ip_hash, 3, interval '10 minutes')
     or not app.privacy_request_count(v_org_id, 'submit_day', p_ip_hash, 10, interval '1 day') then
    return jsonb_build_object('rate_limited', true);
  end if;
  if coalesce(p_is_spam, false) then
    return jsonb_build_object('status', 'received');
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid request' using errcode = '22023', hint = 'privacy_request:invalid';
  end if;
  v_type := p_payload ->> 'request_type';
  v_name := nullif(btrim(regexp_replace(coalesce(p_payload ->> 'name', ''), '[[:cntrl:]]', ' ', 'g')), '');
  v_kind := p_payload ->> 'contact_kind';
  v_value := nullif(btrim(coalesce(p_payload ->> 'contact_value', '')), '');
  v_details := nullif(btrim(regexp_replace(coalesce(p_payload ->> 'details', ''), '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g')), '');
  if v_type is null or v_type not in ('access', 'correction', 'erasure')
     or v_name is null or char_length(v_name) > 200
     or v_kind is null or v_kind not in ('email', 'phone')
     or v_value is null or char_length(v_value) > 254
     or (v_kind = 'email' and v_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
     or (v_kind = 'phone' and (v_value !~ '^[0-9+() -]+$' or char_length(regexp_replace(v_value, '[^0-9]', '', 'g')) not between 7 and 15))
     or (v_details is not null and char_length(v_details) > 2000) then
    raise exception 'invalid request' using errcode = '22023', hint = 'privacy_request:invalid';
  end if;

  -- 50 stored requests per link a day
  update app.privacy_request_links l
     set submit_window_start = case when l.submit_window_start > now() - interval '1 day' then l.submit_window_start else now() end,
         submit_count = case when l.submit_window_start > now() - interval '1 day' then l.submit_count + 1 else 1 end
   where l.organization_id = v_org_id
  returning l.submit_count into v_count;
  if v_count > 50 then
    return jsonb_build_object('rate_limited', true);
  end if;

  select coalesce(o.timezone, 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = v_org_id;
  v_today := (now() at time zone v_zone)::date;
  v_target := v_today + 30;

  insert into public.privacy_requests (organization_id, request_type, requester_name, contact_kind, contact_value, details, target_date)
  values (v_org_id, v_type, v_name, v_kind, case when v_kind = 'email' then lower(v_value) else v_value end, v_details, v_target)
  returning id into v_id;

  -- the privacy officer (PRK-06) and the active owners and admins; nothing about the person. The first 5 of the business's
  -- day one by one; then one notice that counts the rest
  insert into app.privacy_request_notice_days as d (organization_id, day, received)
  values (v_org_id, v_today, 1)
  on conflict (organization_id, day) do update set received = d.received + 1
  returning d.received, d.extra_notice_at into v_received, v_extra;
  v_officer := app.privacy_officer(v_org_id);
  if v_received <= 5 then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    select v_org_id, r.user_id, 'system', 'התקבלה בקשת פרטיות חדשה',
           'מועד יעד: ' || to_char(v_target, 'DD/MM/YYYY'), 'privacy_request', v_id
      from (select m.user_id from public.memberships m
             where m.organization_id = v_org_id and m.status = 'active' and m.role in ('owner', 'admin')
            union
            select v_officer where v_officer is not null) r;
  elsif v_extra is null then
    update app.privacy_request_notice_days d set extra_notice_at = now()
     where d.organization_id = v_org_id and d.day = v_today;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    select v_org_id, r.user_id, 'system', 'התקבלו עוד בקשות פרטיות היום',
           app.privacy_request_extra_text(v_received - 5), 'privacy_requests', v_org_id
      from (select m.user_id from public.memberships m
             where m.organization_id = v_org_id and m.status = 'active' and m.role in ('owner', 'admin')
            union
            select v_officer where v_officer is not null) r;
  else
    -- the same notice counts on (its readers see the latest count)
    update public.notifications n set body = app.privacy_request_extra_text(v_received - 5)
     where n.organization_id = v_org_id and n.entity_type = 'privacy_requests' and n.entity_id = v_org_id
       and n.created_at >= v_extra;
  end if;

  return jsonb_build_object('status', 'received');
end;
$$;
revoke all on function public.privacy_request_submit(text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.privacy_request_submit(text, jsonb, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- A privacy erasure of the linked lead or contact empties the request's personal details
-- ----------------------------------------------------------------------------
-- app.audit_erase_core (and PRV-01's retention erasure through it) ends with one `erase` audit entry of the record; this
-- trigger answers it. The request keeps its type, status and dates (the log that the request was handled).
create or replace function app.privacy_requests_erase() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with erased as (
    update public.privacy_requests r
       set requester_name = null, contact_value = null, details = null, verify_note = null,
           refusal_reason = case when r.refusal_reason is not null then 'הסיבה נמחקה (מחיקת פרטיות)' end,
           erased_at = coalesce(r.erased_at, now())
     where r.organization_id = new.organization_id
       and ((new.entity_type = 'leads' and (r.lead_id = new.entity_id or new.entity_id = any (r.former_lead_ids)))
         or (new.entity_type = 'contacts' and (r.contact_id = new.entity_id or new.entity_id = any (r.former_contact_ids))))
    returning r.id)
  select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids from erased e;
  if cardinality(v_ids) > 0 then
    -- the request's own history (its identity note, its refusal reason, and the entry the update above just wrote)
    update public.audit_log a set changes = '{"erased": true}'::jsonb
     where a.organization_id = new.organization_id and a.entity_type = 'privacy_requests' and a.entity_id = any (v_ids);
  end if;
  return null;
end;
$$;
revoke all on function app.privacy_requests_erase() from public, anon, authenticated, service_role;

create or replace trigger audit_log_privacy_requests_erase after insert on public.audit_log
  for each row when (new.action = 'erase' and new.entity_type in ('leads', 'contacts') and new.entity_id is not null)
  execute function app.privacy_requests_erase();

-- ----------------------------------------------------------------------------
-- A merge moves the duplicate's requests to the kept record (through the `merged` entry)
-- ----------------------------------------------------------------------------
create or replace function app.merge_privacy_requests() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.lead_id is not null and v_merged <> new.lead_id then
    update public.privacy_requests r set lead_id = new.lead_id
     where r.organization_id = new.organization_id and r.lead_id = v_merged;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update public.privacy_requests r set contact_id = new.contact_id
     where r.organization_id = new.organization_id and r.contact_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_privacy_requests() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_privacy_requests after insert on public.activities
  for each row
  when (new.type = 'system' and (new.lead_id is not null or new.contact_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_privacy_requests();

notify pgrst, 'reload schema';
