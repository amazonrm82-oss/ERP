-- =============================================================================
-- PKG-03 (rep side): alerts when a punch card has few entries left or its last day is near
-- =============================================================================
-- "התראה ללקוח ולנציג כשנשארו מעט כניסות או כשהתוקף מתקרב" (SPEC-ADDITIONS, wave 3). Owner's answers of 4 November 2026
-- (DECISIONS.md, "התראות כרטיסייה"): (130) "נשארו מעט" at 2 entries and "התוקף מתקרב" 14 days ahead, and the business
-- changes both; (131) a card opened inside the expiry window gets no expiry alert, an unused card opened before it does;
-- (132) ב a new notification kind "כרטיסייה" (`punch_card`) that can be muted in the notification settings.
-- The customer's message (answers (127)-(129)) comes in the next migration (punch_card_notice_messages).
--
-- * public.punch_card_alert_settings: one row per business (no row = the defaults). low_entries 0..100 (default 2) and
--   expiry_days 0..365 (default 14); 0 switches that alert off. Members read; owners/admins of a writable business write
--   the two columns (column grants); no delete; audited.
-- * The notification kind `punch_card` joins both kind constraints (and NOTIFICATION_KINDS); it is mutable like every kind
--   but `system`.
-- * The job app.send_punch_card_alerts(p_orgs) (pg_cron `crm-punch-card-alerts`, every 15 minutes), from 08:00 in the
--   business's zone, for writable businesses whose plan holds `punch_cards`:
--     few left  an active card, not expired (expires_on null or today or later), of a live contact, with 1..low_entries
--               entries left (a card never used counts too: owner's brief; a card used up is "נוצלה", not "few left")
--     last day  an active card with entries left whose expires_on is today..today + expiry_days, and that was activated
--               (business calendar) BEFORE the window opened (expires_on - expiry_days): owner (131)
--   ONE notice per card and kind, ever: app.punch_card_alerts_sent (RLS on, no grants, cascades with the card). Recipient:
--   the contact's owner while an active full-seat member who is not a viewer, else every active owner and admin. The
--   text holds the card's name (a product name) and numbers only, never a customer's name; it opens the contact.
--   Fair: 200 cards per business and 2,000 per run (a transaction may lower both, tests do); businesses take turns
--   (app.punch_card_alert_turns); each card and kind in its own exception block: a failure is counted, tried again on a
--   later run after the fresh ones, and skipped after 3 failures with one warning line (card id and SQLSTATE only).
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The business's numbers
-- ----------------------------------------------------------------------------
create table if not exists public.punch_card_alert_settings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  low_entries      smallint not null default 2,
  expiry_days      smallint not null default 14,
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint punch_card_alert_settings_low_range check (low_entries between 0 and 100),
  constraint punch_card_alert_settings_expiry_range check (expiry_days between 0 and 365)
);

create or replace trigger punch_card_alert_settings_touch before insert or update on public.punch_card_alert_settings
  for each row execute function app.touch_row();
create or replace trigger punch_card_alert_settings_audit after insert or update or delete on public.punch_card_alert_settings
  for each row execute function app.audit_row();

alter table public.punch_card_alert_settings enable row level security;
revoke all on public.punch_card_alert_settings from anon, authenticated;
grant select on public.punch_card_alert_settings to authenticated;
grant insert (organization_id, low_entries, expiry_days) on public.punch_card_alert_settings to authenticated;
grant update (low_entries, expiry_days) on public.punch_card_alert_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'punch_card_alert_settings'
                   and policyname = 'punch_card_alert_settings_select') then
    create policy punch_card_alert_settings_select on public.punch_card_alert_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'punch_card_alert_settings'
                   and policyname = 'punch_card_alert_settings_insert') then
    create policy punch_card_alert_settings_insert on public.punch_card_alert_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'punch_card_alert_settings'
                   and policyname = 'punch_card_alert_settings_update') then
    create policy punch_card_alert_settings_update on public.punch_card_alert_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The notification kind (owner (132) ב)
-- ----------------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_kinds,
  add constraint notifications_kinds check (type in (
    'system', 'assigned', 'task_reminder', 'inquiry', 'automation',
    'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
    'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card'));

