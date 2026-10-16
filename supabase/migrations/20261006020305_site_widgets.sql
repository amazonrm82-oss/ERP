-- =============================================================================
-- 020305 Site widget (SPD-07)
-- =============================================================================
-- "כפתור צף לאתר של הלקוח: קטע קוד אחד שמוסיף כפתור WhatsApp, חיוג וטופס קצר. כל פנייה נכנסת כליד, עם המקור והדף
-- שממנו הגיעה."
-- Plan: flag `site_widget` (every plan) and quota `max_site_widgets` (1 / 3 / 10 / 50), owner 13 October 2026.
-- The approved pattern for public secret-link pages (owner, 13 October 2026; CLAUDE.md hard rule 5), with its conditions:
-- the script gets public display settings only; no cookies and no visitor id; only the page the inquiry was sent from and
-- the campaign parameters are kept (the existing CAP-02 rules); the form goes through intake_submit; rate limits.
--
-- * public.site_widgets: a widget per site placement (name, button label, which buttons show, the number for calls and
--   WhatsApp (null = the business phone), the side of the page, and who gets its leads, like a web form). A secret-free
--   public token (its script: /f/w/<token>.js; its form: /f/widget/<token>). Owners and admins of a writable business
--   manage it; members do not see it. Audited.
-- * Its form: a row of public.forms of the new kind 'widget' (forms.site_widget_id, cascades with the widget), made by the
--   widget's insert trigger and kept in step by its update trigger (owner, team, assignment, name): source "כפתור באתר"
--   (kind site_widget, made once per business). A widget form is made and changed only by these triggers (hint
--   form:widget). Kind 'widget' is not a web form: it does not count against max_forms, is not served by intake_form()
--   or the form routes, and intake_submit skips the field rules of 'form'.
-- * public.site_widget_public(token, ip_hash) and public.site_widget_submit(token, payload, ip_hash, user_agent,
--   is_spam): security definer, service_role only. Not found (P0002) unless the widget is on, the plan holds the flag and
--   the business's public pages are open (app.org_public_pages_open). The display settings only: no ids, no counts, no
--   owner. With a sender hash (the server's keyed IP hash, scoped to the widget by app.site_widget_sender) a view counts:
--   60 per sender in 10 minutes in app.site_widget_view_counts (1,024 reused buckets per widget, no hash kept). The
--   submit passes only name, phone, email, message and the campaign keys (page included) to intake_submit (its limits:
--   10 per sender in 10 minutes and 500 an hour per form) and answers its status only.
-- No drop statement, no delete statement. Safe to run twice.

-- ----------------------------------------------------------------------------
-- Widgets
-- ----------------------------------------------------------------------------
create table if not exists public.site_widgets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  token           text not null unique default replace(gen_random_uuid()::text, '-', ''),
  is_active       boolean not null default true,
  button_label    text not null default 'דברו איתנו'
                  check (char_length(button_label) between 1 and 40 and button_label = btrim(button_label)),
  show_whatsapp   boolean not null default true,
  show_call       boolean not null default true,
  show_form       boolean not null default true,
  phone           text check (char_length(phone) between 1 and 40 and phone ~ '^[0-9+()\- ]+$'),
  position        text not null default 'left' check (position in ('left', 'right')),
  assign_mode     text not null default 'round_robin' check (assign_mode in ('owner', 'round_robin')),
  owner_id        uuid,
  team_id         uuid,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint site_widgets_owner_fk foreign key (organization_id, owner_id)
    references public.memberships (organization_id, user_id) on delete set null (owner_id),
  constraint site_widgets_team_fk foreign key (organization_id, team_id)
    references public.teams (organization_id, id) on delete set null (team_id)
);
create index if not exists site_widgets_org_idx on public.site_widgets (organization_id, created_at);
create index if not exists site_widgets_owner_idx on public.site_widgets (organization_id, owner_id) where owner_id is not null;
create index if not exists site_widgets_team_idx on public.site_widgets (organization_id, team_id) where team_id is not null;

alter table public.site_widgets enable row level security;
revoke all on public.site_widgets from anon, authenticated;
grant select, delete on public.site_widgets to authenticated;
grant insert (organization_id, name, is_active, button_label, show_whatsapp, show_call, show_form, phone, position,
              assign_mode, owner_id, team_id) on public.site_widgets to authenticated;
grant update (name, is_active, button_label, show_whatsapp, show_call, show_form, phone, position,
              assign_mode, owner_id, team_id) on public.site_widgets to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'site_widgets' and policyname = 'site_widgets_select') then
    create policy site_widgets_select on public.site_widgets for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'site_widgets' and policyname = 'site_widgets_insert') then
    create policy site_widgets_insert on public.site_widgets for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'site_widgets' and policyname = 'site_widgets_update') then
    create policy site_widgets_update on public.site_widgets for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'site_widgets' and policyname = 'site_widgets_delete') then
    create policy site_widgets_delete on public.site_widgets for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger site_widgets_touch before update on public.site_widgets
  for each row execute function app.touch_row();
