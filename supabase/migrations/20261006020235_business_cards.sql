-- =============================================================================
-- 020235 Digital business card (BIZ-02)
-- =============================================================================
-- "כרטיס ביקור דיגיטלי לכל נציג: קישור וקוד QR, שמירה לאנשי הקשר בטלפון, וטופס 'השאירו פרטים' שנכנס כליד של אותו נציג."
-- Plan: flag `business_card` (every plan) and `max_business_cards_per_user` (1 everywhere), owner 13 October 2026.
-- The approved pattern for public secret-link pages (owner, 13 October 2026; CLAUDE.md hard rule 5), with its conditions:
-- only fields marked public; an inactive or deleted rep = "not found" at once; the form goes through the existing
-- public.intake_submit with the same protections and the lead goes to the rep; rate limits; no cookies or visitor id.
--
-- * public.business_cards: one card per rep (the plan's quota), with a secret token (its link: /f/card/<token>).
--   The rep and owners/admins of a writable business manage it; the rep must be an active member who is not a viewer
--   (hint business_card:rep). The card's own details (title, about, phone, email, site) and `public_fields`, the ones
--   shown; the rep's name, the business's display name, logo and colour always show. Audited.
-- * Its form: a row of public.forms of the new kind 'card' (forms.business_card_id, cascades with the card), made by
--   the card's insert trigger: owner = the rep, assignment by owner, source "כרטיס ביקור" (kind business_card, made
--   once per business). A card form is made and changed only by these triggers (hint form:card): a client cannot
--   create, change or delete one while its card exists. Kind 'card' is not a web form: it does not count against
--   max_forms, is not served by intake_form() or the form routes, and intake_submit skips the field rules of 'form'.
-- * public.business_card_public(token, ip_hash) and public.business_card_submit(token, payload, ip_hash, user_agent,
--   is_spam): security definer, service_role only. Not found (P0002) unless the card is on, its rep is an active member
--   who is not a viewer, the plan holds the flag and the business's public pages are open (app.org_public_pages_open).
--   The sender is the server's keyed IP hash scoped to the card (app.business_card_sender). Views: 60 per sender in 10 minutes in app.business_card_view_counts (1,024 reused
--   buckets per card, no hash kept). The submit passes only name, phone, email, message and the campaign keys to
--   intake_submit (its limits: 10 per sender in 10 minutes and 500 an hour per form) and answers its status only.
-- No drop statement, no delete statement. Safe to run twice.

-- ----------------------------------------------------------------------------
-- Cards
-- ----------------------------------------------------------------------------
create table if not exists public.business_cards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null,
  token           text not null unique default replace(gen_random_uuid()::text, '-', ''),
  is_active       boolean not null default true,
  job_title       text check (char_length(job_title) between 1 and 80 and job_title = btrim(job_title)),
  about           text check (char_length(about) between 1 and 500),
  phone           text check (char_length(phone) between 1 and 40 and phone = btrim(phone)),
  email           text check (char_length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  website         text check (char_length(website) between 8 and 300 and website ~* '^https?://[^\s]+$'),
  public_fields   text[] not null default '{job_title,phone,email,whatsapp}'
                  check (public_fields <@ array['job_title', 'about', 'phone', 'email', 'whatsapp', 'website']),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint business_cards_member_fk foreign key (organization_id, user_id)
    references public.memberships (organization_id, user_id) on delete cascade
);
create index if not exists business_cards_user_idx on public.business_cards (organization_id, user_id);

alter table public.business_cards enable row level security;
revoke all on public.business_cards from anon, authenticated;
grant select, delete on public.business_cards to authenticated;
grant insert (organization_id, user_id, is_active, job_title, about, phone, email, website, public_fields)
  on public.business_cards to authenticated;
grant update (is_active, job_title, about, phone, email, website, public_fields) on public.business_cards to authenticated;

