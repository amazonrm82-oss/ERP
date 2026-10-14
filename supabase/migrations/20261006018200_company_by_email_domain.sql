-- =============================================================================
-- A new contact joins its company by the email domain (CON-09, wave 2)
-- =============================================================================
-- When a person creates a contact with an email and no company, and exactly one
-- company of the organization that the person can read and that is not in the
-- recycle bin has that domain, the contact is linked to it.
--
-- A company's domains (owner's answer, DECISIONS.md, 14 October 2026):
--   1. its own: the host of its website (scheme, user, path, port and a leading
--      "www." removed) and the domain of its own email. Either one matches.
--   2. only when it has no own domain (both missing or public), and only while
--      companies.contact_domain_off is not set: the one domain shared by at least
--      two of its live contacts (primary email, not in the bin), counted among the
--      contacts the caller reads (RLS). When two or more different domains each
--      reach two contacts, the company has no derived domain at all (our rule:
--      an ambiguous company is matched by nobody). public.company_contact_domain()
--      computes it; the company card shows it as "(לפי אנשי הקשר)" with one click
--      to switch it off (contact_domain_off = true; clearing it, null, turns it on).
-- Subdomains (owner, 14 October 2026): the address's full domain is tried first;
-- when no company has it, one label is stripped from the left and tried again,
-- down to the registered domain and never beyond (app.domain_candidates):
-- sales.acme.co.il -> acme.co.il, a.b.c.acme.com -> acme.com, never co.il or com.
-- A registered domain is one label plus a suffix: a two-label suffix from
-- app.domain_suffix() (co.il, org.il, net.il, ac.il, gov.il, muni.il, k12.il,
-- idf.il and a few foreign ones), otherwise the TLD. Order (owner): at each
-- level, own domain before contact-derived; the first tier with any company
-- decides: one company links, two or more link none (a choice on the card).
--
-- Never for a public email domain, from any source: app.public_email_domain() is a
-- closed list (the owner's 19 domains plus more; it only grows, by migration),
-- mirrored by PUBLIC_EMAIL_DOMAINS in src/features/company-domain/domains.ts
-- (a unit test keeps the two equal). The parsing rules (app.email_domain,
-- app.website_domain) are mirrored there too.
--
-- Where it runs: trigger contacts_company_by_domain (before insert, security
-- invoker). It acts only on a person's write (current_user = 'authenticated'),
-- so the contact form, the API and imports get it, while server writers do
-- not: convert_lead() (definer; keeps its own company logic), merges, sample
-- data. It reads companies with the person's rights (RLS decides), through
-- public.company_domain_matches(), which the contact card also uses to offer the
-- companies when two or more match (then nothing is linked).
--   - a company the person picked (company_id set) is never replaced;
--   - an import that mapped a company column (import_jobs.maps_company, set when
--     the job starts) links nothing, even for a row whose company cell is empty;
--   - existing contacts are never changed (no backfill, insert only).
--
-- contacts.company_matched_domain and company_match_kind (exact | parent |
-- contacts; server only, no client grant) keep the domain and the way the link
-- was made, so the card can say "שויך לחברה X לפי דומיין האימייל", "(לפי הדומיין
-- acme.co.il)" or "(לפי אנשי הקשר)" with one click to remove it. Any later change
-- of company_id clears both
-- (same trigger, before update of company_id). The link itself is a normal
-- company_id value; the audit log records it with the insert.
--
-- companies.contact_domain_off (true or null; whoever may edit the company, audited
-- by the existing companies audit trigger; companies has table-level grants).
--
-- Cost: app.company_domain_candidates() (definer, ids only) finds candidates
-- through expression indexes on the companies' website and email domains and on
-- the contacts' email domain; company_domain_matches() (invoker) then reads only
-- those companies by id under RLS and recounts their contacts with the caller's
-- rights (index on contacts (organization_id, company_id)). No stored generated
-- columns on companies: old sample-data snapshots lack them and app.sample_row()
-- would then see every sample company with an email as changed.
--
-- Core CRM behaviour: no plan key.
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- Parsing (immutable; used in indexes)
-- ----------------------------------------------------------------------------
-- a plain host name: labels of letters, digits and inner hyphens, a letters-only top level
create or replace function app.domain_ok(p text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p is not null and char_length(p) <= 253
     and p ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    then p
  end;
$$;

-- "Dana@Acme.co.il" -> "acme.co.il"; null when it is not one address with a valid domain
create or replace function app.email_domain(p text) returns text
language sql immutable
set search_path = ''
as $$
  select app.domain_ok(rtrim(substring(lower(btrim(left(p, 320), E' \t\r\n')) from '^[^@\s]+@([^@\s]+)$'), '.'));
$$;

-- "https://www.Acme.co.il:443/about?x=1" -> "acme.co.il"
create or replace function app.website_domain(p text) returns text
language sql immutable
set search_path = ''
as $$
  select app.domain_ok(
    regexp_replace(
      rtrim(
        split_part(
          split_part(split_part(split_part(
            regexp_replace(regexp_replace(lower(btrim(left(p, 2000), E' \t\r\n')), '^[a-z][a-z0-9+.-]*://', ''), '^[^/?#]*@', ''),
            '/', 1), '?', 1), '#', 1),
          ':', 1),
        '.'),
      '^www\.', ''));
$$;

-- PUBLIC_EMAIL_DOMAINS (keep the list between the two markers identical to the TS one)
create or replace function app.public_email_domain(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p = any (array[
    -- public-domains:start
    'gmail.com', 'googlemail.com',
    'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
    'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'outlook.com', 'live.com', 'live.co.uk', 'msn.com',
    'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'mail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de',
    'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'fastmail.com', 'zoho.com', 'hey.com',
    'yandex.com', 'yandex.ru', 'mail.ru', 'inbox.ru', 'bk.ru', 'list.ru',
    'qq.com', '163.com',
    'walla.co.il', 'walla.com', '012.net.il', '013.net', '013net.net', 'netvision.net.il',
    'bezeqint.net', 'zahav.net.il', 'inter.net.il', 'barak.net.il', 'smile.net.il',
    '017.net.il', 'nana10.co.il',
    'hotmail.co.il', 'yahoo.co.il', 'outlook.co.il', 'nana.co.il', 'actcom.co.il',
    -- website and mail hosts: a site or address under them is never the own domain of a company
    'wixsite.com', 'wix.com', 'myshopify.com', 'wordpress.com', 'weebly.com', 'github.io', 'gitlab.io',
    'blogspot.com', 'blogspot.co.il', 'netlify.app', 'vercel.app', 'herokuapp.com', 'squarespace.com',
    'webflow.io', 'sites.google.com', 'pages.dev', 'web.app', 'firebaseapp.com', 'azurewebsites.net',
    'godaddysites.com', 'business.site', 'tumblr.com', 'carrd.co', 'linktr.ee'
    -- public-domains:end
  ]::text[]);
$$;

-- Two-label suffixes under which a registered domain has three labels (owner: the Israeli second
-- levels; ours: a few common foreign ones). Every other registered domain is one label plus the TLD.
-- DOMAIN_SUFFIXES in domains.ts mirrors the list between the markers.
create or replace function app.domain_suffix(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p = any (array[
    -- domain-suffixes:start
    'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il', 'k12.il', 'idf.il',
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'co.za', 'co.jp', 'com.cn', 'com.tr',
    'co.in', 'com.mx', 'com.sg', 'co.kr', 'com.hk', 'com.ar', 'com.tw', 'co.th', 'com.my', 'com.ph', 'co.id', 'com.ua',
    'com.pl', 'co.at', 'or.at', 'com.cy', 'com.gr', 'com.eg', 'com.sa', 'co.ae', 'ac.za', 'org.nz', 'ac.nz', 'ac.jp',
    'ne.jp', 'or.jp', 'org.br', 'net.br', 'com.co', 'com.pe', 'com.vn', 'co.ke', 'com.ng'
    -- domain-suffixes:end
  ]::text[]);
$$;

-- "sales.acme.co.il" -> "acme.co.il", "a.b.acme.com" -> "acme.com"; null for a bare suffix ("co.il", "com")
create or replace function app.registered_domain(p text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when x.n >= 3 and app.domain_suffix(x.l[x.n - 1] || '.' || x.l[x.n]) then array_to_string(x.l[x.n - 2:x.n], '.')
    when x.n = 2 and app.domain_suffix(p) then null
    when x.n >= 2 then array_to_string(x.l[x.n - 1:x.n], '.')
  end
  from (select string_to_array(app.domain_ok(p), '.') as l, cardinality(string_to_array(app.domain_ok(p), '.')) as n) x;
$$;

-- The domains an address is matched by, most specific first: the full domain, then one label
-- less each time, down to the registered domain and never beyond. Empty when any of them is
-- public (a free mail provider or a site host: x.wixsite.com never matches) or there is no
-- registered domain.
create or replace function app.domain_candidates(p text) returns text[]
language sql immutable
set search_path = ''
as $$
  with lv as (
    select array_to_string(x.l[i:x.n], '.') as d, i
      from (select string_to_array(app.domain_ok(p), '.') as l,
                   cardinality(string_to_array(app.domain_ok(p), '.')) as n,
                   cardinality(string_to_array(app.registered_domain(p), '.')) as k) x,
           generate_series(1, x.n - x.k + 1) i
     where x.k is not null
  )
  select case when bool_or(app.public_email_domain(lv.d)) then '{}'::text[]
              else coalesce(array_agg(lv.d order by lv.i), '{}'::text[]) end
    from lv;
$$;

-- the company's own domain for display: the website's, else its email's; only a usable one
create or replace function app.company_own_domain(p_website text, p_email text) returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(
    (select w from (select app.website_domain(p_website) as w) x where cardinality(app.domain_candidates(w)) > 0),
    (select e from (select app.email_domain(p_email) as e) y where cardinality(app.domain_candidates(e)) > 0)
  );
$$;

revoke all on function app.domain_suffix(text) from public, anon;
revoke all on function app.registered_domain(text) from public, anon;
revoke all on function app.domain_candidates(text) from public, anon;
grant execute on function app.domain_suffix(text) to authenticated, service_role;
grant execute on function app.registered_domain(text) to authenticated, service_role;
grant execute on function app.domain_candidates(text) to authenticated, service_role;
revoke all on function app.company_own_domain(text, text) from public, anon;
grant execute on function app.company_own_domain(text, text) to authenticated, service_role;
revoke all on function app.domain_ok(text) from public, anon;
revoke all on function app.email_domain(text) from public, anon;
revoke all on function app.website_domain(text) from public, anon;
revoke all on function app.public_email_domain(text) from public, anon;
grant execute on function app.domain_ok(text) to authenticated, service_role;
grant execute on function app.email_domain(text) to authenticated, service_role;
grant execute on function app.website_domain(text) to authenticated, service_role;
grant execute on function app.public_email_domain(text) to authenticated, service_role;

create index if not exists companies_website_domain_idx
  on public.companies (organization_id, app.website_domain(website))
  where deleted_at is null;
create index if not exists companies_email_domain_idx
  on public.companies (organization_id, app.email_domain(email))
  where deleted_at is null;

-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
-- server only: no client grant (contacts has per-column insert/update grants since 0073)
alter table public.contacts add column if not exists company_matched_domain text;
alter table public.contacts drop constraint if exists contacts_company_matched_domain_len;
alter table public.contacts add constraint contacts_company_matched_domain_len
  check (company_matched_domain is null or char_length(company_matched_domain) <= 253);
-- how the link was made: exact = the company's own domain is the address's full domain;
-- parent = its own domain is a parent of it (labels stripped); contacts = the domain its contacts give it
alter table public.contacts add column if not exists company_match_kind text;
alter table public.contacts drop constraint if exists contacts_company_match_kind_check;
alter table public.contacts add constraint contacts_company_match_kind_check
  check (company_match_kind is null or company_match_kind in ('exact', 'parent', 'contacts'));

-- CON-09: true = this company is matched only by its own website or email; null = on
alter table public.companies add column if not exists contact_domain_off boolean;
alter table public.companies drop constraint if exists companies_contact_domain_off_true;
alter table public.companies add constraint companies_contact_domain_off_true check (contact_domain_off is not false);

-- the contacts of a company by their email domain (the derived domain)
create index if not exists contacts_company_email_domain_idx
  on public.contacts (organization_id, app.email_domain(email))
  where deleted_at is null and company_id is not null;

-- set once when the job starts: the file's company column was mapped
alter table public.import_jobs add column if not exists maps_company boolean not null default false;
grant insert (maps_company) on public.import_jobs to authenticated;

-- ----------------------------------------------------------------------------
-- The companies with an email's domain, read with the caller's rights
-- ----------------------------------------------------------------------------
-- The one non-public domain at least two of the company's live contacts share, among the
-- contacts the caller reads; null when none or when two or more domains reach two.
-- Computed whatever the company's own domain and contact_domain_off are (the card shows both).
create or replace function public.company_contact_domain(p_org uuid, p_company uuid)
returns text
language sql stable security invoker
set search_path = ''
as $$
  select case when count(*) = 1 then min(t.dom) end
    from (
      select app.email_domain(k.email) as dom
        from public.contacts k
       where k.organization_id = p_org
         and k.company_id = p_company
         and k.deleted_at is null
         and app.email_domain(k.email) is not null
         and cardinality(app.domain_candidates(app.email_domain(k.email))) > 0
       group by 1
      having count(*) >= 2
    ) t;
$$;

revoke all on function public.company_contact_domain(uuid, uuid) from public, anon, service_role;
grant execute on function public.company_contact_domain(uuid, uuid) to authenticated;

-- Candidate companies for a list of domains, found through the expression indexes. Security
-- definer on purpose: under RLS the planner must run app.can_read_record() on every company of
-- the organization before a non-leakproof domain function (measured: 3.5 s at 20,000 companies),
-- so this reads the indexes without RLS and returns ids only, for members of the organization.
-- Its caller (company_domain_matches, security invoker) then reads the companies by id with the
-- caller's rights and decides; nothing is returned to a person from here directly (schema app).
--   own:      companies whose website or own email domain is in the list;
--   contacts: companies with two or more live contacts on a domain of the list (all contacts,
--             a superset of what the caller reads; the caller recounts with RLS).
-- No row cap: a cap here runs before RLS and could cut off the one company the caller reads.
-- Each side is an exact index lookup on at most a handful of domains, returning ids only.
create or replace function app.company_domain_candidates(p_org uuid, p_domains text[])
returns table (company_id uuid, domain text, by_contacts boolean)
language sql stable security definer
set search_path = ''
as $$
  (select c.id, app.website_domain(c.website), false
     from public.companies c
    where app.is_member(p_org)
      and c.organization_id = p_org and c.deleted_at is null
      and app.website_domain(c.website) = any (p_domains))
  union all
  (select c.id, app.email_domain(c.email), false
     from public.companies c
    where app.is_member(p_org)
      and c.organization_id = p_org and c.deleted_at is null
      and app.email_domain(c.email) = any (p_domains))
  union all
  (with on_domain as materialized (
     -- materialized, so the planner reads the email-domain index first instead of walking
     -- every contact by company to save a sort (seen: 3.7 s at 100,000 contacts)
     select k.company_id, app.email_domain(k.email) as v
       from public.contacts k
      where app.is_member(p_org)
        and k.organization_id = p_org and k.deleted_at is null and k.company_id is not null
        and app.email_domain(k.email) = any (p_domains)
   )
   select o.company_id, o.v, true
     from on_domain o
    group by 1, 2
   having count(*) >= 2);
$$;

revoke all on function app.company_domain_candidates(uuid, text[]) from public, anon;
grant execute on function app.company_domain_candidates(uuid, text[]) to authenticated;

-- The companies a new address belongs to, in tiers (owner, 14 October 2026): for the full domain,
-- then for each parent down to the registered domain (app.domain_candidates), first the companies
-- whose own website or email has it, then those whose contacts give it. The first tier with any
-- company decides. Each row says the domain it matched and how (exact | parent | contacts). Only
-- rows of that tier are returned (at most 7, so the card can tell 6 from more): one row means a link, more mean "דומיין שמתאים לכמה
-- חברות" and a choice by hand on the contact card. Security invoker: the companies
-- (by id, a leakproof equality, so through the primary key) and the contact counts are read with
-- the caller's rights.
create or replace function public.company_domain_matches(p_org uuid, p_email text)
returns table (id uuid, name text, domain text, kind text)
language sql stable security invoker
set search_path = ''
as $$
  with cand as (
    select u.v, u.ord
      from unnest(app.domain_candidates(app.email_domain(p_email))) with ordinality as u(v, ord)
  ),
  pre as (
    select p.company_id, p.domain, p.by_contacts
      from app.company_domain_candidates(p_org, (select coalesce(array_agg(cand.v), '{}') from cand)) p
  ),
  hits as (
    select c.id, c.name, p.domain, cand.ord, p.by_contacts
      from pre p
      join cand on cand.v = p.domain
      join public.companies c on c.organization_id = p_org and c.id = p.company_id
     where c.deleted_at is null
       and (not p.by_contacts
            or (c.contact_domain_off is null
                and app.company_own_domain(c.website, c.email) is null
                and public.company_contact_domain(p_org, c.id) = p.domain))
  ),
  -- the first tier decides (owner, 14 October 2026): at each level, from the full domain to the
  -- registered one, a company's own domain comes before a domain its contacts give it
  tier as (
    select h.ord, h.by_contacts from hits h order by h.ord, h.by_contacts limit 1
  ),
  best as (
    select distinct on (h.id) h.id, h.name, h.domain, h.by_contacts, h.ord
      from hits h
      join tier t on t.ord = h.ord and t.by_contacts = h.by_contacts
     order by h.id
  )
  select b.id, b.name, b.domain,
         case when b.by_contacts then 'contacts' when b.ord = 1 then 'exact' else 'parent' end
    from best b
   order by b.name, b.id
   limit 7;
$$;

revoke all on function public.company_domain_matches(uuid, text) from public, anon, service_role;
grant execute on function public.company_domain_matches(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The trigger
-- ----------------------------------------------------------------------------
create or replace function app.contacts_company_by_domain() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_rows record;
  v_count integer := 0;
  v_pick record;
begin
  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      new.company_matched_domain := null;
      new.company_match_kind := null;
    end if;
    return new;
  end if;

  new.company_matched_domain := null;
  new.company_match_kind := null;
  if new.company_id is not null or new.deleted_at is not null or nullif(btrim(new.email), '') is null then
    return new;
  end if;
  -- a person's write only: conversion, merges and sample data keep their own logic
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- an import that mapped a company column decides the company itself
  if new.import_job_id is not null and exists (
    select 1 from public.import_jobs j
     where j.organization_id = new.organization_id and j.id = new.import_job_id and j.maps_company
  ) then
    return new;
  end if;

  for v_rows in select x.id, x.domain, x.kind from public.company_domain_matches(new.organization_id, new.email) x limit 2 loop
    v_count := v_count + 1;
    v_pick := v_rows;
  end loop;
  if v_count = 1 then
    new.company_id := v_pick.id;
    new.company_matched_domain := v_pick.domain;
    new.company_match_kind := v_pick.kind;
  end if;
  return new;
end;
$$;

revoke all on function app.contacts_company_by_domain() from public, anon;
grant execute on function app.contacts_company_by_domain() to authenticated, service_role;

create or replace trigger contacts_company_by_domain
  before insert or update of company_id on public.contacts
  for each row execute function app.contacts_company_by_domain();