create or replace trigger site_widgets_audit after insert or update or delete on public.site_widgets
  for each row execute function app.audit_row();

-- The plan (flag and quota) and the lead owner. The outsider guard first, so a person outside the business gets RLS's
-- plain refusal and learns nothing about its plan or its people.
create or replace function app.site_widgets_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not exists (select 1 from public.memberships m
                      where m.organization_id = new.organization_id and m.user_id = new.owner_id
                        and m.status = 'active' and m.role <> 'viewer') then
    raise exception 'the widget''s leads go to an active member' using errcode = 'P0001', hint = 'site_widget:owner';
  end if;
  if tg_op = 'INSERT' then
    if not app.org_has_feature(new.organization_id, 'site_widget') then
      raise exception 'site widgets are not in the plan' using errcode = 'P0001', hint = 'feature:site_widget';
    end if;
    v_limit := app.org_limit(new.organization_id, 'max_site_widgets');
    if v_limit is not null then
      perform pg_advisory_xact_lock(hashtextextended('site_widgets:' || new.organization_id::text, 0));
      if (select count(*) from public.site_widgets w where w.organization_id = new.organization_id) >= v_limit then
        raise exception 'site widget limit reached' using errcode = 'P0001', hint = 'limit:max_site_widgets';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.site_widgets_check() from public, anon, authenticated;

create or replace trigger site_widgets_check before insert or update on public.site_widgets
  for each row execute function app.site_widgets_check();

-- ----------------------------------------------------------------------------
-- The widget's form: a forms row of kind 'widget'
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_kind_check'
                  and pg_get_constraintdef(oid) like '%widget%') then
    alter table public.forms drop constraint if exists forms_kind_check;
    alter table public.forms add constraint forms_kind_check check (kind in ('form', 'webhook', 'card', 'widget'));
  end if;
end;
$$;

