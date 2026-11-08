-- =============================================================================
-- PKG-03 (customer side): a service message to the customer beside the rep's alert
-- =============================================================================
-- Owner's answers of 4 November 2026 (DECISIONS.md, "התראות כרטיסייה"):
-- (127) ב a new SERVICE message type `punch_card_notice`, limited to: first name, card name, entries left, expiry date,
--       business phone (and the business's name, which the owner's own wording signs with); no price, no link, no renewal
--       offer (an offer is marketing and needs consent).
-- (128) א a default template, DRAFT until the lawyer edits it: "שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} נשארו {כניסות}
--       כניסות / התוקף עד {תאריך}. לפרטים: {טלפון העסק}. {שם העסק}". One text cannot serve both alerts (a card with few
--       entries and no expiry has no date to fill), so it is two texts, one per alert, split at the owner's "/". Owner
--       (138) ב: {כניסות} is filled with the whole phrase ("נשארה כניסה אחת" / "נשארו N כניסות", migration
--       punch_card_alert_answers), so the few-left text reads "בכרטיסייה {שם הכרטיסייה} {כניסות}." 
-- (129) ג the channel: the contact's preferred channel when it has one, else SMS, else WhatsApp, else email; only a
--       channel the contact has an address for (phone for SMS and WhatsApp, email for email) and a template for.
--
-- * The closed lists: app.message_types() and app.service_message_types() take 'punch_card_notice' (= MESSAGE_TYPES /
--   SERVICE_MESSAGE_TYPES); message_templates' type check is set again with it. The send check
--   (public.job_message_may_send, pinned by test 284) reads app.service_message_types() and is NOT changed: a
--   punch_card_notice is stopped only by the blocklist or an erasure block (app.consent_service_blocked), like every
--   service message, and HEB-09's pause holds it.
-- * Merge fields: {שם הכרטיסייה} and {כניסות} join the closed list (app.message_merge_fields(), at the end); {תאריך} is the
--   card's last day in this type. app.message_type_fields('punch_card_notice') = first name, business name, business
--   phone, card name, entries left, date (= SERVICE_TYPE_FIELDS).
-- * message_templates.notice_kind (server only, no client grant): 'punch_card_low' | 'punch_card_expiry' marks the two
--   seeded templates the job sends from. A business renames them, edits their text, moves them to another channel or
--   switches them off; a deleted or switched-off one means no customer message for that alert. Seeded for NEW
--   businesses by app.seed_punch_card_message_templates (after insert trigger organizations_seed_punch_card_templates,
--   which fires after organizations_seed_message_templates by name), and once for every live business that has none of
--   that mark (insert only; a business at its 50 templates is skipped with a warning). Mirrored by
--   DEFAULT_PUNCH_CARD_TEMPLATES.
-- * public.punch_card_alert_settings.customer_messages (default false, column grants): the customer is sent nothing until
--   the business switches it on (question to the owner: default on or off).
-- * The payload of message.send takes an optional `punch_card_id` (a uuid), so the sender fills the card's name, entries
--   and date (app.job_payload_ok, redefined from 021160 with the key added).
-- * app.send_punch_card_alerts (redefined from punch_card_alerts): after the rep's notice, while customer_messages is on, it
--   picks the channel and template (above), asks app.message_template_sendable (a code = app.message_send_refused tells
--   the owners and admins once a day, and nothing is queued), and queues ONE message.send through app.enqueue_job with
--   message_type 'punch_card_notice', template_id and punch_card_id; the expiry message carries event_at = the end of the
--   card's last day in the business's zone, so a message held past it is cancelled. The job id is kept on the alert row.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The closed lists of message types
-- ----------------------------------------------------------------------------
create or replace function app.message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'marketing']::text[] $$;
revoke all on function app.message_types() from public, anon, authenticated;

create or replace function app.service_message_types() returns text[]
language sql immutable
set search_path = ''
as $$ select array['meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice']::text[] $$;
revoke all on function app.service_message_types() from public, anon, authenticated;

alter table public.message_templates
  drop constraint if exists message_templates_message_type_check,
  add constraint message_templates_message_type_check
    check (message_type in ('meeting_reminder', 'requested_document', 'collection', 'verification_code', 'punch_card_notice', 'marketing'));

