-- =============================================================================
-- PKG-03, the owner's answers of 8 November 2026 (DECISIONS.md, "התראות כרטיסייה, השלמות"), (137)-(142)
-- =============================================================================
-- (137) א the customer message stays off until the business switches it on: unchanged (punch_card_notice_messages).
-- (138) ב {כניסות} is filled with the whole phrase: app.punch_card_entries_text(n) = punchEntriesText() in
--       src/features/punch-cards/alerts.ts, both run tests/unit/fixtures/punch-card-entries.json (unit test and test 301):
--       1 = "נשארה כניסה אחת", 0 = "לא נשארו כניסות", else "נשארו N כניסות". The rep's few-left title is
--       "כרטיסייה: " + that phrase, and the DRAFT few-left template (seeded by 021177 already with this wording, and by
--       the seed below) reads "… בכרטיסייה {שם הכרטיסייה} {כניסות}. …". No existing row is rewritten.
-- (139) ב few left includes zero: entries left <= low_entries, 0 left included (a card used up alerts once, if it did not
--       already). low_entries = 0 still switches the alert off. The last-day alert still needs an entry left.
-- (140) ב no alert for the state at release, per card: the first time the job sees a business with the punch_cards key
--       (app.punch_card_alert_orgs has no active row for it), it marks every card that already meets an alert as done
--       without a notice or a message (app.punch_card_alerts_sent.baseline = true), whatever the hour and whether or not
--       it can write; only a card that crosses a threshold afterwards alerts. A business that loses the key is marked
--       inactive by the job, and when it gains the key again it is marked afresh the same way (so an upgrade never brings
--       a burst about cards sold before it). A change of the business's numbers (low_entries, expiry_days, from 0 too) marks
--       at once what the new numbers reach and the old ones did not (trigger punch_card_alert_settings_baseline), so only a
--       card that crosses them afterwards alerts, and a card already due under the old numbers is still alerted. A baseline also marks cards whose contact is in the bin (a restore is no burst).
-- (141) ב the two notice templates are seeded only for a business whose plan holds punch_cards, and only while it has
--       none of them (no template of either mark): at the business's insert (when its plan already holds the key) and by
--       the job when it first sees the business with the key (an upgrade, or the release). Nothing is seeded here;
--       021177's one-off backfill covers only businesses with the key. 021176-021178 are applied as one group.
-- (142) א only the system templates (notice_kind stays server-only): unchanged.
-- The independent review of the branch (8 November 2026):
-- (1) every customer message carries event_at: the end of the card's last day, else of the day 7 days after the alert, in
--     the business's zone, so a message that waits (no provider for its channel, a pause) is cancelled, never sent stale.
--     THE FUTURE SENDER of a punch_card_notice MUST re-read the card by punch_card_id, scoped to the job's business and its
--     contact_id, and send nothing unless the card is still active and held by that contact.
-- (2) owner (148) ב: the rep is told at once; the customer gets the few-left message after the first use that leaves the
--     card at or under the number. The customer's side is tracked apart (app.punch_card_customer_notices): a row waits
--     for each alert the rep was told about while customer messages were on, and is sent once, on a later run if needed.
-- (3) both waiting for one card: one customer message, the expiry one, which covers the few-left one only while that one
--     is due itself (a live use, at or under the number); a few-left row still waiting for its first use stays waiting and
--     goes when it becomes due. The rep gets both notices; an expiry message given up after 3 failures lets the few-left
--     one go. A few-left message ends at least(the card's last day, today + 7) in the business's zone.
--     Waiting customer rows that can never be sent are closed with a reason and no message (closed_reason): the card is
--     no longer active, past its last day, its contact is gone (in the bin or removed), or customer messages were switched
--     off while it waited (so switching them on again brings no burst).
-- (4) the baselines above (a change of the numbers marks only what the new numbers reach and the old ones did not, an
--     insert compared with the defaults; cards of binned contacts).
-- (5) the seed inserts what fits (each template on its own, one warning per business and try) and a mark never seeded is
--     tried again, at most once a day per business (app.punch_card_alert_orgs.seed_tried_on); a mark once seeded is never
--     brought back while the other one is there (app.punch_card_template_seeds).
-- (6) SMS and WhatsApp need contacts.phone_e164.
-- (8) pairs already done are left out before the uses are counted.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- (138) the {כניסות} phrase
-- ----------------------------------------------------------------------------
create or replace function app.punch_card_entries_text(p_left integer) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_left is null then null
    when p_left <= 0 then 'לא נשארו כניסות'
    when p_left = 1 then 'נשארה כניסה אחת'
    else 'נשארו ' || p_left || ' כניסות'
  end
$$;
revoke all on function app.punch_card_entries_text(integer) from public, anon, authenticated, service_role;

create or replace function app.punch_card_alert_title(p_kind text, p_remaining integer, p_days integer) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_kind = 'low' then 'כרטיסייה: ' || app.punch_card_entries_text(p_remaining)
    when p_kind = 'expiry' and p_days <= 0 then 'כרטיסייה: התוקף מסתיים היום'
    when p_kind = 'expiry' and p_days = 1 then 'כרטיסייה: התוקף מסתיים מחר'
    when p_kind = 'expiry' then 'כרטיסייה: התוקף מסתיים בעוד ' || p_days || ' ימים'
  end
$$;
revoke all on function app.punch_card_alert_title(text, integer, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (140) the businesses the job has started for, and the cards marked at that start
-- ----------------------------------------------------------------------------
alter table app.punch_card_alerts_sent add column if not exists baseline boolean not null default false;

create table if not exists app.punch_card_alert_orgs (
  organization_id  uuid primary key references public.organizations (id) on delete cascade,
  active           boolean not null default true,
  started_at       timestamptz not null default now()
);
alter table app.punch_card_alert_orgs enable row level security;
revoke all on app.punch_card_alert_orgs from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (141) the seed: only with the key; what fits; a mark seeded once is never brought back while the other one is there
-- ----------------------------------------------------------------------------
-- The marks ever seeded (or found) for a business; a mark not here is tried again on later runs (review finding 5: near
-- the 50-template cap only one may fit). No grants, RLS on, cascades with the business.
create table if not exists app.punch_card_template_seeds (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  notice_kind      text not null check (notice_kind in ('punch_card_low', 'punch_card_expiry')),
  seeded_at        timestamptz not null default now(),
  primary key (organization_id, notice_kind)
);
alter table app.punch_card_template_seeds enable row level security;
revoke all on app.punch_card_template_seeds from public, anon, authenticated, service_role;

-- A mark is added when the business has no template of it AND (it has no marked template at all, or the mark was never
-- seeded); each insert on its own, so a cap refusal or a name the business already uses skips that one only.
create or replace function app.seed_punch_card_message_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_none boolean;
  v_row record;
  v_failed text[] := '{}'::text[];
begin
  if not coalesce(app.org_has_feature(p_org, 'punch_cards'), false) then
    return;
  end if;
  -- what the business holds counts as seeded (021177's backfill, or a template it kept)
  insert into app.punch_card_template_seeds (organization_id, notice_kind)
  select distinct p_org, t.notice_kind from public.message_templates t
   where t.organization_id = p_org and t.notice_kind is not null
  on conflict do nothing;
  v_none := not exists (select 1 from public.message_templates t where t.organization_id = p_org and t.notice_kind is not null);
  for v_row in
    select d.name, d.channel, d.message_type, d.body, d.notice_kind
      from (values
        (1, 'כרטיסייה: נשארו מעט כניסות', 'sms', 'punch_card_notice',
            'שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} {כניסות}. לפרטים: {טלפון העסק}. {שם העסק}', 'punch_card_low'),
        (2, 'כרטיסייה: התוקף מתקרב', 'sms', 'punch_card_notice',
            'שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} התוקף עד {תאריך}. לפרטים: {טלפון העסק}. {שם העסק}', 'punch_card_expiry')
      ) as d(n, name, channel, message_type, body, notice_kind)
     where (v_none or not exists (select 1 from app.punch_card_template_seeds s
                                   where s.organization_id = p_org and s.notice_kind = d.notice_kind))
       -- a business that already has a template of this name keeps it (names are unique ignoring case)
       and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(d.name))
     order by d.n
  loop
    begin
      insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind)
      values (p_org, v_row.name, v_row.channel, v_row.message_type, null, v_row.body, v_row.notice_kind);
      insert into app.punch_card_template_seeds (organization_id, notice_kind)
      values (p_org, v_row.notice_kind)
      on conflict (organization_id, notice_kind) do update set seeded_at = excluded.seeded_at;
    exception when others then
      -- the 50-template cap, most likely: tried again on a later day
      v_failed := v_failed || (v_row.notice_kind || ' ' || sqlstate);
    end;
  end loop;
  if cardinality(v_failed) > 0 then
    -- one line per business and try (re-review finding 4)
    raise warning 'punch card templates not seeded for business %: %', p_org, array_to_string(v_failed, ', ');
  end if;
end;
$$;
revoke all on function app.seed_punch_card_message_templates(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- (review finding 6) the customer's channel: SMS and WhatsApp need a phone the system could read (phone_e164)
-- ----------------------------------------------------------------------------
create or replace function app.punch_card_notice_template(p_org uuid, p_contact uuid, p_kind text)
returns table (template_id uuid, channel text)
language sql stable security definer
set search_path = ''
as $$
  select t.id, t.channel
    from public.contacts c
    cross join lateral (
      select ch, ord from (values (c.preferred_channel, 0), ('sms', 1), ('whatsapp', 2), ('email', 3)) v(ch, ord)
       where ch in ('sms', 'whatsapp', 'email')
    ) o
    join public.message_templates t
      on t.organization_id = c.organization_id and t.channel = o.ch and t.is_active
     and t.message_type = 'punch_card_notice' and t.notice_kind = 'punch_card_' || p_kind
   where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null
     and nullif(btrim(case when o.ch = 'email' then c.email else c.phone_e164 end), '') is not null
   order by o.ord, t.created_at, t.id
   limit 1
$$;
revoke all on function app.punch_card_notice_template(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The cards that meet an alert now (one row per card and kind not done yet), for the job and its baselines
-- ----------------------------------------------------------------------------
-- p_with_binned: a baseline also marks cards whose contact is in the bin (review finding 4), so a restore later is no
-- burst; the job sends only for live contacts. p_low_entries / p_expiry_days: the numbers to judge by instead of the
-- business's stored ones (the settings baseline judges the old and the new numbers). Pairs already done (or given up) are
-- left out before the uses are counted (review finding 8).
create or replace function app.punch_card_alert_candidates(p_orgs uuid[], p_with_binned boolean default false,
                                                           p_low_entries integer default null, p_expiry_days integer default null)
returns table (
  organization_id uuid, card_id uuid, contact_id uuid, name text, entries_total integer, expires_on date,
  today date, zone text, remaining integer, used integer, kind text, customer_messages boolean,
  writable boolean, after_eight boolean, last_attempt_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  with orgs as materialized (
    select o.id, app.intake_zone(o.timezone) as zone,
           (now() at time zone app.intake_zone(o.timezone))::date as today,
           coalesce(p_low_entries, s.low_entries, 2) as low_entries, coalesce(p_expiry_days, s.expiry_days, 14) as expiry_days,
           coalesce(s.customer_messages, false) as customer_messages,
           app.org_writable(o.id) as writable,
           (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00' as after_eight
      from public.organizations o
      left join public.punch_card_alert_settings s on s.organization_id = o.id
     where (p_orgs is null or o.id = any (p_orgs))
       and o.deleted_at is null
       and app.org_has_feature(o.id, 'punch_cards')
       and (coalesce(p_low_entries, s.low_entries, 2) > 0 or coalesce(p_expiry_days, s.expiry_days, 14) > 0)
  ),
  pending as materialized (
    select c.organization_id, c.id, c.contact_id, c.name, c.entries_total, c.expires_on,
           (c.activated_at at time zone og.zone)::date as activated_on,
           og.today, og.zone, og.low_entries, og.expiry_days, og.customer_messages, og.writable, og.after_eight
      from orgs og
      join public.punch_cards c on c.organization_id = og.id
      join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
                             and (p_with_binned or ct.deleted_at is null)
     where c.status = 'active'
       and (c.expires_on is null or c.expires_on >= og.today)
       -- both kinds done or given up: nothing to count
       and (select count(*) from app.punch_card_alerts_sent s
             where s.card_id = c.id and (s.done_at is not null or s.failures >= 3)) < 2
  ),
  cards as materialized (
    select p.*, (select count(*) from public.punch_card_uses u
                  where u.organization_id = p.organization_id and u.card_id = p.id and u.returned_at is null)::integer as used
      from pending p
  )
  select c.organization_id, c.id, c.contact_id, c.name, c.entries_total, c.expires_on, c.today, c.zone,
         greatest(c.entries_total - c.used, 0), c.used, k.kind, c.customer_messages, c.writable, c.after_eight, s.last_attempt_at
    from cards c
    cross join lateral (values ('low'), ('expiry')) k(kind)
    left join app.punch_card_alerts_sent s on s.card_id = c.id and s.kind = k.kind
   where (s.card_id is null or (s.done_at is null and s.failures < 3))
     and case k.kind
           -- (139) 0 left included
           when 'low' then c.low_entries > 0 and c.entries_total - c.used <= c.low_entries
           -- owner (131): the last day is near, an entry is left, and the card was activated before the window opened
           else c.entries_total - c.used > 0 and c.expiry_days > 0 and c.expires_on is not null
                and c.expires_on - c.today <= c.expiry_days
                and c.activated_on < c.expires_on - c.expiry_days
         end
$$;
revoke all on function app.punch_card_alert_candidates(uuid[], boolean, integer, integer) from public, anon, authenticated, service_role;

-- (140) mark every card of a business that meets an alert now as done, with no notice and no message (the job's start)
create or replace function app.punch_card_alert_baseline(p_org uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  insert into app.punch_card_alerts_sent (organization_id, card_id, kind, done_at, baseline)
  select c.organization_id, c.card_id, c.kind, now(), true
    from app.punch_card_alert_candidates(array[p_org], true) c
  on conflict (card_id, kind) do update set done_at = excluded.done_at, baseline = true
    where app.punch_card_alerts_sent.done_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.punch_card_alert_baseline(uuid) from public, anon, authenticated, service_role;

-- (140, re-review finding 1) a change of the numbers marks ONLY what the new numbers reach and the old ones did not: a
-- card that was already due under the old numbers and not yet alerted is still alerted by the job
create or replace function app.punch_card_alert_baseline_change(p_org uuid, p_old_low integer, p_old_expiry integer,
                                                                p_new_low integer, p_new_expiry integer) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  insert into app.punch_card_alerts_sent (organization_id, card_id, kind, done_at, baseline)
  select n.organization_id, n.card_id, n.kind, now(), true
    from app.punch_card_alert_candidates(array[p_org], true, p_new_low, p_new_expiry) n
   where not exists (select 1 from app.punch_card_alert_candidates(array[p_org], true, p_old_low, p_old_expiry) o
                      where o.card_id = n.card_id and o.kind = n.kind)
  on conflict (card_id, kind) do update set done_at = excluded.done_at, baseline = true
    where app.punch_card_alerts_sent.done_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.punch_card_alert_baseline_change(uuid, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;

-- AFTER insert or update of the numbers (a person's write, which RLS already judged); definer, so it writes the app
-- table. An insert compares with the defaults (no row = 2 and 14); a save that keeps both numbers marks nothing.
create or replace function app.punch_card_alert_settings_baseline() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old_low integer := 2;
  v_old_expiry integer := 14;
begin
  if tg_op = 'UPDATE' then
    v_old_low := old.low_entries;
    v_old_expiry := old.expiry_days;
  end if;
  if new.low_entries is not distinct from v_old_low and new.expiry_days is not distinct from v_old_expiry then
    return null;
  end if;
  perform app.punch_card_alert_baseline_change(new.organization_id, v_old_low, v_old_expiry, new.low_entries, new.expiry_days);
  return null;
end;
$$;
revoke all on function app.punch_card_alert_settings_baseline() from public, anon, authenticated, service_role;

create or replace trigger punch_card_alert_settings_baseline after insert or update of low_entries, expiry_days
  on public.punch_card_alert_settings
  for each row execute function app.punch_card_alert_settings_baseline();

-- ----------------------------------------------------------------------------
-- (re-review finding 2, owner (148) ב) the customer's side of an alert, apart from the rep's
-- ----------------------------------------------------------------------------
-- A row waits for each alert the rep was told about while customer messages were on. The expiry one is sent on the next
-- pass; the few-left one once the card has a live use and is still at or under the number ("after the first use that
-- leaves the card at or under the threshold"). Exactly once each: done_at; a run that fails counts, 3 = given up. When
-- both wait for one card, the expiry message goes and covers the few-left one (covered = true); a given-up expiry message
-- lets the few-left one go (re-review finding 3). No grants, RLS on, cascades with the card.
create table if not exists app.punch_card_customer_notices (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  card_id          uuid not null,
  kind             text not null check (kind in ('low', 'expiry')),
  created_at       timestamptz not null default now(),
  done_at          timestamptz,
  covered          boolean not null default false,
  job_id           uuid,
  failures         integer not null default 0,
  last_attempt_at  timestamptz,
  primary key (card_id, kind),
  constraint punch_card_customer_notices_card_fk foreign key (organization_id, card_id)
    references public.punch_cards (organization_id, id) on delete cascade
);
create index if not exists punch_card_customer_notices_org_idx on app.punch_card_customer_notices (organization_id, card_id);
-- why a waiting row was closed without a message (null = sent, refused by its template, or covered)
alter table app.punch_card_customer_notices add column if not exists closed_reason text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'punch_card_customer_notices_closed_reason_check'
                   and conrelid = 'app.punch_card_customer_notices'::regclass) then
    alter table app.punch_card_customer_notices add constraint punch_card_customer_notices_closed_reason_check
      check (closed_reason is null or closed_reason in ('card_inactive', 'card_expired', 'contact_gone', 'messages_off'));
  end if;
end;
$$;
alter table app.punch_card_customer_notices enable row level security;
revoke all on app.punch_card_customer_notices from public, anon, authenticated, service_role;

-- (re-review finding 4) the last day the seed was tried again for a business: at most once a day
alter table app.punch_card_alert_orgs add column if not exists seed_tried_on date;

-- ----------------------------------------------------------------------------
-- The job, from punch_card_notice_messages with (138)-(141) and the reviews' findings
-- ----------------------------------------------------------------------------
create or replace function app.send_punch_card_alerts(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_org uuid;
  v_rep uuid;
  v_kind text;
  v_template uuid;
  v_channel text;
  v_problem text;
  v_job uuid;
  v_event_day date;
  v_done integer := 0;
  v_served uuid[] := '{}'::uuid[];
begin
  -- (140) a business that lost the key starts afresh when it gains it again
  update app.punch_card_alert_orgs a set active = false
   where a.active and (p_orgs is null or a.organization_id = any (p_orgs))
     and not coalesce(app.org_has_feature(a.organization_id, 'punch_cards'), false);

  -- (140)/(141) a business seen with the key for the first time (release, an upgrade): its templates while it has none,
  -- and every card that already meets an alert marked done without a notice
  for v_org in
    select o.id from public.organizations o
     where (p_orgs is null or o.id = any (p_orgs))
       and o.deleted_at is null
       and app.org_has_feature(o.id, 'punch_cards')
       and not exists (select 1 from app.punch_card_alert_orgs a where a.organization_id = o.id and a.active)
     order by o.id
  loop
    begin
      perform app.seed_punch_card_message_templates(v_org);
    exception when others then
      raise warning 'crm-punch-card-alerts: templates not seeded for business % (SQLSTATE %)', v_org, sqlstate;
    end;
    begin
      perform app.punch_card_alert_baseline(v_org);
      insert into app.punch_card_alert_orgs (organization_id, active, started_at, seed_tried_on)
      values (v_org, true, now(), current_date)
      on conflict (organization_id) do update set active = true, started_at = excluded.started_at,
                                                  seed_tried_on = excluded.seed_tried_on;
    exception when others then
      raise warning 'crm-punch-card-alerts: business % not started (SQLSTATE %)', v_org, sqlstate;
    end;
  end loop;

  -- (141, review finding 5; re-review finding 4) a started business with a mark never seeded (the cap was in the way) is
  -- tried again, at most once a day
  for v_org in
    select a.organization_id from app.punch_card_alert_orgs a
     where a.active and (p_orgs is null or a.organization_id = any (p_orgs))
       and a.seed_tried_on is distinct from current_date
       and (select count(*) from app.punch_card_template_seeds s where s.organization_id = a.organization_id) < 2
       and app.org_has_feature(a.organization_id, 'punch_cards')
     order by a.seed_tried_on nulls first, a.organization_id
     limit 200
  loop
    update app.punch_card_alert_orgs a set seed_tried_on = current_date where a.organization_id = v_org;
    begin
      perform app.seed_punch_card_message_templates(v_org);
    exception when others then
      raise warning 'crm-punch-card-alerts: templates not seeded for business % (SQLSTATE %)', v_org, sqlstate;
    end;
  end loop;

  -- the rep's notices
  for v_row in
    select z.* from (
      select c.*, tn.served_at,
             -- a card that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by c.organization_id order by c.last_attempt_at nulls first, c.expires_on nulls last, c.card_id, c.kind) as n
        from app.punch_card_alert_candidates(p_orgs) c
        join app.punch_card_alert_orgs a on a.organization_id = c.organization_id and a.active
        left join app.punch_card_alert_turns tn on tn.organization_id = c.organization_id
       where c.writable and c.after_eight
    ) z
     where z.n <= app.punch_card_alert_per_org()
     -- businesses take turns: every business's first card, then every business's second, ...; among businesses, the one
     -- served longest ago first, so a business with many cards never blocks another
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.card_id, z.kind
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

      -- PKG-03 (127)-(129): the customer's side waits beside it, while the business sends customer messages
      if v_row.customer_messages then
        insert into app.punch_card_customer_notices (organization_id, card_id, kind)
        values (v_row.organization_id, v_row.card_id, v_row.kind)
        on conflict (card_id, kind) do nothing;
      end if;

      insert into app.punch_card_alerts_sent (organization_id, card_id, kind, done_at)
      values (v_row.organization_id, v_row.card_id, v_row.kind, now())
      on conflict (card_id, kind) do update set done_at = excluded.done_at;
      v_done := v_done + 1;
    exception when others then
      -- tried again on a later run, after the fresh ones; skipped after 3 failures. One redacted line: card id and SQLSTATE
      insert into app.punch_card_alerts_sent (organization_id, card_id, kind, failures, last_attempt_at)
      values (v_row.organization_id, v_row.card_id, v_row.kind, 1, now())
      on conflict (card_id, kind)
        do update set failures = app.punch_card_alerts_sent.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-punch-card-alerts: card % (%) failed (SQLSTATE %)%', v_row.card_id, v_row.kind, sqlstate,
        case when coalesce((select s.failures from app.punch_card_alerts_sent s
                             where s.card_id = v_row.card_id and s.kind = v_row.kind), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;

  -- waiting customer rows that can never be sent are closed with a reason, no message (re-review finding 3)
  update app.punch_card_customer_notices w
     set done_at = now(),
         closed_reason = case
           when c.id is null or c.status <> 'active' then 'card_inactive'
           when c.expires_on is not null
                and c.expires_on < (now() at time zone app.intake_zone(o.timezone))::date then 'card_expired'
           when ct.id is null or ct.deleted_at is not null then 'contact_gone'
           else 'messages_off'
         end
    from public.organizations o
    left join public.punch_card_alert_settings st on st.organization_id = o.id
    left join public.punch_cards c on c.organization_id = o.id
    left join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
   where o.id = w.organization_id and c.id = w.card_id
     and w.done_at is null
     and (p_orgs is null or w.organization_id = any (p_orgs))
     and (c.status <> 'active'
          or (c.expires_on is not null and c.expires_on < (now() at time zone app.intake_zone(o.timezone))::date)
          or ct.id is null or ct.deleted_at is not null
          or not coalesce(st.customer_messages, false));

  -- the customer's messages: one card at a time, the message its waiting rows call for now
  for v_row in
    with waiting as (
      select w.organization_id, w.card_id,
             bool_or(w.kind = 'expiry' and w.done_at is null and w.failures < 3) as expiry_waits,
             bool_or(w.kind = 'low' and w.done_at is null and w.failures < 3) as low_waits,
             max(w.last_attempt_at) as last_attempt_at
        from app.punch_card_customer_notices w
       where (p_orgs is null or w.organization_id = any (p_orgs))
         and w.done_at is null and w.failures < 3
       group by w.organization_id, w.card_id
    ),
    judged as (
      select w.*, c.contact_id, c.expires_on, s.low_entries, og.zone, og.today,
             c.entries_total - (select count(*) from public.punch_card_uses u
                                 where u.organization_id = c.organization_id and u.card_id = c.id
                                   and u.returned_at is null)::integer as remaining,
             (select count(*) from public.punch_card_uses u
               where u.organization_id = c.organization_id and u.card_id = c.id and u.returned_at is null)::integer as used
        from waiting w
        join app.punch_card_alert_orgs a on a.organization_id = w.organization_id and a.active
        join public.punch_card_alert_settings s on s.organization_id = w.organization_id and s.customer_messages
        join public.punch_cards c on c.organization_id = w.organization_id and c.id = w.card_id and c.status = 'active'
        join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id and ct.deleted_at is null
        cross join lateral (
          select app.intake_zone(o.timezone) as zone, (now() at time zone app.intake_zone(o.timezone))::date as today,
                 (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00' as after_eight
            from public.organizations o where o.id = w.organization_id
        ) og
       where og.after_eight and app.org_writable(w.organization_id) and app.org_has_feature(w.organization_id, 'punch_cards')
         and (c.expires_on is null or c.expires_on >= og.today)
    ),
    chosen as (
      select j.*,
             case
               when j.expiry_waits and j.remaining > 0 then 'expiry'
               -- (148) ב after the first use that leaves the card at or under the number
               when j.low_waits and j.used > 0 and j.low_entries > 0 and j.remaining <= j.low_entries then 'low'
             end as send_kind,
             row_number() over (partition by j.organization_id order by j.last_attempt_at nulls first, j.card_id) as n
        from judged j
    )
    select * from chosen
     where send_kind is not null and n <= app.punch_card_alert_per_org()
     order by n, organization_id, card_id
     limit app.punch_card_alert_limit()
  loop
    v_kind := v_row.send_kind;
    v_template := null;
    v_channel := null;
    v_problem := null;
    v_job := null;
    begin
      select nt.template_id, nt.channel into v_template, v_channel
        from app.punch_card_notice_template(v_row.organization_id, v_row.contact_id, v_kind) nt;
      if v_template is not null then
        v_problem := app.message_template_sendable(v_row.organization_id, v_template);
        if v_problem is null then
          -- review finding 1: every message ends; held past its event (no provider for the channel, a pause) it is
          -- cancelled instead of going out stale: the end of the card's last day, else of the day 7 days from today
          -- (re-review finding 2) a few-left message ends at least(the last day, today + 7); least() skips a null
          v_event_day := case when v_kind = 'expiry' then v_row.expires_on
                              else least(v_row.expires_on, v_row.today + 7) end;
          -- THE FUTURE SENDER of a punch_card_notice MUST re-read the card by punch_card_id, scoped to the job's
          -- business AND its contact_id, and send nothing unless the card is still active and held by that contact
          -- (a card cancelled, transferred or merged away since the job was queued says nothing true any more); it
          -- fills {כניסות} with app.punch_card_entries_text / punchEntriesText and {תאריך} with the card's expires_on
          v_job := app.enqueue_job(
            v_row.organization_id, 'message.send',
            jsonb_build_object('channel', v_channel, 'contact_id', v_row.contact_id, 'message_type', 'punch_card_notice',
                               'template_id', v_template, 'punch_card_id', v_row.card_id,
                               'event_at', to_char(((v_event_day + 1)::timestamp at time zone v_row.zone) at time zone 'UTC',
                                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
        else
          -- the template cannot be sent as it is: the owners and admins are told (once a template and reason a day)
          perform app.message_send_refused(v_row.organization_id, v_template, v_problem);
        end if;
      end if;
      update app.punch_card_customer_notices w set done_at = now(), job_id = v_job
       where w.card_id = v_row.card_id and w.kind = v_kind;
      -- the expiry message covers a few-left one only while that one is due itself (re-review finding 1); one still
      -- waiting for its first use stays waiting
      if v_kind = 'expiry' and v_row.used > 0 and v_row.low_entries > 0 and v_row.remaining <= v_row.low_entries then
        update app.punch_card_customer_notices w set done_at = now(), covered = true
         where w.card_id = v_row.card_id and w.kind = 'low' and w.done_at is null;
      end if;
    exception when others then
      update app.punch_card_customer_notices w set failures = w.failures + 1, last_attempt_at = now()
       where w.card_id = v_row.card_id and w.kind = v_kind;
      raise warning 'crm-punch-card-alerts: customer message for card % (%) failed (SQLSTATE %)', v_row.card_id, v_kind, sqlstate;
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

notify pgrst, 'reload schema';