alter table public.forms add column if not exists site_widget_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_site_widget_fk') then
    alter table public.forms add constraint forms_site_widget_fk foreign key (organization_id, site_widget_id)
      references public.site_widgets (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_widget_shape') then
    alter table public.forms add constraint forms_widget_shape check ((kind = 'widget') = (site_widget_id is not null));
  end if;
end;
$$;
create unique index if not exists forms_site_widget_idx on public.forms (organization_id, site_widget_id) where site_widget_id is not null;

-- app.guard_form (body of 020235): the plan rules of forms, a card form only from its card's trigger, and a widget form
-- only from its widget's triggers
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

-- whether a widget still exists (for the lock below, which runs with the caller's rights)
create or replace function app.site_widget_exists(p_org uuid, p_widget uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.site_widgets w where w.organization_id = p_org and w.id = p_widget)
$$;
revoke all on function app.site_widget_exists(uuid, uuid) from public, anon;
grant execute on function app.site_widget_exists(uuid, uuid) to authenticated, service_role;

-- A person never changes a widget form, and deletes it only with its widget (the cascade, once the widget is gone).
-- Security invoker on purpose: current_user tells a person's write from the widget's own triggers.
create or replace function app.forms_widget_lock() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and old.kind = 'widget' then
    if tg_op = 'UPDATE' or app.site_widget_exists(old.organization_id, old.site_widget_id) then
      raise exception 'a widget form changes with its widget' using errcode = 'P0001', hint = 'form:widget';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function app.forms_widget_lock() from public, anon, authenticated;

create or replace trigger forms_widget_lock before update or delete on public.forms
  for each row execute function app.forms_widget_lock();

-- The widget's form, made with it and kept in step: source "כפתור באתר" (made once per business), the widget's
-- assignment, owner and team
create or replace function app.site_widgets_sync_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_source uuid;
begin
  perform set_config('app.widget_form', 'on', true);
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('site_widget_source:' || new.organization_id::text, 0));
    select s.id into v_source from public.lead_sources s
     where s.organization_id = new.organization_id
       and (s.kind = 'site_widget' or btrim(s.name) = 'כפתור באתר')
     order by s.is_active desc, (s.kind = 'site_widget') desc, s.created_at
     limit 1;
    if v_source is null then
      insert into public.lead_sources (organization_id, name, kind)
      values (new.organization_id, 'כפתור באתר', 'site_widget')
      returning id into v_source;
    end if;
    insert into public.forms (organization_id, kind, name, title, owner_id, team_id, assign_mode, source_id, is_active, site_widget_id)
    values (new.organization_id, 'widget', left('כפתור באתר: ' || new.name, 120), 'השאירו פרטים',
            new.owner_id, new.team_id, new.assign_mode, v_source, true, new.id);
  elsif new.name is distinct from old.name or new.owner_id is distinct from old.owner_id
        or new.team_id is distinct from old.team_id or new.assign_mode is distinct from old.assign_mode then
    update public.forms f
       set name = left('כפתור באתר: ' || new.name, 120), owner_id = new.owner_id, team_id = new.team_id,
           assign_mode = new.assign_mode
     where f.organization_id = new.organization_id and f.site_widget_id = new.id;
  end if;
  perform set_config('app.widget_form', '', true);
  return null;
end;
$$;
revoke all on function app.site_widgets_sync_form() from public, anon, authenticated;

create or replace trigger site_widgets_sync_form after insert or update on public.site_widgets
  for each row execute function app.site_widgets_sync_form();

-- ----------------------------------------------------------------------------
-- The public side
-- ----------------------------------------------------------------------------
-- Views: no row per view. A fixed set of counters per widget (1,024 buckets picked by the sender hash), each counting
-- its 10-minute window and reused by the next one (an update, never a delete). No hash is stored.
create table if not exists app.site_widget_view_counts (
  widget_id    uuid not null references public.site_widgets (id) on delete cascade,
  bucket       integer not null check (bucket between 0 and 1023),
  window_start timestamptz not null,
  views        integer not null,
  primary key (widget_id, bucket)
);
alter table app.site_widget_view_counts enable row level security;
revoke all on app.site_widget_view_counts from public, anon, authenticated, service_role;

-- The server's keyed IP hash, scoped to one widget: the same visitor is a different sender on every widget
create or replace function app.site_widget_sender(p_widget uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_widget is null then null
              else encode(sha256(convert_to('widget:' || p_widget::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.site_widget_sender(uuid, text) from public, anon, authenticated, service_role;

-- Whether a widget can be shown: on, the flag, the business's public pages open
create or replace function app.site_widget_open(p_widget public.site_widgets) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_widget.id is not null and p_widget.is_active
     and app.org_public_pages_open(p_widget.organization_id)
     and app.org_has_feature(p_widget.organization_id, 'site_widget')
$$;
revoke all on function app.site_widget_open(public.site_widgets) from public, anon, authenticated;

-- The display settings, and nothing else: no ids, no owner, no counts
create or replace function public.site_widget_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_widget public.site_widgets;
  v_bucket integer;
  v_views integer;
  v_phone text;
  v_result jsonb;
begin
  select * into v_widget from public.site_widgets w where w.token = coalesce(p_token, '');
  if not app.site_widget_open(v_widget) then
    raise exception 'site widget not found' using errcode = 'P0002';
  end if;

  -- 60 views per sender in 10 minutes; counted first, so the limit holds under parallel load
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.site_widget_sender(v_widget.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.site_widget_view_counts as vc (widget_id, bucket, window_start, views)
    values (v_widget.id, v_bucket, now(), 1)
    on conflict (widget_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select app.normalize_phone(coalesce(nullif(btrim(v_widget.phone), ''), o.phone)) into v_phone
    from public.organizations o where o.id = v_widget.organization_id;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    v_phone := null;
  end if;
  select jsonb_build_object(
           'label', v_widget.button_label,
           'position', v_widget.position,
           'business', o.name,
           'brand', jsonb_build_object('logo', o.logo_path, 'color', o.brand_color),
           'built_with', app.show_built_with(o.id),
           -- digits of a valid E.164 number only (the same rule as the card and the thank-you button)
           'whatsapp', case when v_widget.show_whatsapp and v_phone is not null then substr(v_phone, 2) end,
           'call', case when v_widget.show_call and v_phone is not null then v_phone end,
           -- the short form: a business that takes leads (a read-only or suspended one does)
           'form', v_widget.show_form and app.org_takes_leads(o.id))
    into v_result
    from public.organizations o
   where o.id = v_widget.organization_id;
  return jsonb_strip_nulls(v_result);
end;
$$;
revoke all on function public.site_widget_public(text, text) from public, anon, authenticated;
grant execute on function public.site_widget_public(text, text) to service_role;

-- The short form: the existing intake_submit with the widget's form (its limits, repeat inquiries, owner and absence
-- rules), fed only the fields the widget asks and the campaign keys (the page included); the answer is the status only.
create or replace function public.site_widget_submit(
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
  v_widget public.site_widgets;
  v_form_token text;
  v_result jsonb;
begin
  select * into v_widget from public.site_widgets w where w.token = coalesce(p_token, '');
  if not app.site_widget_open(v_widget) or not v_widget.show_form then
    raise exception 'site widget not found' using errcode = 'P0002';
  end if;
  select f.token into v_form_token from public.forms f
   where f.organization_id = v_widget.organization_id and f.site_widget_id = v_widget.id and f.kind = 'widget';
  if v_form_token is null then
    raise exception 'site widget not found' using errcode = 'P0002';
  end if;
  v_result := public.intake_submit(
    v_form_token, 'widget',
    jsonb_strip_nulls(jsonb_build_object(
      'full_name', p_payload -> 'full_name', 'phone', p_payload -> 'phone', 'email', p_payload -> 'email',
      'message', p_payload -> 'message', 'attribution', p_payload -> 'attribution')),
    app.site_widget_sender(v_widget.id, p_ip_hash), p_user_agent, coalesce(p_is_spam, false));
  return jsonb_build_object('status', case when v_result ->> 'status' in ('accepted', 'duplicate') then 'accepted' else 'spam' end);
end;
$$;
revoke all on function public.site_widget_submit(text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.site_widget_submit(text, jsonb, text, text, boolean) to service_role;

notify pgrst, 'reload schema';