do $$
begin
  -- the rep their own card; owners and admins every card
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_cards' and policyname = 'business_cards_select') then
    create policy business_cards_select on public.business_cards for select to authenticated
      using (app.is_member(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_cards' and policyname = 'business_cards_insert') then
    create policy business_cards_insert on public.business_cards for insert to authenticated
      with check (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_cards' and policyname = 'business_cards_update') then
    create policy business_cards_update on public.business_cards for update to authenticated
      using (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id)))
      with check (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_cards' and policyname = 'business_cards_delete') then
    create policy business_cards_delete on public.business_cards for delete to authenticated
      using (app.can_write(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
end;
$$;

create or replace trigger business_cards_touch before update on public.business_cards
  for each row execute function app.touch_row();
create or replace trigger business_cards_audit after insert or update or delete on public.business_cards
  for each row execute function app.audit_row();

-- The rep is an active member who is not a viewer; the flag and the quota per rep (the outsider guard first, so a
-- person outside the business gets RLS's plain refusal and learns nothing about its plan)
create or replace function app.business_cards_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  if auth.uid() is not null
     and not (app.can_write(new.organization_id) and (new.user_id = auth.uid() or app.is_admin(new.organization_id))) then
    return new;
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = new.organization_id and m.user_id = new.user_id
                    and m.status = 'active' and m.role <> 'viewer') then
    raise exception 'a card belongs to an active member' using errcode = 'P0001', hint = 'business_card:rep';
  end if;
  if not app.org_has_feature(new.organization_id, 'business_card') then
    raise exception 'business cards are not in the plan' using errcode = 'P0001', hint = 'feature:business_card';
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_business_cards_per_user');
  if v_limit is not null then
    perform pg_advisory_xact_lock(hashtextextended('business_cards:' || new.organization_id::text || ':' || new.user_id::text, 0));
    if (select count(*) from public.business_cards c
         where c.organization_id = new.organization_id and c.user_id = new.user_id) >= v_limit then
      raise exception 'business card limit reached' using errcode = 'P0001', hint = 'limit:max_business_cards_per_user';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.business_cards_check() from public, anon, authenticated;

create or replace trigger business_cards_check before insert on public.business_cards
  for each row execute function app.business_cards_check();

-- ----------------------------------------------------------------------------
-- The card's form: a forms row of kind 'card'
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_kind_check'
                  and pg_get_constraintdef(oid) like '%card%') then
    alter table public.forms drop constraint if exists forms_kind_check;
    alter table public.forms add constraint forms_kind_check check (kind in ('form', 'webhook', 'card'));
  end if;
end;
$$;

alter table public.forms add column if not exists business_card_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_business_card_fk') then
    alter table public.forms add constraint forms_business_card_fk foreign key (organization_id, business_card_id)
      references public.business_cards (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_card_shape') then
    alter table public.forms add constraint forms_card_shape check ((kind = 'card') = (business_card_id is not null));
  end if;
end;
$$;
create unique index if not exists forms_business_card_idx on public.forms (organization_id, business_card_id) where business_card_id is not null;

-- app.guard_form (0007): the plan rules of forms, and a card form only from its card's trigger
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

-- whether a card still exists (for the lock below, which runs with the caller's rights)
create or replace function app.business_card_exists(p_org uuid, p_card uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.business_cards c where c.organization_id = p_org and c.id = p_card)
$$;
revoke all on function app.business_card_exists(uuid, uuid) from public, anon;
grant execute on function app.business_card_exists(uuid, uuid) to authenticated, service_role;

-- A person never changes a card form, and deletes it only with its card (the cascade, once the card is gone).
-- Security invoker on purpose: current_user tells a person's write from the card's own triggers.
create or replace function app.forms_card_lock() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and old.kind = 'card' then
    if tg_op = 'UPDATE' or app.business_card_exists(old.organization_id, old.business_card_id) then
      raise exception 'a card form changes with its card' using errcode = 'P0001', hint = 'form:card';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function app.forms_card_lock() from public, anon, authenticated;

create or replace trigger forms_card_lock before update or delete on public.forms
  for each row execute function app.forms_card_lock();

-- The card's form, made with it: owner = the rep, source "כרטיס ביקור" (made once per business)
create or replace function app.business_cards_make_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_source uuid;
  v_name text;
begin
  perform pg_advisory_xact_lock(hashtextextended('business_card_source:' || new.organization_id::text, 0));
  select s.id into v_source from public.lead_sources s
   where s.organization_id = new.organization_id
     and (s.kind = 'business_card' or btrim(s.name) = 'כרטיס ביקור')
   order by s.is_active desc, (s.kind = 'business_card') desc, s.created_at
   limit 1;
  if v_source is null then
    insert into public.lead_sources (organization_id, name, kind)
    values (new.organization_id, 'כרטיס ביקור', 'business_card')
    returning id into v_source;
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), 'נציג') into v_name from public.profiles p where p.id = new.user_id;
  perform set_config('app.card_form', 'on', true);
  insert into public.forms (organization_id, kind, name, title, owner_id, assign_mode, source_id, is_active, business_card_id)
  values (new.organization_id, 'card', left('כרטיס ביקור: ' || coalesce(v_name, 'נציג'), 120), 'השאירו פרטים',
          new.user_id, 'owner', v_source, true, new.id);
  perform set_config('app.card_form', '', true);
  return null;
end;
$$;
revoke all on function app.business_cards_make_form() from public, anon, authenticated;

create or replace trigger business_cards_make_form after insert on public.business_cards
  for each row execute function app.business_cards_make_form();

-- ----------------------------------------------------------------------------
-- The public page
-- ----------------------------------------------------------------------------
-- Views: no row per view. A fixed set of counters per card (1,024 buckets picked by the keyed IP hash), each counting
-- its 10-minute window and reused by the next one (an update, never a delete). No hash is stored.
create table if not exists app.business_card_view_counts (
  card_id      uuid not null,
  bucket       integer not null check (bucket between 0 and 1023),
  window_start timestamptz not null,
  views        integer not null,
  primary key (card_id, bucket)
);
alter table app.business_card_view_counts enable row level security;
revoke all on app.business_card_view_counts from public, anon, authenticated, service_role;

-- The sender, scoped to one card (as app.booking_sender, CAL-10b): SHA-256 of the card id and the server's keyed IP
-- hash, so the same visitor is a different sender on every card and nothing matches across cards or businesses.
create or replace function app.business_card_sender(p_card uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_card is null then null
              else encode(sha256(convert_to('card:' || p_card::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.business_card_sender(uuid, text) from public, anon, authenticated, service_role;

-- Whether a card's page can be shown: on, its rep an active member who is not a viewer, the flag, public pages open
create or replace function app.business_card_open(p_card public.business_cards) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_card.id is not null and p_card.is_active
     and app.org_public_pages_open(p_card.organization_id)
     and app.org_has_feature(p_card.organization_id, 'business_card')
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_card.organization_id and m.user_id = p_card.user_id
                    and m.status = 'active' and m.role <> 'viewer')
$$;
revoke all on function app.business_card_open(public.business_cards) from public, anon, authenticated;

create or replace function public.business_card_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_card public.business_cards;
  v_bucket integer;
  v_views integer;
  v_phone_e164 text;
  v_result jsonb;
begin
  select * into v_card from public.business_cards c where c.token = coalesce(p_token, '');
  if not app.business_card_open(v_card) then
    raise exception 'business card not found' using errcode = 'P0002';
  end if;

  -- 60 views per sender in 10 minutes; counted first, so the limit holds under parallel load
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.business_card_sender(v_card.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.business_card_view_counts as vc (card_id, bucket, window_start, views)
    values (v_card.id, v_bucket, now(), 1)
    on conflict (card_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  v_phone_e164 := app.normalize_phone(v_card.phone);
  -- only what the card shows: no ids, nothing the rep did not mark public
  select jsonb_build_object(
           'name', coalesce(nullif(btrim(p.full_name), ''), o.name),
           'business', o.name,
           'brand', jsonb_build_object('logo', o.logo_path, 'color', o.brand_color),
           'built_with', app.show_built_with(o.id),
           'job_title', case when 'job_title' = any (v_card.public_fields) then v_card.job_title end,
           'about', case when 'about' = any (v_card.public_fields) then v_card.about end,
           'phone', case when 'phone' = any (v_card.public_fields) then v_card.phone end,
           'whatsapp', case when 'whatsapp' = any (v_card.public_fields) and v_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
                            then substr(v_phone_e164, 2) end,
           'email', case when 'email' = any (v_card.public_fields) then v_card.email end,
           'website', case when 'website' = any (v_card.public_fields) then v_card.website end,
           -- the "leave details" form: a business that takes leads (a read-only or suspended one does)
           'form', app.org_takes_leads(o.id))
    into v_result
    from public.organizations o
    left join public.profiles p on p.id = v_card.user_id
   where o.id = v_card.organization_id;
  return jsonb_strip_nulls(v_result);
end;
$$;
revoke all on function public.business_card_public(text, text) from public, anon, authenticated;
grant execute on function public.business_card_public(text, text) to service_role;

-- The "leave details" form: the existing intake_submit with the card's form (its limits, repeat inquiries, owner =
-- the rep with the absence rules), fed only the fields the card asks; the answer carries the status only.
create or replace function public.business_card_submit(
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
  v_card public.business_cards;
  v_form_token text;
  v_result jsonb;
begin
  select * into v_card from public.business_cards c where c.token = coalesce(p_token, '');
  if not app.business_card_open(v_card) then
    raise exception 'business card not found' using errcode = 'P0002';
  end if;
  select f.token into v_form_token from public.forms f
   where f.organization_id = v_card.organization_id and f.business_card_id = v_card.id and f.kind = 'card';
  if v_form_token is null then
    raise exception 'business card not found' using errcode = 'P0002';
  end if;
  v_result := public.intake_submit(
    v_form_token, 'card',
    jsonb_strip_nulls(jsonb_build_object(
      'full_name', p_payload -> 'full_name', 'phone', p_payload -> 'phone', 'email', p_payload -> 'email',
      'message', p_payload -> 'message', 'attribution', p_payload -> 'attribution')),
    app.business_card_sender(v_card.id, p_ip_hash), p_user_agent, coalesce(p_is_spam, false));
  return jsonb_build_object('status', case when v_result ->> 'status' in ('accepted', 'duplicate') then 'accepted' else 'spam' end);
end;
$$;
revoke all on function public.business_card_submit(text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.business_card_submit(text, jsonb, text, text, boolean) to service_role;

notify pgrst, 'reload schema';
