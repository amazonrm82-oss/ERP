-- =============================================================================
-- 021237 Public business page (BIZ-01)
-- =============================================================================
-- "דף עסק ציבורי לעסק שאין לו אתר: לוגו, תיאור, שירותים ומחירים מהקטלוג, שעות פעילות, כפתור WhatsApp, קביעת תור וטופס
-- פנייה." Owner, 3 November 2026, answer (70) ב: every plan, its own key `public_page`. Owner, 11 November 2026, answer
-- (271) ב: a public secret-link page under hard rule 5's approved pattern (one security definer function per need,
-- service_role only, no direct table access, only public fields, rate limits, database tests, an independent review).
--
-- * public.business_pages: one row per business (owners and admins of a writable business; members do not see it).
--   is_active (off by default), a short description (`about`), which of the business's own details show (phone,
--   WhatsApp from the same phone, website, the business's working hours, the contact form) and up to 20 booking pages
--   to link to (booking_page_ids, checked to be the business's own; at read time only the open ones are listed). The
--   secret `token` is made by the server (no client grant on it; its link is /f/biz/<token>). No delete: switching off is
--   the way to take the page down; the business's own removal cascades. Audited.
--   app.business_pages_check (definer; the outsider guard first, so a person outside the business gets RLS's plain
--   refusal): switching the page on (a new row that is on, or off -> on) needs the plan key (hint feature:public_page);
--   every booking page named belongs to the business, once each (hint business_page:booking_page).
-- * Its contact form: a row of public.forms of the new kind 'page' (forms.business_page_id, cascades with the page),
--   made by the page's insert trigger: no owner, the business's own lead distribution (assign_mode round_robin), source
--   "דף העסק" (kind business_page, made once per business). A page form is made and changed only by its trigger (hint
--   form:page; app.guard_form = 021180's body plus the 'page' branch; app.forms_page_lock). Kind 'page' is not a web form:
--   it does not count against max_forms, is not served by intake_form() or the form routes, and intake_submit skips the
--   field rules of 'form' (as the card's, the widget's and Meta's).
-- * public.business_page_public(token, ip_hash) and public.business_page_submit(token, payload, ip_hash, user_agent,
--   is_spam): security definer, service_role only. One not-found rule app.business_page_open: the page is on, the plan
--   holds `public_page` and the business's public pages are open (app.org_public_pages_open: not deleted, not
--   cancelled). The page answers only public fields: the display name (organizations.name), logo, colour, built-with, the
--   description, and, as switched on, the business phone, its WhatsApp digits, its website, its weekly working hours and
--   the titles and tokens of the listed booking pages that are open now (app.booking_page_state = 'open', not closed by
--   CAL-10's race closure); never an id, a person, a count or anything of a customer.
--   Limit, counted after the token lookup: 60 views per sender in 10 minutes (the server's keyed IP hash, scope `bizpage`,
--   scoped again per page by app.business_page_sender; 1,024 reused buckets per page in app.business_page_view_counts, no
--   hash kept). No page-wide cap (review, 12 November 2026): a handful of addresses could use it up and keep the page down
--   for every real customer; like the business card and the widget, only the per-sender limit holds. The submit passes only name, phone,
--   email, message and the campaign keys to intake_submit (its limits: 10 per sender in 10 minutes and 500 an hour per
--   form) and answers its status only. Like the business card, the page is published to everyone, so it is left out of
--   OPS-02's shared not-found limit of the secret-link pages (the lead's call, owner (42) ד).
-- * public.link_preview_public (021084's body): the closed kind list gains 'page' (a listed preview bot gets the display
--   name and logo only, by app.business_page_open); nothing else changes.
-- * The plan key: personal, basic, pro and business on; app.plan_key_defaults (021235's body) plus "public_page": false;
--   every other plan holds it off. public.plans_public (021235's body): the closed landing list gains 'public_page' after
--   'business_card' (the order of PLAN_CAPABILITIES); nothing else changes.
--
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The plan key (owner (70) ב: every plan)
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": {}, "features": { "public_page": true } },
  "basic": { "limits": {}, "features": { "public_page": true } },
  "pro": { "limits": {}, "features": { "public_page": true } },
  "business": { "limits": {}, "features": { "public_page": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- 021235's fallback with the key (a plan that does not hold it: off)
create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": false,
    "price_lists": false,
    "discounts": false,
    "quotes": false,
    "orders": false,
    "documents": false,
    "payments": false,
    "balances": false,
    "collection": false,
    "money_waiting": false,
    "consents": false,
    "segments": false,
    "goals": false,
    "granular_permissions": false,
    "booking_page": false,
    "business_card": false,
    "qr_codes": false,
    "site_widget": false,
    "retention": false,
    "remove_built_with": false,
    "payment_links": false,
    "instant_reply": false,
    "auto_reassign": false,
    "dashboards": false,
    "goals_per_rep": false,
    "booking_team_pages": false,
    "lead_distribution": false,
    "campaign_costs": false,
    "punch_cards": false,
    "meta_leads": false,
    "meeting_reminders": false,
    "signatures": false,
    "sms": false,
    "review_requests": false,
    "public_page": false
  },
  "limits": {
    "max_products": 0,
    "max_price_lists": 0,
    "max_quote_templates": 0,
    "max_booking_pages": 0,
    "max_booking_pages_per_user": 0,
    "max_segments": 0,
    "max_qr_codes": 0,
    "max_pdf_per_month": 0,
    "max_customer_emails_per_month": 0,
    "max_customer_emails_per_day": 0,
    "max_custom_reports": 0,
    "max_custom_objects": 0,
    "max_teams": 0,
    "max_whatsapp_numbers": 0,
    "view_seats_per_paid_seat": 0,
    "max_site_widgets": 0,
    "max_business_cards_per_user": 0,
    "max_booking_team_pages": 0,
    "ai_credits_per_month": 0,
    "ai_credits_per_user_per_month": 0,
    "max_signatures_per_month": 0,
    "max_sms_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- every other plan (the hidden free plan, a plan added in the panel) holds it too, off
update public.plans p
   set features = jsonb_build_object('public_page', false) || coalesce(p.features, '{}'::jsonb)
 where not (coalesce(p.features, '{}'::jsonb) ? 'public_page');

-- ----------------------------------------------------------------------------
-- The page settings: one row per business
-- ----------------------------------------------------------------------------
create table if not exists public.business_pages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  token            text not null unique default replace(gen_random_uuid()::text, '-', ''),
  is_active        boolean not null default false,
  about            text check (char_length(about) between 1 and 1000),
  show_phone       boolean not null default true,
  show_whatsapp    boolean not null default true,
  show_website     boolean not null default true,
  show_hours       boolean not null default true,
  show_form        boolean not null default true,
  booking_page_ids uuid[] not null default '{}' check (cardinality(booking_page_ids) <= 20),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id),
  unique (organization_id, id)
);

alter table public.business_pages enable row level security;
revoke all on public.business_pages from anon, authenticated;
grant select on public.business_pages to authenticated;
grant insert (organization_id, is_active, about, show_phone, show_whatsapp, show_website, show_hours, show_form, booking_page_ids)
  on public.business_pages to authenticated;
grant update (is_active, about, show_phone, show_whatsapp, show_website, show_hours, show_form, booking_page_ids)
  on public.business_pages to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_pages' and policyname = 'business_pages_select') then
    create policy business_pages_select on public.business_pages for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_pages' and policyname = 'business_pages_insert') then
    create policy business_pages_insert on public.business_pages for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_pages' and policyname = 'business_pages_update') then
    create policy business_pages_update on public.business_pages for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger business_pages_touch before update on public.business_pages
  for each row execute function app.touch_row();
create or replace trigger business_pages_audit after insert or update or delete on public.business_pages
  for each row execute function app.audit_row();

-- The plan key to switch the page on, and the booking pages it names. The outsider guard first, so a person outside the
-- business gets RLS's plain refusal and learns nothing about its plan or its booking pages.
create or replace function app.business_pages_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if new.is_active and (tg_op = 'INSERT' or not old.is_active)
     and not app.org_has_feature(new.organization_id, 'public_page') then
    raise exception 'the business page is not in the plan' using errcode = 'P0001', hint = 'feature:public_page';
  end if;
  if (tg_op = 'INSERT' or new.booking_page_ids is distinct from old.booking_page_ids)
     and (array_position(new.booking_page_ids, null) is not null
          or cardinality(new.booking_page_ids) <> (select count(distinct x) from unnest(new.booking_page_ids) x)
          or exists (select 1 from unnest(new.booking_page_ids) x
                      where not exists (select 1 from public.booking_pages b
                                         where b.organization_id = new.organization_id and b.id = x))) then
    raise exception 'a business page links only to the business''s own booking pages' using errcode = 'P0001', hint = 'business_page:booking_page';
  end if;
  return new;
end;
$$;
revoke all on function app.business_pages_check() from public, anon, authenticated;

create or replace trigger business_pages_check before insert or update on public.business_pages
  for each row execute function app.business_pages_check();

-- ----------------------------------------------------------------------------
-- The page's contact form: a forms row of kind 'page'
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_kind_check'
                  and pg_get_constraintdef(oid) like '%''page''%') then
    alter table public.forms drop constraint if exists forms_kind_check;
    alter table public.forms add constraint forms_kind_check check (kind in ('form', 'webhook', 'card', 'widget', 'meta', 'page'));
  end if;
end;
$$;

alter table public.forms add column if not exists business_page_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_business_page_fk') then
    alter table public.forms add constraint forms_business_page_fk foreign key (organization_id, business_page_id)
      references public.business_pages (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_page_shape') then
    alter table public.forms add constraint forms_page_shape check ((kind = 'page') = (business_page_id is not null));
  end if;
end;
$$;
create unique index if not exists forms_business_page_idx on public.forms (organization_id, business_page_id)
  where business_page_id is not null;

-- app.guard_form: its 021180 body plus the page branch (a page form is made only with its business page)
create or replace function app.guard_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
  v_count bigint;
begin
  if new.kind = 'card' then
    if coalesce(current_setting('app.card_form', true), '') <> 'on' then
      raise exception 'a card form is made with its card' using errcode = 'P0001', hint = 'form:card';
    end if;
    return new;
  end if;
  if new.kind = 'widget' then
    if coalesce(current_setting('app.widget_form', true), '') <> 'on' then
      raise exception 'a widget form is made with its widget' using errcode = 'P0001', hint = 'form:widget';
    end if;
    return new;
  end if;
  -- CAP-11 (021180): a Meta Lead Ads form is made and changed with its meta_lead_forms row
  if new.kind = 'meta' then
    if coalesce(current_setting('app.meta_form', true), '') <> 'on' then
      raise exception 'a Meta form is made with its page settings' using errcode = 'P0001', hint = 'form:meta';
    end if;
    return new;
  end if;
  -- BIZ-01 (021237): the business page's contact form is made with the page
  if new.kind = 'page' then
    if coalesce(current_setting('app.page_form', true), '') <> 'on' then
      raise exception 'a business page form is made with its page' using errcode = 'P0001', hint = 'form:page';
    end if;
    return new;
  end if;
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.kind = 'webhook' then
    if not app.org_has_feature(new.organization_id, 'api') then
      raise exception 'webhooks are not included in this plan' using errcode = 'P0001', hint = 'feature:api';
    end if;
    return new;
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_forms');
  if v_limit is not null then
    select count(*) into v_count from public.forms f
      where f.organization_id = new.organization_id and f.kind = 'form' and f.id <> new.id;
    if v_count + 1 > v_limit then
      raise exception 'plan limit reached (max_forms = %)', v_limit using errcode = 'P0001', hint = 'limit:max_forms';
    end if;
  end if;
  return new;
end;
$$;

-- whether a business page still exists (for the lock below, which runs with the caller's rights)
create or replace function app.business_page_exists(p_org uuid, p_page uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.business_pages b where b.organization_id = p_org and b.id = p_page)
$$;
revoke all on function app.business_page_exists(uuid, uuid) from public, anon;
grant execute on function app.business_page_exists(uuid, uuid) to authenticated, service_role;

-- A person never changes a page form, and deletes it only with its page (the cascade, once the page is gone).
-- Security invoker on purpose: current_user tells a person's write from the page's own trigger.
create or replace function app.forms_page_lock() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and old.kind = 'page' then
    if tg_op = 'UPDATE' or app.business_page_exists(old.organization_id, old.business_page_id) then
      raise exception 'a business page form changes with its page' using errcode = 'P0001', hint = 'form:page';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function app.forms_page_lock() from public, anon, authenticated;

create or replace trigger forms_page_lock before update or delete on public.forms
  for each row execute function app.forms_page_lock();

-- The page's form, made with it: no owner, the business's distribution, source "דף העסק" (made once per business)
create or replace function app.business_pages_make_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_source uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('business_page_source:' || new.organization_id::text, 0));
  select s.id into v_source from public.lead_sources s
   where s.organization_id = new.organization_id
     and (s.kind = 'business_page' or btrim(s.name) = 'דף העסק')
   order by s.is_active desc, (s.kind = 'business_page') desc, s.created_at
   limit 1;
  if v_source is null then
    insert into public.lead_sources (organization_id, name, kind)
    values (new.organization_id, 'דף העסק', 'business_page')
    returning id into v_source;
  end if;
  perform set_config('app.page_form', 'on', true);
  insert into public.forms (organization_id, kind, name, title, assign_mode, source_id, is_active, business_page_id)
  values (new.organization_id, 'page', 'דף העסק', 'צרו קשר', 'round_robin', v_source, true, new.id);
  perform set_config('app.page_form', '', true);
  return null;
end;
$$;
revoke all on function app.business_pages_make_form() from public, anon, authenticated;

create or replace trigger business_pages_make_form after insert on public.business_pages
  for each row execute function app.business_pages_make_form();

-- ----------------------------------------------------------------------------
-- The public page
-- ----------------------------------------------------------------------------
-- Views per sender: no row per view. A fixed set of counters per page (1,024 buckets picked by the scoped sender), each
-- counting its 10-minute window and reused by the next one (an update, never a delete). No hash is stored.
create table if not exists app.business_page_view_counts (
  page_id      uuid not null references public.business_pages (id) on delete cascade,
  bucket       integer not null check (bucket between 0 and 1023),
  window_start timestamptz not null,
  views        integer not null,
  primary key (page_id, bucket)
);
alter table app.business_page_view_counts enable row level security;
revoke all on app.business_page_view_counts from public, anon, authenticated, service_role;

create or replace function app.business_page_sender_limit() returns integer
language sql immutable
set search_path = ''
as $$ select 60 $$;
revoke all on function app.business_page_sender_limit() from public, anon, authenticated, service_role;

-- The sender, scoped to one page: SHA-256 of the page id and the server's keyed IP hash, so the same visitor is a
-- different sender on every page and nothing matches across pages or businesses.
create or replace function app.business_page_sender(p_page uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_page is null then null
              else encode(sha256(convert_to('bizpage:' || p_page::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.business_page_sender(uuid, text) from public, anon, authenticated, service_role;

-- The one not-found rule: the page is on, the plan holds the key, the business's public pages are open
create or replace function app.business_page_open(p_page public.business_pages) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_page.id is not null and p_page.is_active
     and app.org_public_pages_open(p_page.organization_id)
     and app.org_has_feature(p_page.organization_id, 'public_page')
$$;
revoke all on function app.business_page_open(public.business_pages) from public, anon, authenticated;

create or replace function public.business_page_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_page public.business_pages;
  v_bucket integer;
  v_views integer;
  v_phone_e164 text;
  v_hours jsonb;
  v_booking jsonb;
  v_result jsonb;
begin
  select * into v_page from public.business_pages b where b.token = coalesce(p_token, '');
  if not coalesce(app.business_page_open(v_page), false) then
    raise exception 'business page not found' using errcode = 'P0002';
  end if;

  -- after the lookup: 60 views per sender in 10 minutes (no page-wide cap)
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.business_page_sender(v_page.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.business_page_view_counts as vc (page_id, bucket, window_start, views)
    values (v_page.id, v_bucket, now(), 1)
    on conflict (page_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > app.business_page_sender_limit() then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  if v_page.show_hours then
    select c.working_hours into v_hours from public.org_calendar_settings c where c.organization_id = v_page.organization_id;
    if v_hours is not null and (jsonb_typeof(v_hours) <> 'object' or not app.working_hours_ok(v_hours)) then
      v_hours := null;
    end if;
  end if;

  -- the listed booking pages that are open now, in the page's order: title and token only
  select coalesce(jsonb_agg(jsonb_build_object('title', b.title, 'token', b.token) order by x.n), '[]'::jsonb)
    into v_booking
    from unnest(v_page.booking_page_ids) with ordinality x(id, n)
    join public.booking_pages b on b.organization_id = v_page.organization_id and b.id = x.id
   where app.booking_page_state(b) = 'open'
     and not exists (select 1 from app.booking_page_closures c where c.page_id = b.id and c.closed_until > now());

  -- only public fields: no ids, no people, no counts
  select app.normalize_phone(o.phone) into v_phone_e164 from public.organizations o where o.id = v_page.organization_id;
  select jsonb_build_object(
           'business', o.name,
           'brand', jsonb_build_object('logo', o.logo_path, 'color', o.brand_color),
           'built_with', app.show_built_with(o.id),
           'about', v_page.about,
           'phone', case when v_page.show_phone then nullif(btrim(o.phone), '') end,
           'whatsapp', case when v_page.show_whatsapp and v_phone_e164 ~ '^\+[1-9][0-9]{7,14}$' then substr(v_phone_e164, 2) end,
           'website', case when v_page.show_website then nullif(btrim(o.website), '') end,
           'hours', v_hours,
           'booking', v_booking,
           -- the contact form: a business that takes leads (a read-only or suspended one does)
           'form', v_page.show_form and app.org_takes_leads(o.id))
    into v_result
    from public.organizations o
   where o.id = v_page.organization_id;
  return jsonb_strip_nulls(v_result);
end;
$$;
revoke all on function public.business_page_public(text, text) from public, anon, authenticated;
grant execute on function public.business_page_public(text, text) to service_role;

-- The contact form: the existing intake_submit with the page's form (its limits, repeat inquiries, the business's
-- distribution and absence rules), fed only the fields the page asks; the answer carries the status only.
create or replace function public.business_page_submit(
  p_token      text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_page public.business_pages;
  v_form_token text;
  v_result jsonb;
begin
  select * into v_page from public.business_pages b where b.token = coalesce(p_token, '');
  if not coalesce(app.business_page_open(v_page), false) or not v_page.show_form then
    raise exception 'business page not found' using errcode = 'P0002';
  end if;
  select f.token into v_form_token from public.forms f
   where f.organization_id = v_page.organization_id and f.business_page_id = v_page.id and f.kind = 'page';
  if v_form_token is null then
    raise exception 'business page not found' using errcode = 'P0002';
  end if;
  v_result := public.intake_submit(
    v_form_token, 'page',
    jsonb_strip_nulls(jsonb_build_object(
      'full_name', p_payload -> 'full_name', 'phone', p_payload -> 'phone', 'email', p_payload -> 'email',
      'message', p_payload -> 'message', 'attribution', p_payload -> 'attribution')),
    app.business_page_sender(v_page.id, p_ip_hash), p_user_agent, coalesce(p_is_spam, false));
  return jsonb_build_object('status', case when v_result ->> 'status' in ('accepted', 'duplicate') then 'accepted' else 'spam' end);
end;
$$;
revoke all on function public.business_page_submit(text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.business_page_submit(text, jsonb, text, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- Link previews (021084's body; the closed kind list gains 'page', judged by app.business_page_open)
-- ----------------------------------------------------------------------------
create or replace function public.link_preview_public(p_kind text, p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_reads integer;
  v_bucket integer;
  v_views integer;
  v_org uuid;
  v_logo_shown boolean := true;
  v_rep uuid;
  v_quote_link app.quote_links;
  v_quote public.quotes;
  v_shown public.quotes;
  v_order_link app.order_links;
  v_order public.orders;
  v_page public.booking_pages;
  v_manage app.booking_manage_links;
  v_meeting public.meetings;
  v_card public.business_cards;
  v_form public.forms;
  v_business_page public.business_pages;
  v_result jsonb;
begin
  if p_kind is null or p_kind not in ('form', 'quote', 'order', 'booking', 'booking_manage', 'card', 'page') then
    raise exception 'unknown preview kind' using errcode = '22023';
  end if;

  -- the limits, counted first: in total a minute (a late commit never moves the minute back), then per sender
  insert into app.link_preview_reads as r (id, minute, reads)
  values (1, v_minute, 1)
  on conflict (id) do update
     set minute = greatest(r.minute, excluded.minute),
         reads = case when r.minute >= excluded.minute then r.reads + 1 else 1 end
  returning r.reads into v_reads;
  if v_reads > app.link_preview_reads_per_minute() then
    return jsonb_build_object('refused', 'rate');
  end if;
  if p_ip_hash is not null then
    -- the sender across all links and kinds
    v_bucket := ((hashtextextended(p_ip_hash, 0) % 1024) + 1024) % 1024;
    insert into app.link_preview_ip_counts as ic (bucket, window_start, views)
    values (v_bucket, now(), 1)
    on conflict (bucket) do update
      set window_start = case when ic.window_start > now() - interval '10 minutes' then ic.window_start else now() end,
          views = case when ic.window_start > now() - interval '10 minutes' then ic.views + 1 else 1 end
    returning ic.views into v_views;
    if v_views > app.link_preview_ip_limit() then
      return jsonb_build_object('refused', 'rate');
    end if;
    -- the sender on this link
    v_bucket := ((hashtextextended(app.link_preview_sender(p_kind, p_token, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.link_preview_sender_counts as vc (bucket, window_start, views)
    values (v_bucket, now(), 1)
    on conflict (bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > app.link_preview_sender_limit() then
      return jsonb_build_object('refused', 'rate');
    end if;
  end if;

  if p_kind = 'quote' then
    if coalesce(p_token, '') ~ '^[A-Za-z0-9_-]{64}$' then
      select * into v_quote_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
      if v_quote_link.quote_id is not null then
        select * into v_quote from public.quotes q
         where q.organization_id = v_quote_link.organization_id and q.id = v_quote_link.quote_id;
        if app.quote_link_usable(v_quote) then
          v_shown := app.quote_shown_version(v_quote);
          if v_shown.customer_deleted_at is null then
            v_org := v_quote.organization_id;
            select coalesce(d.show_logo, true) into v_logo_shown from public.quote_designs d where d.organization_id = v_org;
            v_logo_shown := coalesce(v_logo_shown, true);
          end if;
        end if;
      end if;
    end if;

  elsif p_kind = 'order' then
    if coalesce(p_token, '') ~ '^[A-Za-z0-9_-]{64}$' then
      select * into v_order_link from app.order_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
      if v_order_link.order_id is not null then
        select * into v_order from public.orders o
         where o.organization_id = v_order_link.organization_id and o.id = v_order_link.order_id;
        if app.order_link_usable(v_order) then
          v_org := v_order.organization_id;
          select coalesce(d.show_logo, true) into v_logo_shown from public.quote_designs d where d.organization_id = v_org;
          v_logo_shown := coalesce(v_logo_shown, true);
        end if;
      end if;
    end if;

  elsif p_kind = 'booking' then
    select * into v_page from public.booking_pages b where b.token = coalesce(p_token, '');
    if app.booking_page_state(v_page) = 'open'
       and not exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
      v_org := v_page.organization_id;
    end if;

  elsif p_kind = 'booking_manage' then
    v_manage := app.booking_manage_link(p_token);
    select * into v_meeting from public.meetings m where m.organization_id = v_manage.organization_id and m.id = v_manage.meeting_id;
    if v_meeting.id is not null and app.org_public_pages_open(v_meeting.organization_id) and app.org_writable(v_meeting.organization_id) then
      v_org := v_meeting.organization_id;
    end if;

  elsif p_kind = 'card' then
    select * into v_card from public.business_cards c where c.token = coalesce(p_token, '');
    if app.business_card_open(v_card) then
      v_org := v_card.organization_id;
      v_rep := v_card.user_id;
    end if;

  -- BIZ-01 (021237): the business page, by its own rule
  elsif p_kind = 'page' then
    select * into v_business_page from public.business_pages b where b.token = coalesce(p_token, '');
    if coalesce(app.business_page_open(v_business_page), false) then
      v_org := v_business_page.organization_id;
    end if;

  else -- form
    select * into v_form from public.forms f where f.token = coalesce(p_token, '') and f.kind = 'form';
    if v_form.id is not null and v_form.is_active and app.org_public_pages_open(v_form.organization_id) then
      v_org := v_form.organization_id;
    end if;
  end if;

  if v_org is null then
    return jsonb_build_object('not_found', true);
  end if;

  -- the business's display name and logo only; for a card also the name the card always shows (the rep's, else the business's)
  select jsonb_build_object('kind', p_kind, 'business', o.name, 'logo', case when v_logo_shown then o.logo_path end)
         || case when p_kind = 'card'
                 then jsonb_build_object('rep', coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.id = v_rep), o.name))
                 else '{}'::jsonb end
    into v_result
    from public.organizations o
   where o.id = v_org;
  return coalesce(v_result, jsonb_build_object('not_found', true));
end;
$$;
revoke all on function public.link_preview_public(text, text, text) from public, anon, authenticated;
grant execute on function public.link_preview_public(text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The landing page's price list (021235's body; the closed list gains 'public_page' after 'business_card')
-- ----------------------------------------------------------------------------
create or replace function public.plans_public()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', p.key,
        'name', p.name_he,
        'price_monthly_agorot', p.price_monthly_agorot,
        'price_annual_agorot', p.price_annual_agorot,
        'price_unit', p.price_unit,
        'availability', p.availability,
        'position', p.position,
        'limits', (
          select coalesce(jsonb_object_agg(l.key, l.value), '{}'::jsonb)
            from jsonb_each(case when jsonb_typeof(p.limits) = 'object' then p.limits else '{}'::jsonb end) l
           where l.key in ('max_users', 'max_records', 'storage_gb')
             and jsonb_typeof(l.value) in ('number', 'null')
        ),
        'features', (
          select coalesce(jsonb_agg(c.key order by c.n), '[]'::jsonb)
            from unnest(array[
              -- landing-capabilities: built, non-core keys of PLAN_CAPABILITIES (unit test compares)
              'products', 'discounts', 'quotes', 'documents', 'payments', 'collection', 'balances',
              'booking_page', 'business_card', 'public_page', 'qr_codes', 'site_widget', 'money_waiting', 'instant_reply',
              'goals', 'campaign_costs', 'punch_cards', 'segments', 'auto_reassign', 'lead_distribution',
              'meta_leads', 'meeting_reminders', 'signatures', 'sms', 'review_requests', 'orders', 'goals_per_rep',
              'granular_permissions', 'view_seats', 'remove_built_with'
              -- end landing-capabilities
            ]::text[]) with ordinality c(key, n)
           where jsonb_typeof(p.features) = 'object'
             and p.features -> c.key = 'true'::jsonb
        )
      )
      order by p.position, p.key
    ),
    '[]'::jsonb
  )
  from public.plans p
  where p.availability in ('available', 'coming_soon')
$$;

comment on function public.plans_public() is
  'LND-13: the public fields of available and coming-soon plans for the landing page price list; anon may execute it (owner, 11 November 2026).';

-- anon and authenticated only (owner, 11 November 2026); test 01 names it beside health_check
revoke all on function public.plans_public() from public, anon, authenticated, service_role;
grant execute on function public.plans_public() to anon, authenticated;

notify pgrst, 'reload schema';