-- ----------------------------------------------------------------------------
-- Merge fields
-- ----------------------------------------------------------------------------
create or replace function app.message_merge_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'תאריך', 'שעה', 'מסמך', 'סכום', 'מועד תשלום', 'קישור להצעה',
               'טלפון העסק', 'כתובת העסק', 'תוקף', 'תוכן העדכון', 'קישור הסרה', 'קוד אימות', 'שם הכרטיסייה', 'כניסות']::text[]
$$;
revoke all on function app.message_merge_fields() from public, anon, authenticated;
-- the table's check trigger runs as the writer (a person)
grant execute on function app.message_merge_fields() to authenticated;

-- The merge fields a service type may hold; null for a type that is not a service type. Mirrors SERVICE_TYPE_FIELDS.
create or replace function app.message_type_fields(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'meeting_reminder' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'תאריך', 'שעה']::text[]
    when 'requested_document' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'מסמך', 'קישור להצעה', 'תוקף']::text[]
    when 'collection' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'מסמך', 'סכום', 'מועד תשלום']::text[]
    when 'verification_code' then array['שם העסק', 'קוד אימות']::text[]
    when 'punch_card_notice' then array['שם פרטי', 'שם העסק', 'טלפון העסק', 'שם הכרטיסייה', 'כניסות', 'תאריך']::text[]
  end