alter table public.notification_settings
  drop constraint if exists notification_settings_kinds,
  add constraint notification_settings_kinds check (
    muted <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                   'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                   'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card']
    and no_push <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                         'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                         'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue', 'punch_card']);

-- ----------------------------------------------------------------------------
-- Once per card and kind
-- ----------------------------------------------------------------------------
-- done_at set once the alert was sent; failures / last_attempt_at while it fails
create table if not exists app.punch_card_alerts_sent (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  card_id          uuid not null,
  kind             text not null check (kind in ('low', 'expiry')),
  done_at          timestamptz,
  failures         integer not null default 0,
  last_attempt_at  timestamptz,
  primary key (card_id, kind),
  constraint punch_card_alerts_sent_card_fk foreign key (organization_id, card_id)
    references public.punch_cards (organization_id, id) on delete cascade
);
create index if not exists punch_card_alerts_sent_org_idx on app.punch_card_alerts_sent (organization_id, card_id);
alter table app.punch_card_alerts_sent enable row level security;
revoke all on app.punch_card_alerts_sent from public, anon, authenticated, service_role;

-- the business turns: when each business was last served (no grants, RLS on)
create table if not exists app.punch_card_alert_turns (
  organization_id  uuid primary key references public.organizations (id) on delete cascade,
  served_at        timestamptz not null
);
alter table app.punch_card_alert_turns enable row level security;
revoke all on app.punch_card_alert_turns from public, anon, authenticated, service_role;

-- 200 per business and 2,000 per run; a transaction may only lower them (tests do)
create or replace function app.punch_card_alert_per_org() returns integer language sql stable set search_path = '' as $$
  select least(200, greatest(1, coalesce(nullif(current_setting('app.punch_card_alert_per_org', true), '')::integer, 200)))
$$;
create or replace function app.punch_card_alert_limit() returns integer language sql stable set search_path = '' as $$
  select least(2000, greatest(1, coalesce(nullif(current_setting('app.punch_card_alert_limit', true), '')::integer, 2000)))
$$;
revoke all on function app.punch_card_alert_per_org() from public, anon, authenticated, service_role;
revoke all on function app.punch_card_alert_limit() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The texts (mirrored by punchAlertTitle() / punchAlertBody() in src/features/punch-cards/alerts.ts)
-- ----------------------------------------------------------------------------
create or replace function app.punch_card_alert_title(p_kind text, p_remaining integer, p_days integer) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_kind = 'low' and p_remaining = 1 then 'כרטיסייה: נשארה כניסה אחת'
    when p_kind = 'low' then 'כרטיסייה: נשארו ' || p_remaining || ' כניסות'
    when p_kind = 'expiry' and p_days <= 0 then 'כרטיסייה: התוקף מסתיים היום'
    when p_kind = 'expiry' and p_days = 1 then 'כרטיסייה: התוקף מסתיים מחר'
    when p_kind = 'expiry' then 'כרטיסייה: התוקף מסתיים בעוד ' || p_days || ' ימים'
  end
$$;
revoke all on function app.punch_card_alert_title(text, integer, integer) from public, anon, authenticated, service_role;

create or replace function app.punch_card_alert_body(p_name text, p_remaining integer, p_total integer, p_expires date) returns text
language sql immutable
set search_path = ''
as $$
  select left(p_name, 200) || ' · '
         || case when p_remaining = 1 then 'נשארה כניסה אחת מתוך ' || p_total else 'נשארו ' || p_remaining || ' מתוך ' || p_total end
         || coalesce(' · בתוקף עד ' || to_char(p_expires, 'DD.MM.YYYY'), '')
$$;
revoke all on function app.punch_card_alert_body(text, integer, integer, date) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job
-- ----------------------------------------------------------------------------
create or replace function app.send_punch_card_alerts(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_rep uuid;
  v_done integer := 0;
  v_served uuid[] := '{}'::uuid[];
begin
  for v_row in
    with orgs as materialized (
      -- the businesses first: writable, the plan key, and 08:00 or later in the business's zone
      select o.id, app.intake_zone(o.timezone) as zone,
             (now() at time zone app.intake_zone(o.timezone))::date as today,
             coalesce(s.low_entries, 2) as low_entries, coalesce(s.expiry_days, 14) as expiry_days
        from public.organizations o
        left join public.punch_card_alert_settings s on s.organization_id = o.id
       where (p_orgs is null or o.id = any (p_orgs))
         and o.deleted_at is null
         and app.org_writable(o.id)
         and app.org_has_feature(o.id, 'punch_cards')
         and (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00'
         and (coalesce(s.low_entries, 2) > 0 or coalesce(s.expiry_days, 14) > 0)
    ),
    cards as materialized (
      select c.organization_id, c.id, c.contact_id, c.name, c.entries_total, c.expires_on,
             (c.activated_at at time zone og.zone)::date as activated_on,
             og.today, og.low_entries, og.expiry_days,
             c.entries_total - (select count(*) from public.punch_card_uses u
                                 where u.organization_id = c.organization_id and u.card_id = c.id
                                   and u.returned_at is null)::integer as remaining
        from orgs og
        join public.punch_cards c on c.organization_id = og.id
        join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id and ct.deleted_at is null
       where c.status = 'active'
         and (c.expires_on is null or c.expires_on >= og.today)
    )
    select z.* from (
      select c.*, k.kind, s.last_attempt_at, tn.served_at,
             -- a card that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by c.organization_id order by s.last_attempt_at nulls first, c.expires_on nulls last, c.id, k.kind) as n
        from cards c
        cross join lateral (values ('low'), ('expiry')) k(kind)
        left join app.punch_card_alerts_sent s on s.card_id = c.id and s.kind = k.kind
        left join app.punch_card_alert_turns tn on tn.organization_id = c.organization_id
       where c.remaining > 0
         and (s.card_id is null or (s.done_at is null and s.failures < 3))
         and case k.kind
               when 'low' then c.low_entries > 0 and c.remaining <= c.low_entries
               -- owner (131): the last day is near, and the card was activated before the window opened
               else c.expiry_days > 0 and c.expires_on is not null
                    and c.expires_on - c.today <= c.expiry_days
                    and c.activated_on < c.expires_on - c.expiry_days
             end
    ) z
     where z.n <= app.punch_card_alert_per_org()
     -- businesses take turns: every business's first card, then every business's second, ...; among businesses, the one
     -- served longest ago first, so a business with many cards never blocks another
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.id, z.kind
     limit app.punch_card_alert_limit()
  loop
    v_rep := null;
    if not (v_row.organization_id = any (v_served)) then
      v_served := v_served || v_row.organization_id;
    end if;
    begin
      -- the contact's owner while an active full-seat member who is not a viewer
      select m.user_id into v_rep
        from public.contacts ct
        join public.memberships m
          on m.organization_id = ct.organization_id and m.user_id = ct.owner_id
         and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
       where ct.organization_id = v_row.organization_id and ct.id = v_row.contact_id;

      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      select v_row.organization_id, r.user_id, 'punch_card',
             app.punch_card_alert_title(v_row.kind, v_row.remaining, v_row.expires_on - v_row.today),
             app.punch_card_alert_body(v_row.name, v_row.remaining, v_row.entries_total, v_row.expires_on),
             'contact', v_row.contact_id
        from (select v_rep as user_id where v_rep is not null
              union all
              -- else every active owner and admin
              select m.user_id from public.memberships m
               where v_rep is null and m.organization_id = v_row.organization_id and m.status = 'active'
                 and m.role in ('owner', 'admin')) r;

      insert into app.punch_card_alerts_sent (organization_id, card_id, kind, done_at)
      values (v_row.organization_id, v_row.id, v_row.kind, now())
      on conflict (card_id, kind) do update set done_at = excluded.done_at;
      v_done := v_done + 1;
    exception when others then
      -- tried again on a later run, after the fresh ones; skipped after 3 failures. One redacted line: card id and SQLSTATE
      insert into app.punch_card_alerts_sent (organization_id, card_id, kind, failures, last_attempt_at)
      values (v_row.organization_id, v_row.id, v_row.kind, 1, now())
      on conflict (card_id, kind)
        do update set failures = app.punch_card_alerts_sent.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-punch-card-alerts: card % (%) failed (SQLSTATE %)%', v_row.id, v_row.kind, sqlstate,
        case when coalesce((select s.failures from app.punch_card_alerts_sent s
                             where s.card_id = v_row.id and s.kind = v_row.kind), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;

  -- the businesses served in this run go to the back of the line
  insert into app.punch_card_alert_turns (organization_id, served_at)
  select o, clock_timestamp() from unnest(v_served) o
  on conflict (organization_id) do update set served_at = excluded.served_at;
  return v_done;
end;
$$;
revoke all on function app.send_punch_card_alerts(uuid[]) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-punch-card-alerts', '*/15 * * * *', 'select app.send_punch_card_alerts();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
