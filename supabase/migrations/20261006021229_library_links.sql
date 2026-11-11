-- =============================================================================
-- LIB-02: a library item sent by a personal tracked link ("שליחה בקישור עם מעקב: מי פתח ומתי, והתראה לנציג. באותה שיטה של
-- מעקב הצפיות בהצעת מחיר")
-- =============================================================================
-- The approved pattern for public secret-link pages (CLAUDE.md hard rule 5; owner, 11 November 2026, LIB-02 named), under
-- its conditions: the page's server file calls one security definer function per need, granted to service_role only, which
-- checks the token and answers only what the page needs; no table is reached directly with the service key.
--
-- * public.library_links: one personal link of one library item (LIB-01) sent to one record (a lead, a contact, a company or
--   a deal; exactly one), by the person who made it (created_by, "the rep"). What staff see: the item, the record, who made
--   it and when, and the customer's views (first_viewed_at, last_viewed_at, view_count, as public.quote_views of QUO-10),
--   and whether it was turned off (revoked_at, revoked_by). Written only by the functions below (no client insert, update or
--   delete grant); read by whoever reads the record (app.can_read_activity_subject, the rule of activities and files).
--   Cascades with the item and with the record (a purge, an erasure). A merge moves the duplicate's links to the kept record
--   (app.merge_library_links on the `merged` entry, as app.merge_messages). Not audited row by row: making and turning off a
--   link write one audit entry on the record each (action 'library_link', {"link": "created"|"revoked", "item": id}, never the
--   token); views are counters, as quote_views.
-- * app.library_link_secrets (no grants): the SHA-256 of the link's token (the token itself is shown once, when made), the
--   link's 10-minute window and the business day it last told the rep. app.library_link_view_counts: 1,024 reused buckets per
--   link for the per-sender limit (no hash stored; the sender is the keyed IP hash with scope "library", re-scoped to the link
--   by app.library_link_sender).
-- * public.library_link_create(org, item, record_type, record_id) (definer, authenticated): whoever writes in the business
--   (app.can_write: owner, admin, manager, member; never a viewer or a support session) in a writable business, for a live
--   record of the business the caller reads (app.library_link_caller_reads: the select policy's rule, app.can_read_record or
--   HEB-08's deputy rule), of an item that may be sent now (app.library_item_sendable: active, inside its window in the
--   business's zone, and a file item with a current file: its newest confirmed files row). At most 100 links per person per
--   hour in a business (hint library_link:rate). Answers the token once.
-- * public.library_link_revoke(org, link) (definer): the link's maker or an owner/admin, for a link of a record the caller
--   reads. Only lessens access: no writable business needed.
-- * The one rule for a link (app.library_link_usable): "not found" (P0002) for an unknown or turned-off token, a business
--   whose public pages are closed (deleted or cancelled, app.org_public_pages_open), an item switched off, out of its window
--   or (a file item) without a current file, and a record in the recycle bin or gone.
-- * public.library_link_public(token, ip_hash) (service_role): counts 120 calls per link and 60 per sender in 10 minutes, right
--   after the token lookup and before anything of the page is read ({"rate_limited": true} past either); then counts the view
--   (first, last, count) and, once per link and business day, tells the rep (kind library_viewed, mutable): the item's title
--   only and the record's type through entity_type (the notice opens the record); never the customer's name, the record's
--   name or anything personal; only while the rep is an active member who still reads the record. Answers only: the business
--   display name (organizations.name), logo and colour, the built-with line, the item's kind, title, description, and its
--   link (a link item) or its file's name, type and size (a file item). No ids, no token, nothing of the record.
-- * public.library_link_public_file(token, ip_hash) (service_role): the same lookup, rule and counters (a download is one more
--   call of the link, not a view); answers the current file's storage path, name and type only, for the route to make a
--   60-second signed link (the staff download's pattern, src/app/o/[orgId]/files/[fileId]).
-- * Sample data (USR-04): a link on a sample record is real work (app.sample_untouched, 021183's body plus one line).
-- * public.library_links has no row audit (like public.quote_views): making and turning off a link are audited by hand on
--   the record (action 'library_link'); views are counters; a merge's move of the links shows through the `merged` entry.
-- * Interim lead's choice until owner question 296 is answered: a link whose maker is no longer an active member keeps
--   serving the customer, and no notice is sent for its views (nobody else is told).
-- Every statement is safe to run twice. No statement starts with drop; no row removal.

-- ----------------------------------------------------------------------------
-- The notification kind (mutable, shown in the settings): the customer opened a link from the library
-- ----------------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_kinds,
  add constraint notifications_kinds check (type in (
    'system', 'assigned', 'task_reminder', 'inquiry', 'automation',
    'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
    'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card', 'signature_reminder',
    'library_viewed'));

alter table public.notification_settings
  drop constraint if exists notification_settings_kinds,
  add constraint notification_settings_kinds check (
    muted <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                   'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                   'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card', 'signature_reminder',
                   'library_viewed']
    and no_push <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                         'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                         'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card', 'signature_reminder',
                         'library_viewed']);

-- ----------------------------------------------------------------------------
-- The links (what staff see)
-- ----------------------------------------------------------------------------
create table if not exists public.library_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  library_item_id  uuid not null,
  lead_id          uuid,
  contact_id       uuid,
  company_id       uuid,
  deal_id          uuid,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users (id) on delete set null,
  first_viewed_at  timestamptz,
  last_viewed_at   timestamptz,
  view_count       integer not null default 0 check (view_count >= 0),
  unique (organization_id, id),
  constraint library_links_one_record check (num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1),
  constraint library_links_views_shape check ((view_count = 0) = (first_viewed_at is null) and (first_viewed_at is null) = (last_viewed_at is null)),
  constraint library_links_item_fk foreign key (organization_id, library_item_id)
    references public.library_items (organization_id, id) on delete cascade,
  constraint library_links_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete cascade,
  constraint library_links_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint library_links_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade,
  constraint library_links_deal_fk foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete cascade
);
create index if not exists library_links_item_idx on public.library_links (organization_id, library_item_id);
create index if not exists library_links_lead_idx on public.library_links (organization_id, lead_id);
create index if not exists library_links_contact_idx on public.library_links (organization_id, contact_id);
create index if not exists library_links_company_idx on public.library_links (organization_id, company_id);
create index if not exists library_links_deal_idx on public.library_links (organization_id, deal_id);
-- the maker's hourly cap
create index if not exists library_links_maker_idx on public.library_links (organization_id, created_by, created_at);

alter table public.library_links enable row level security;
revoke all on public.library_links from anon, authenticated;
grant select on public.library_links to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_links' and policyname = 'library_links_select') then
    -- whoever reads the record reads the links sent to it and their views (the rule of activities and files)
    create policy library_links_select on public.library_links for select to authenticated
      using (app.is_member(organization_id)
             and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The secret and the counters (schema app, no grants)
-- ----------------------------------------------------------------------------
create table if not exists app.library_link_secrets (
  link_id            uuid primary key,
  organization_id    uuid not null,
  -- hex SHA-256 of the token; null = turned off
  token_hash         text unique,
  window_started_at  timestamptz,
  window_count       integer not null default 0,
  -- the business day the rep was last told of a view
  notified_on        date,
  constraint library_link_secrets_link_fk foreign key (organization_id, link_id)
    references public.library_links (organization_id, id) on delete cascade
);
create index if not exists library_link_secrets_link_idx on app.library_link_secrets (organization_id, link_id);
alter table app.library_link_secrets enable row level security;
revoke all on app.library_link_secrets from public, anon, authenticated, service_role;

create table if not exists app.library_link_view_counts (
  link_id       uuid not null references app.library_link_secrets (link_id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  views         integer not null,
  primary key (link_id, bucket)
);
alter table app.library_link_view_counts enable row level security;
revoke all on app.library_link_view_counts from public, anon, authenticated, service_role;

-- The sender, scoped to one link: nothing matches across links or businesses
create or replace function app.library_link_sender(p_link uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_link is null then null
              else encode(sha256(convert_to('library:' || p_link::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.library_link_sender(uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rules
-- ----------------------------------------------------------------------------
-- The business's today (its own zone)
create or replace function app.library_today(p_org uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date
$$;
revoke all on function app.library_today(uuid) from public, anon, authenticated, service_role;

-- A file item's current file: its newest confirmed files row (the rule of the library screen, src/features/library/queries.ts)
create or replace function app.library_item_file(p_org uuid, p_item uuid) returns public.files
language sql stable security definer
set search_path = ''
as $$
  select f.* from public.files f
   where f.organization_id = p_org and f.library_item_id = p_item and f.unconfirmed_since is null
   order by f.created_at desc, f.id desc
   limit 1
$$;
revoke all on function app.library_item_file(uuid, uuid) from public, anon, authenticated, service_role;

-- An item that may go to a customer now: switched on, inside its window (business dates, both ends inclusive), and a file
-- item with a current file (isLibraryItemOfferable plus the file)
create or replace function app.library_item_sendable(p_org uuid, p_item uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.library_items i
     where i.organization_id = p_org and i.id = p_item and i.is_active
       and (i.valid_from is null or i.valid_from <= app.library_today(p_org))
       and (i.valid_until is null or i.valid_until >= app.library_today(p_org))
       and (i.kind = 'link' or (app.library_item_file(p_org, i.id)).id is not null))
$$;
revoke all on function app.library_item_sendable(uuid, uuid) from public, anon, authenticated, service_role;

-- The record of a link is live: of the business, not in the recycle bin
create or replace function app.library_record_live(p_org uuid, p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_lead is not null then exists (select 1 from public.leads r where r.organization_id = p_org and r.id = p_lead and r.deleted_at is null)
    when p_contact is not null then exists (select 1 from public.contacts r where r.organization_id = p_org and r.id = p_contact and r.deleted_at is null)
    when p_company is not null then exists (select 1 from public.companies r where r.organization_id = p_org and r.id = p_company and r.deleted_at is null)
    when p_deal is not null then exists (select 1 from public.deals r where r.organization_id = p_org and r.id = p_deal and r.deleted_at is null)
    else false end
$$;
revoke all on function app.library_record_live(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- The caller reads the record: the rule of its select policy (app.can_read_record on its owner and team, or HEB-08's deputy
-- rule), as app.document_caller_reads (RVW-77); a record of another business, or none, reads as false
create or replace function app.library_link_caller_reads(p_org uuid, p_type text, p_id uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_team uuid;
begin
  if p_org is null or p_id is null or auth.uid() is null then
    return false;
  end if;
  if p_type = 'lead' then
    select r.owner_id, r.team_id into v_owner, v_team from public.leads r where r.organization_id = p_org and r.id = p_id;
  elsif p_type = 'contact' then
    select r.owner_id, r.team_id into v_owner, v_team from public.contacts r where r.organization_id = p_org and r.id = p_id;
  elsif p_type = 'company' then
    select r.owner_id, r.team_id into v_owner, v_team from public.companies r where r.organization_id = p_org and r.id = p_id;
  elsif p_type = 'deal' then
    select r.owner_id, r.team_id into v_owner, v_team from public.deals r where r.organization_id = p_org and r.id = p_id;
  else
    return false;
  end if;
  if not found then
    return false;
  end if;
  return coalesce(app.can_read_record(p_org, v_owner, v_team), false)
      or exists (select 1 from app.deputy_readable(p_type) r where r.organization_id = p_org and r.id = p_id);
end;
$$;
revoke all on function app.library_link_caller_reads(uuid, text, uuid) from public, anon, authenticated, service_role;

-- A link's record as (type, id)
create or replace function app.library_link_record(p_link public.library_links, out record_type text, out record_id uuid)
language sql immutable
set search_path = ''
as $$
  select case when p_link.lead_id is not null then 'lead' when p_link.contact_id is not null then 'contact'
              when p_link.company_id is not null then 'company' when p_link.deal_id is not null then 'deal' end,
         coalesce(p_link.lead_id, p_link.contact_id, p_link.company_id, p_link.deal_id)
$$;
revoke all on function app.library_link_record(public.library_links) from public, anon, authenticated, service_role;

-- The one rule for a link: anything else answers "not found"
create or replace function app.library_link_usable(p_link public.library_links, p_secret app.library_link_secrets) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_link.id is not null
     and p_secret.link_id = p_link.id
     and p_secret.token_hash is not null
     and p_link.revoked_at is null
     and app.org_public_pages_open(p_link.organization_id)
     and app.library_item_sendable(p_link.organization_id, p_link.library_item_id)
     and app.library_record_live(p_link.organization_id, p_link.lead_id, p_link.contact_id, p_link.company_id, p_link.deal_id)
$$;
revoke all on function app.library_link_usable(public.library_links, app.library_link_secrets) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Staff: making and turning off a link
-- ----------------------------------------------------------------------------
create or replace function public.library_link_create(p_org uuid, p_item uuid, p_record_type text, p_record_id uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link public.library_links;
  v_token text;
  v_table text;
begin
  if p_record_type is null or p_record_type not in ('lead', 'contact', 'company', 'deal') or p_record_id is null or p_item is null then
    raise exception 'name a record and an item' using errcode = '22023';
  end if;
  -- a member of a business that cannot write hears why (app.can_write below would refuse it as 42501); an outsider
  -- learns nothing about the business's state
  if app.role_in(p_org) is not null and not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  -- whoever writes in the business (never a viewer or a support session), for a record they read
  if not app.can_write(p_org) or not app.library_link_caller_reads(p_org, p_record_type, p_record_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.library_record_live(p_org,
                                 case when p_record_type = 'lead' then p_record_id end,
                                 case when p_record_type = 'contact' then p_record_id end,
                                 case when p_record_type = 'company' then p_record_id end,
                                 case when p_record_type = 'deal' then p_record_id end) then
    raise exception 'the record is in the recycle bin' using errcode = 'P0001', hint = 'library_link:record';
  end if;
  if not app.library_item_sendable(p_org, p_item) then
    raise exception 'the item cannot be sent now' using errcode = 'P0001', hint = 'library_link:item';
  end if;
  -- at most 100 links per person per hour in a business
  perform pg_advisory_xact_lock(hashtextextended('library_links:' || p_org::text || ':' || auth.uid()::text, 0));
  if (select count(*) from public.library_links l
       where l.organization_id = p_org and l.created_by = auth.uid() and l.created_at > now() - interval '1 hour') >= 100 then
    raise exception 'too many links in an hour' using errcode = 'P0001', hint = 'library_link:rate';
  end if;

  insert into public.library_links (organization_id, library_item_id, lead_id, contact_id, company_id, deal_id, created_by)
  values (p_org, p_item,
          case when p_record_type = 'lead' then p_record_id end,
          case when p_record_type = 'contact' then p_record_id end,
          case when p_record_type = 'company' then p_record_id end,
          case when p_record_type = 'deal' then p_record_id end,
          auth.uid())
  returning * into v_link;

  -- 48 random bytes from three UUIDs, base64url: 64 characters
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  insert into app.library_link_secrets (link_id, organization_id, token_hash)
  values (v_link.id, p_org, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'));

  v_table := case p_record_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies' else 'deals' end;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'library_link', v_table, p_record_id, jsonb_build_object('link', 'created', 'item', p_item));
  return v_token;
end;
$$;
revoke all on function public.library_link_create(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.library_link_create(uuid, uuid, text, uuid) to authenticated;

-- Turning a link off only lessens access: its maker, or an owner or admin, for a record they read
create or replace function public.library_link_revoke(p_org uuid, p_link uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link public.library_links;
  v_record record;
  v_table text;
begin
  select * into v_link from public.library_links l where l.organization_id = p_org and l.id = p_link;
  if v_link.id is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_record := app.library_link_record(v_link);
  if app.role_in(p_org) is null or app.role_in(p_org)::text = 'viewer'
     or not app.library_link_caller_reads(p_org, v_record.record_type, v_record.record_id)
     or not (v_link.created_by = auth.uid() or app.is_admin(p_org)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_link.revoked_at is not null then
    return false;
  end if;
  update public.library_links l set revoked_at = now(), revoked_by = auth.uid()
   where l.organization_id = p_org and l.id = p_link and l.revoked_at is null;
  update app.library_link_secrets s set token_hash = null, window_started_at = null, window_count = 0
   where s.link_id = p_link;
  v_table := case v_record.record_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies' else 'deals' end;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'library_link', v_table, v_record.record_id,
          jsonb_build_object('link', 'revoked', 'item', v_link.library_item_id));
  return true;
end;
$$;
revoke all on function public.library_link_revoke(uuid, uuid) from public, anon;
grant execute on function public.library_link_revoke(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's page
-- ----------------------------------------------------------------------------
-- The lookup and the limits shared by the page and the file: the link (or not found), 'rate' past a limit, else 'ok'
create or replace function app.library_link_take(p_token text, p_ip_hash text, out link public.library_links, out verdict text)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_secret app.library_link_secrets;
  v_count integer;
  v_bucket integer;
  v_views integer;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  select * into v_secret from app.library_link_secrets s where s.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if v_secret.link_id is not null then
    select * into link from public.library_links l where l.organization_id = v_secret.organization_id and l.id = v_secret.link_id;
  end if;
  if v_secret.link_id is null or link.id is null or not app.library_link_usable(link, v_secret) then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  -- 120 calls per link in 10 minutes, counted (one row update) before the page's data is read
  update app.library_link_secrets s
     set window_started_at = case when s.window_started_at > now() - interval '10 minutes' then s.window_started_at else now() end,
         window_count = case when s.window_started_at > now() - interval '10 minutes' then s.window_count + 1 else 1 end
   where s.link_id = v_secret.link_id
  returning s.window_count into v_count;
  if v_count > 120 then
    verdict := 'rate';
    return;
  end if;
  -- FXS-11: 60 calls per sender in 10 minutes, by the server's keyed IP hash scoped to this link
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.library_link_sender(v_secret.link_id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.library_link_view_counts as vc (link_id, bucket, window_start, views)
    values (v_secret.link_id, v_bucket, now(), 1)
    on conflict (link_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      verdict := 'rate';
      return;
    end if;
  end if;
  verdict := 'ok';
end;
$$;
revoke all on function app.library_link_take(text, text) from public, anon, authenticated, service_role;

-- Counts a view and tells the rep once per link and business day (the item's title; the record's type through entity_type)
create or replace function app.library_link_mark_viewed(p_link public.library_links) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_today date := app.library_today(p_link.organization_id);
  v_told uuid;
  v_record record;
  v_owner uuid;
  v_team uuid;
  v_title text;
begin
  update public.library_links l
     set view_count = l.view_count + 1, first_viewed_at = coalesce(l.first_viewed_at, now()), last_viewed_at = now()
   where l.organization_id = p_link.organization_id and l.id = p_link.id;
  -- once a business day, even when two views arrive together
  update app.library_link_secrets s set notified_on = v_today
   where s.link_id = p_link.id and s.notified_on is distinct from v_today
  returning s.link_id into v_told;
  if v_told is null or p_link.created_by is null then
    return;
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = p_link.organization_id and m.user_id = p_link.created_by and m.status = 'active') then
    return;
  end if;
  v_record := app.library_link_record(p_link);
  if v_record.record_type = 'lead' then
    select r.owner_id, r.team_id into v_owner, v_team from public.leads r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  elsif v_record.record_type = 'contact' then
    select r.owner_id, r.team_id into v_owner, v_team from public.contacts r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  elsif v_record.record_type = 'company' then
    select r.owner_id, r.team_id into v_owner, v_team from public.companies r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  else
    select r.owner_id, r.team_id into v_owner, v_team from public.deals r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  end if;
  -- the rep still reads the record (the notice opens it)
  if not (coalesce(app.user_can_read_record(p_link.organization_id, p_link.created_by, v_owner, v_team), false)
          or app.user_deputy_reads(p_link.organization_id, p_link.created_by, v_record.record_type, v_record.record_id)) then
    return;
  end if;
  select i.title into v_title from public.library_items i where i.organization_id = p_link.organization_id and i.id = p_link.library_item_id;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (p_link.organization_id, p_link.created_by, 'library_viewed', 'הלקוח פתח את הקישור ששלחת מהספרייה',
          -- no personal data: a later privacy erasure does not reach notification bodies
          v_title, v_record.record_type, v_record.record_id);
end;
$$;
revoke all on function app.library_link_mark_viewed(public.library_links) from public, anon, authenticated, service_role;

create or replace function public.library_link_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_take record;
  v_link public.library_links;
  v_item public.library_items;
  v_org public.organizations;
  v_file public.files;
  v_built_with boolean;
begin
  v_take := app.library_link_take(p_token, p_ip_hash);
  if v_take.verdict = 'rate' then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_link := v_take.link;
  perform app.library_link_mark_viewed(v_link);

  select * into v_item from public.library_items i where i.organization_id = v_link.organization_id and i.id = v_link.library_item_id;
  select * into v_org from public.organizations o where o.id = v_link.organization_id;
  begin
    v_built_with := coalesce(app.show_built_with(v_link.organization_id), true);
  exception when others then
    v_built_with := true;
  end;
  if v_item.kind = 'file' then
    v_file := app.library_item_file(v_link.organization_id, v_item.id);
  end if;
  return jsonb_build_object(
    'business', v_org.name,
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'built_with', v_built_with,
    'item', jsonb_build_object(
      'kind', v_item.kind,
      'title', v_item.title,
      'description', v_item.description,
      'url', case when v_item.kind = 'link' then v_item.url end,
      'file', case when v_item.kind = 'file' then jsonb_build_object('name', v_file.name, 'mime_type', v_file.mime_type, 'size_bytes', v_file.size_bytes) end));
end;
$$;
revoke all on function public.library_link_public(text, text) from public, anon, authenticated;
grant execute on function public.library_link_public(text, text) to service_role;

create or replace function public.library_link_public_file(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_take record;
  v_link public.library_links;
  v_kind text;
  v_file public.files;
begin
  v_take := app.library_link_take(p_token, p_ip_hash);
  if v_take.verdict = 'rate' then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_link := v_take.link;
  select i.kind into v_kind from public.library_items i where i.organization_id = v_link.organization_id and i.id = v_link.library_item_id;
  if v_kind is distinct from 'file' then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  v_file := app.library_item_file(v_link.organization_id, v_link.library_item_id);
  return jsonb_build_object('path', v_file.storage_path, 'name', v_file.name, 'mime_type', v_file.mime_type);
end;
$$;
revoke all on function public.library_link_public_file(text, text) from public, anon, authenticated;
grant execute on function public.library_link_public_file(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- Merge: the duplicate's links go to the kept record (before the duplicate is deleted), as app.merge_messages
-- ----------------------------------------------------------------------------
create or replace function app.merge_library_links() returns trigger
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
    update public.library_links l set lead_id = new.lead_id
     where l.organization_id = new.organization_id and l.lead_id = v_merged;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update public.library_links l set contact_id = new.contact_id
     where l.organization_id = new.organization_id and l.contact_id = v_merged;
  elsif new.company_id is not null and v_merged <> new.company_id then
    update public.library_links l set company_id = new.company_id
     where l.organization_id = new.organization_id and l.company_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_library_links() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_library_links after insert on public.activities
  for each row
  when (new.type = 'system' and (new.lead_id is not null or new.contact_id is not null or new.company_id is not null)
        and new.metadata ? 'merged_id')
  execute function app.merge_library_links();

-- ----------------------------------------------------------------------------
-- Sample data (USR-04): a link sent to a sample record is real work (021183's body plus the library_links line)
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    -- TASK-06: a sample task a person gave steps to is real work
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id)
       -- TASK-06 part B: a sub-task a person added under it (sample data makes none)
       and not exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- notes, files and meetings are never sample data; nor a library link (LIB-02)
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.library_links where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task, or one a person gave steps to (TASK-06; removing the record would
  -- take such a task with it)
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and (not app.sample_pristine($1, ''task'', t.id)
                          or exists (select 1 from public.task_checklist_items i
                                      where i.organization_id = t.organization_id and i.task_id = t.id)))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id)
       -- MSG-03: sample data sends no messages; one sent or received is real
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- ORD-01: sample data makes no orders; one made is real work
       and not exists (select 1 from public.orders od where od.organization_id = p_org and p_id in (od.contact_id, od.delivery_contact_id))
       -- DOC-01: sample data records no documents; one recorded is real work
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.contact_id = p_id)
       -- PAY-01: sample data records no payments; one recorded is real work
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.contact_id = p_id)
       -- COL-05: sample data holds nobody; a hold set is real work
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- RVW-64 (COL-03): sample data makes no payment promises; one recorded on the customer is real work
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.contact_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id)
       -- MSG-03
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.contact_id = p_id)
       -- PKG-01: sample data opens no punch cards; one opened is real work (the card would go with the contact)
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.contact_id = p_id)
       -- PKG-06: named as the service recipient of a line, or the payer of a card
       and not exists (select 1 from public.quote_lines ql where ql.organization_id = p_org and ql.recipient_contact_id = p_id)
       and not exists (select 1 from public.order_lines ol where ol.organization_id = p_org and ol.recipient_contact_id = p_id)
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.payer_contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.company_id = p_id)
       -- COL-05
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.company_id = p_id)
       -- RVW-64 (COL-03): a payment promise on the company, or on one of its own documents (an opening balance)
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.company_id = p_id)
       and not exists (select 1 from public.payment_promises pp
                         join public.accounting_documents ad on ad.organization_id = pp.organization_id and ad.id = pp.document_id
                        where pp.organization_id = p_org and ad.company_id = p_id)
       -- PKG-06: the company paid for a card someone else holds
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.payer_company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.deal_id = p_id)
       -- DOC-01
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.deal_id = p_id)
       -- PAY-01
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.deal_id = p_id);
  end if;
end;
$$;
revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;