$$;
revoke all on function app.message_type_fields(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The queue payload: an optional punch_card_id (021160's rule plus the key)
-- ----------------------------------------------------------------------------
create or replace function app.job_payload_ok(p_kind text, p_payload jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then false
    when p_kind = 'message.send' then
      coalesce(
        (select bool_and(k in ('channel', 'lead_id', 'contact_id', 'event_at', 'message_type', 'template_id', 'punch_card_id'))
           from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
      and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
      and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      -- CNS-07: the message's type, from the closed list (enqueue_job requires it; a job queued before 021147 has none and is
      -- judged as marketing)
      and (not (p_payload ? 'message_type')
           or (jsonb_typeof(p_payload -> 'message_type') = 'string'
               and (p_payload ->> 'message_type') = any (app.message_types())))
      -- MSG-02 (103): the template the message is made from, so a refusal names it
      and (not (p_payload ? 'template_id')
           or (jsonb_typeof(p_payload -> 'template_id') = 'string'
               and (p_payload ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      -- PKG-03: the punch card a punch_card_notice is about (the sender fills its name, entries and date)
      and (not (p_payload ? 'punch_card_id')
           or (jsonb_typeof(p_payload -> 'punch_card_id') = 'string'
               and (p_payload ->> 'punch_card_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The two templates the job sends from
-- ----------------------------------------------------------------------------
alter table public.message_templates add column if not exists notice_kind text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'message_templates_notice_kind_check' and conrelid = 'public.message_templates'::regclass) then
    alter table public.message_templates add constraint message_templates_notice_kind_check
      check (notice_kind is null or notice_kind in ('punch_card_low', 'punch_card_expiry'));
  end if;
end;
$$;
create index if not exists message_templates_notice_kind_idx on public.message_templates (organization_id, notice_kind)
  where notice_kind is not null;
-- server only: no insert or update grant on the column (select is table-wide)

-- DRAFT wording (owner (128) א) until the lawyer edits it. Each is added while the business has no template of its mark.
create or replace function app.seed_punch_card_message_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind)
  select p_org, d.name, d.channel, d.message_type, d.subject, d.body, d.notice_kind
    from (values
      (1, 'כרטיסייה: נשארו מעט כניסות', 'sms', 'punch_card_notice', null::text,
          'שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} {כניסות}. לפרטים: {טלפון העסק}. {שם העסק}', 'punch_card_low'),
      (2, 'כרטיסייה: התוקף מתקרב', 'sms', 'punch_card_notice', null::text,
          'שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} התוקף עד {תאריך}. לפרטים: {טלפון העסק}. {שם העסק}', 'punch_card_expiry')
    ) as d(n, name, channel, message_type, subject, body, notice_kind)
   where not exists (select 1 from public.message_templates t where t.organization_id = p_org and t.notice_kind = d.notice_kind)
     -- a business that already has a template of this name keeps it (names are unique ignoring case)
     and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(d.name))
   order by d.n;
end;
$$;
revoke all on function app.seed_punch_card_message_templates(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_punch_card_templates() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_punch_card_message_templates(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_punch_card_templates() from public, anon, authenticated;

-- named to fire after organizations_seed_message_templates (triggers of one event fire by name), so a new business gets
-- the four general templates first
create or replace trigger organizations_seed_punch_card_templates after insert on public.organizations
  for each row execute function app.organizations_seed_punch_card_templates();

-- live businesses whose plan holds punch_cards (owner (141) ב): once each, insert only; a business that fails (50
-- templates already) is skipped with a warning
do $$
declare
  v_org uuid;
begin
  for v_org in
    select o.id from public.organizations o
     where o.deleted_at is null
       and app.org_has_feature(o.id, 'punch_cards')
       and (not exists (select 1 from public.message_templates t where t.organization_id = o.id and t.notice_kind = 'punch_card_low')
            or not exists (select 1 from public.message_templates t where t.organization_id = o.id and t.notice_kind = 'punch_card_expiry'))
     order by o.id
  loop
    begin
      perform app.seed_punch_card_message_templates(v_org);
    exception when others then
      raise warning 'punch card message templates were not seeded for business %: % %', v_org, sqlstate, sqlerrm;
    end;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- The business's switch for customer messages
-- ----------------------------------------------------------------------------
alter table public.punch_card_alert_settings add column if not exists customer_messages boolean not null default false;
grant insert (customer_messages) on public.punch_card_alert_settings to authenticated;
grant update (customer_messages) on public.punch_card_alert_settings to authenticated;

alter table app.punch_card_alerts_sent add column if not exists message_job_id uuid;

-- ----------------------------------------------------------------------------
-- The customer's channel and template (owner (129) ג)
-- ----------------------------------------------------------------------------
-- The template the job sends a card's alert from: the contact's preferred channel first (sms, whatsapp or email), then
-- SMS, WhatsApp and email, each only with an address for it and an active template of the alert's mark on that channel
-- (the oldest when there are several). Null = nothing to send.
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
     and nullif(btrim(case when o.ch = 'email' then c.email else c.phone end), '') is not null
   order by o.ord, t.created_at, t.id
   limit 1
$$;
revoke all on function app.punch_card_notice_template(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job, from punch_card_alerts plus the customer's message
-- ----------------------------------------------------------------------------
create or replace function app.send_punch_card_alerts(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_rep uuid;
  v_template uuid;
  v_channel text;
  v_problem text;
  v_job uuid;
  v_done integer := 0;
  v_served uuid[] := '{}'::uuid[];
begin
  for v_row in
    with orgs as materialized (
      -- the businesses first: writable, the plan key, and 08:00 or later in the business's zone
      select o.id, app.intake_zone(o.timezone) as zone,
             (now() at time zone app.intake_zone(o.timezone))::date as today,
             coalesce(s.low_entries, 2) as low_entries, coalesce(s.expiry_days, 14) as expiry_days,
             coalesce(s.customer_messages, false) as customer_messages
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
             og.today, og.zone, og.low_entries, og.expiry_days, og.customer_messages,
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
    v_template := null;
    v_channel := null;
    v_problem := null;
    v_job := null;
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

      -- PKG-03 (127)-(129): the customer's service message, while the business sends them
      if v_row.customer_messages then
        select nt.template_id, nt.channel into v_template, v_channel
          from app.punch_card_notice_template(v_row.organization_id, v_row.contact_id, v_row.kind) nt;
        if v_template is not null then
          v_problem := app.message_template_sendable(v_row.organization_id, v_template);
          if v_problem is null then
            v_job := app.enqueue_job(
              v_row.organization_id, 'message.send',
              jsonb_build_object('channel', v_channel, 'contact_id', v_row.contact_id, 'message_type', 'punch_card_notice',
                                 'template_id', v_template, 'punch_card_id', v_row.id)
              -- the expiry message is pointless after the card's last day: held past its end (a pause), it is cancelled
              || case when v_row.kind = 'expiry'
                      then jsonb_build_object('event_at',
                             to_char(((v_row.expires_on + 1)::timestamp at time zone v_row.zone) at time zone 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                      else '{}'::jsonb end);
          else
            -- the template cannot be sent as it is: the owners and admins are told (once a template and reason a day)
            perform app.message_send_refused(v_row.organization_id, v_template, v_problem);
          end if;
        end if;
      end if;

      insert into app.punch_card_alerts_sent (organization_id, card_id, kind, done_at, message_job_id)
      values (v_row.organization_id, v_row.id, v_row.kind, now(), v_job)
      on conflict (card_id, kind) do update set done_at = excluded.done_at, message_job_id = excluded.message_job_id;
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

notify pgrst, 'reload schema';
