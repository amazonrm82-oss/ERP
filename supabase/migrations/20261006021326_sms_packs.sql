-- =============================================================================
-- SMS-06 (owner 18 November 2026, answers (437) א, (438) א, (439) א): SMS sold as prepaid packs of segments
-- =============================================================================
-- SMS is sold in packs of 300 / 1,000 / 5,000 segments (35 / 99 / 390 ₪ before VAT). Packs add up, and the balance never
-- expires while the business is active. Until a clearing provider is chosen the platform owner loads a pack by hand
-- (public.platform_sms_grant, logged in app.platform_log).
--
-- * app.sms_balances: one row per business (the balance in segments, when a balance was first loaded, the size of the last
--   pack). app.sms_balance_movements: one row for every load, charge, give-back and clearing, with the balance after it. The
--   balance changes ONLY together with a movement row: app.sms_balance_move is the one writer, and the guard trigger
--   sms_balances_guard refuses any change of the number that does not name a new movement with that delta and balance.
--   Movements are never changed (sms_balance_movements_frozen). Both in schema app: RLS on, no grants.
-- * Counting: app.sms_segments(text) = smsSegments() (src/features/messaging/sms-segments.ts, shared fixture
--   tests/unit/fixtures/sms-segments.json): a text of GSM-7 characters only is 1 segment up to 160 septets (an extension
--   character counts 2), else ceil(septets / 153); any other text is UCS-2: 1 segment up to 70 UTF-16 units, else
--   ceil(units / 67). The final text is known only in the composer, so public.sms_job_compose (the wrapper over
--   app.sms_compose_core, whose body is unchanged) charges the composed text through app.sms_balance_charge, once per job
--   (a retry after a provider throttle is not charged again).
-- * public.job_message_may_send (021300's body; only its SMS lines change) keeps the gate: the plan's `sms` flag is the switch
--   that the channel is offered at all (kept, now on in every sold plan); a business that never loaded a balance, or whose
--   balance was cleared, sends no SMS. Without room a job waits uncounted (cap_wait 'sms_balance') and is cancelled after 24
--   hours of waiting ('sms_balance_expired'): a marketing SMS needs the balance to hold its segments, a service SMS
--   (app.service_message_types) may take it down to minus 50 (app.sms_service_overdraft), which the next pack covers. Owner
--   (446) א: a service SMS that would pass minus 50 waits and is cancelled after 24 hours the same way.
-- * Give-back: a composer refusal, the adapter's notSent (public.sms_quota_return) and a failed delivery report (trigger
--   messages_sms_failed_refund on public.messages, which also covers public.sms_delivery_status without changing its pinned
--   body) give the job's segments back (app.sms_balance_refund, idempotent per job). 'delivered' and 'unknown' stay charged.
-- * (438) א, (449) א: the sender-number verification code is never charged (a 'verification' movement records its segments with
--   a delta of 0, once per job; a business with no balance row gets one at 0, unloaded); at most 3 such checks (= codes) a business day
--   (public.sms_sender_verify_start answers reason 'daily').
-- * (439) א: the balance is cleared (a final 'clear' movement to 0, the channel off) when the business becomes cancelled or is
--   marked deleted (trigger organizations_sms_balance_clear); when ADM-03's purge completes, the rows go with the business by
--   cascade (no delete statement here). Suspended and read-only keep it; nothing is sent then (the send check refuses a
--   business that cannot write, as before).
-- * Notices (`system`, to the business's active owners): once when the balance falls to 20% of the last pack loaded (lead's
--   choice: of the last pack's size, 60 / 200 / 1,000), once when it reaches 0; both re-armed by the next load.
-- * (437) א: max_sms_per_month is 0 in every plan and no longer read; the plan flag `sms` is on in the four sold plans (the
--   packs are offered in every plan). app.sms_quota_months and app.sms_quota_notices keep their history; nothing new is
--   counted there (the give-back still returns a job counted before this migration to its month). Owner (445) ב: the hidden
--   free plan holds the flag too. Owner (446) א, (447) א: a marketing SMS never takes the balance below 0, a service SMS
--   never below -50 (beyond it waits, cancelled after 24 hours); only the sender-number code always goes out and is recorded as a
--   'verification' movement with its segments and a delta of 0 (owner (449) א).
-- * Reads: public.sms_balance_summary (owners/admins; the balance, the last 20 movements without ids, the packs) and
--   public.platform_sms_balance (platform staff).
-- No row is deleted. No statement starts with drop. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Tables (schema app, RLS on, no grants)
-- ----------------------------------------------------------------------------
create table if not exists app.sms_balances (
  organization_id    uuid primary key references public.organizations (id) on delete cascade,
  balance            integer not null default 0 check (balance >= -50),
  loaded_at          timestamptz,
  last_load_segments integer check (last_load_segments is null or last_load_segments > 0),
  last_movement_id   uuid,
  low_notified_at    timestamptz,
  zero_notified_at   timestamptz,
  cleared_at         timestamptz,
  updated_at         timestamptz not null default now()
);
alter table app.sms_balances enable row level security;
revoke all on app.sms_balances from public, anon, authenticated, service_role;

create table if not exists app.sms_balance_movements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null check (kind in ('grant', 'purchase', 'charge', 'refund', 'clear', 'verification')),
  -- the change to the balance (0 for a verification code)
  segments        integer not null,
  -- the segments of the message itself (a charge's, and a verification code's, which is recorded but never deducted)
  message_segments integer check (message_segments is null or message_segments > 0),
  balance_after   integer not null,
  job_id          uuid,
  pack            integer check (pack is null or pack in (300, 1000, 5000)),
  actor_id        uuid,
  note            text check (note is null or char_length(note) between 1 and 200),
  -- the order movements were written in: taken under the balance row's lock (app.sms_balance_move), so it is the order of
  -- the balance's changes, unlike a timestamp of the writing transaction (review 3)
  seq             bigint generated always as identity,
  created_at      timestamptz not null default clock_timestamp(),
  constraint sms_balance_movements_shape check (
    (kind in ('grant', 'purchase') and pack is not null and segments = pack and job_id is null)
    or (kind = 'charge' and segments < 0 and job_id is not null and pack is null)
    or (kind = 'refund' and segments > 0 and job_id is not null and pack is null)
    or (kind = 'clear' and balance_after = 0 and job_id is null and pack is null)
    -- owner (449) א: the sender-number code is recorded with its segments, never deducted (delta 0)
    or (kind = 'verification' and segments = 0 and message_segments is not null and job_id is not null and pack is null))
);
create index if not exists sms_balance_movements_org_idx on app.sms_balance_movements (organization_id, created_at desc);
create index if not exists sms_balance_movements_job_idx on app.sms_balance_movements (job_id) where job_id is not null;
alter table app.sms_balance_movements enable row level security;
revoke all on app.sms_balance_movements from public, anon, authenticated, service_role;

-- the queue's server-only columns (app.jobs holds ids, codes and numbers only)
--   sms_metered: the send check passed this SMS under the balance (the composer charges only such a job; a job counted under
--     the old monthly quota is not charged, and its give-back returns it to its month)
--   sms_segments: the segments the composer counted on the job's last compose (the send check's need on a later try)
--   sms_balance_wait_since: when the job first waited for the balance (cancelled 24 hours later)
alter table app.jobs add column if not exists sms_metered boolean not null default false;
alter table app.jobs add column if not exists sms_segments integer;
alter table app.jobs add column if not exists sms_balance_wait_since timestamptz;

-- an SMS waiting for the balance is a cap waiter (the owners' "cancel the waiting" takes it)
alter table app.jobs drop constraint if exists jobs_cap_wait_known;
alter table app.jobs add constraint jobs_cap_wait_known
  check (cap_wait is null or cap_wait in ('over_cap', 'day_quota', 'sms_off', 'sms_balance')) not valid;
alter table app.jobs validate constraint jobs_cap_wait_known;

-- ----------------------------------------------------------------------------
-- Fixed values
-- ----------------------------------------------------------------------------
-- the packs (segments, price in agorot before VAT) = SMS_PACKS in src/features/sms-balance/packs.ts
create or replace function app.sms_packs() returns jsonb
language sql immutable
set search_path = ''
as $$
  select '[{"segments": 300, "price_agorot": 3500}, {"segments": 1000, "price_agorot": 9900}, {"segments": 5000, "price_agorot": 39000}]'::jsonb
$$;
revoke all on function app.sms_packs() from public, anon, authenticated, service_role;

-- how far below 0 a service SMS may take the balance (owner, 18 November 2026) = SMS_SERVICE_OVERDRAFT
create or replace function app.sms_service_overdraft() returns integer
language sql immutable
set search_path = ''
as $$ select 50 $$;
revoke all on function app.sms_service_overdraft() from public, anon, authenticated, service_role;

-- the sender-number checks (= codes) a business may start in one business day (owner (438) א)
create or replace function app.sms_sender_daily_max() returns integer
language sql immutable
set search_path = ''
as $$ select 3 $$;
revoke all on function app.sms_sender_daily_max() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Segments of a text = smsSegments() (src/features/messaging/sms-segments.ts; shared fixture sms-segments.json)
-- ----------------------------------------------------------------------------
create or replace function app.sms_segments(p_text text) returns integer
language plpgsql immutable
set search_path = ''
as $$
declare
  -- GSM 03.38 basic set (without the escape) and its extension table (each extension character is 2 septets)
  v_basic constant text := '@£$¥èéùìòÇ' || chr(10) || 'Øø' || chr(13) || 'ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?'
                           || '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_ext constant text := chr(12) || '^{}\[~]|€';
  v_char text;
  v_septets integer := 0;
  v_units integer := 0;
  v_gsm boolean := true;
begin
  if p_text is null or p_text = '' then
    return 0;
  end if;
  foreach v_char in array regexp_split_to_array(p_text, '') loop
    v_units := v_units + case when ascii(v_char) > 65535 then 2 else 1 end;
    if v_gsm then
      if strpos(v_basic, v_char) > 0 then
        v_septets := v_septets + 1;
      elsif strpos(v_ext, v_char) > 0 then
        v_septets := v_septets + 2;
      else
        v_gsm := false;
      end if;
    end if;
  end loop;
  if v_gsm then
    return case when v_septets <= 160 then 1 else ceil(v_septets / 153.0)::integer end;
  end if;
  return case when v_units <= 70 then 1 else ceil(v_units / 67.0)::integer end;
end;
$$;
revoke all on function app.sms_segments(text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The balance changes only with a movement
-- ----------------------------------------------------------------------------
create or replace function app.sms_balances_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.balance <> 0 or new.last_movement_id is not null then
      raise exception 'an SMS balance starts at 0' using errcode = 'P0001', hint = 'sms_balance:movement';
    end if;
    return new;
  end if;
  if new.organization_id <> old.organization_id then
    raise exception 'the business of an SMS balance never changes' using errcode = 'P0001', hint = 'sms_balance:movement';
  end if;
  if new.balance is distinct from old.balance
     and (new.last_movement_id is not distinct from old.last_movement_id
          or not exists (select 1 from app.sms_balance_movements m
                          where m.id = new.last_movement_id and m.organization_id = new.organization_id
                            and m.balance_after = new.balance and m.segments = new.balance - old.balance)) then
    raise exception 'an SMS balance changes only with its movement' using errcode = 'P0001', hint = 'sms_balance:movement';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function app.sms_balances_guard() from public, anon, authenticated, service_role;
create or replace trigger sms_balances_guard
  before insert or update on app.sms_balances
  for each row execute function app.sms_balances_guard();

create or replace function app.sms_balance_movements_frozen() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'an SMS balance movement is never changed' using errcode = 'P0001', hint = 'sms_balance:movement';
end;
$$;
revoke all on function app.sms_balance_movements_frozen() from public, anon, authenticated, service_role;
create or replace trigger sms_balance_movements_frozen
  before update on app.sms_balance_movements
  for each row execute function app.sms_balance_movements_frozen();

-- One `system` notice to the business's active owners (counts only). Never raises.
create or replace function app.sms_balance_notice(p_org uuid, p_kind text, p_balance integer) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_title text;
  v_body text;
  v_count integer := 0;
begin
  if p_kind = 'low' then
    v_title := 'יתרת ה-SMS נמוכה';
    v_body := 'נשארו ' || p_balance || ' מקטעי SMS ביתרה של העסק. כדי שההודעות ימשיכו לצאת, אפשר להוסיף חבילה ב"הגדרות > חבילה ושימוש".';
  elsif p_kind = 'zero' then
    v_title := 'יתרת ה-SMS נגמרה';
    v_body := 'יתרת ה-SMS של העסק הגיעה ל-0. הודעות שיווק ב-SMS מחכות עד 24 שעות ואז מתבטלות. הודעות שירות, כמו תזכורת לפגישה, '
              || 'ממשיכות לצאת עד 50 מקטעים, שיקוזזו מהחבילה הבאה. אפשר להוסיף חבילה ב"הגדרות > חבילה ושימוש".';
  else
    return 0;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', v_title, v_body
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role = 'owner';
  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  raise warning 'sms_balance_notice: % (business %)', sqlstate, p_org;
  return 0;
end;
$$;
revoke all on function app.sms_balance_notice(uuid, text, integer) from public, anon, authenticated, service_role;

-- THE one writer of a balance: the movement row and the new balance together, under the balance row's lock; the notices of a
-- charge that crosses 20% of the last pack, or 0, once each until the next load. Answers the balance after it.
create or replace function app.sms_balance_move(p_org uuid, p_kind text, p_segments integer, p_job uuid, p_pack integer,
                                                p_actor uuid, p_note text, p_message_segments integer default null) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row app.sms_balances;
  v_new integer;
  v_movement uuid;
  v_load boolean := p_kind in ('grant', 'purchase');
  v_threshold integer;
begin
  insert into app.sms_balances (organization_id) values (p_org) on conflict (organization_id) do nothing;
  select * into v_row from app.sms_balances b where b.organization_id = p_org for update;
  v_new := v_row.balance + p_segments;
  insert into app.sms_balance_movements (organization_id, kind, segments, balance_after, job_id, pack, actor_id, note, message_segments)
  values (p_org, p_kind, p_segments, v_new, p_job, p_pack, p_actor, p_note, p_message_segments)
  returning id into v_movement;
  update app.sms_balances b
     set balance = v_new,
         last_movement_id = v_movement,
         loaded_at = case when v_load then coalesce(b.loaded_at, now()) when p_kind = 'clear' then null else b.loaded_at end,
         last_load_segments = case when v_load then p_pack when p_kind = 'clear' then null else b.last_load_segments end,
         low_notified_at = case when v_load or p_kind = 'clear' then null else b.low_notified_at end,
         zero_notified_at = case when v_load or p_kind = 'clear' then null else b.zero_notified_at end,
         cleared_at = case when p_kind = 'clear' then now() when v_load then null else b.cleared_at end
   where b.organization_id = p_org;
  if p_kind = 'charge' and v_row.loaded_at is not null then
    v_threshold := coalesce(v_row.last_load_segments, 0) / 5;
    if v_new <= 0 and v_row.balance > 0 and v_row.zero_notified_at is null then
      perform app.sms_balance_notice(p_org, 'zero', v_new);
      update app.sms_balances b set zero_notified_at = now(), low_notified_at = coalesce(b.low_notified_at, now())
       where b.organization_id = p_org;
    elsif v_new > 0 and v_new <= v_threshold and v_row.balance > v_threshold and v_row.low_notified_at is null then
      perform app.sms_balance_notice(p_org, 'low', v_new);
      update app.sms_balances b set low_notified_at = now() where b.organization_id = p_org;
    end if;
  end if;
  return v_new;
end;
$$;
revoke all on function app.sms_balance_move(uuid, text, integer, uuid, integer, uuid, text, integer) from public, anon, authenticated, service_role;

-- The composer's charge of a job's final text: null = charged (or nothing to charge), else 'sms_balance' (no room now).
-- Never a sender-number code, never a job the send check did not pass under the balance, never twice for one job.
create or replace function app.sms_balance_charge(p_job uuid, p_text text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_segments integer;
  v_marketing boolean;
  v_floor integer;
  v_row app.sms_balances;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or (v_job.payload ->> 'channel') is distinct from 'sms' then
    return null;
  end if;
  v_segments := greatest(app.sms_segments(p_text), 1);
  -- owner (438) א and (449) א: the sender-number code is never charged and never refused for the balance (even below -50, or
  -- with no balance at all: the row is made at 0, unloaded, so the channel stays off); it is recorded once per job as a
  -- 'verification' movement with its segments and a delta of 0
  if v_job.payload ? 'sender_check_id' then
    if not exists (select 1 from app.sms_balance_movements m
                    where m.job_id = p_job and m.organization_id = v_job.organization_id and m.kind = 'verification') then
      perform app.sms_balance_move(v_job.organization_id, 'verification', 0, p_job, null, null, null, v_segments);
    end if;
    return null;
  end if;
  if not v_job.sms_metered then
    return null;
  end if;
  update app.jobs j set sms_segments = v_segments where j.id = p_job;
  insert into app.sms_balances (organization_id) values (v_job.organization_id) on conflict (organization_id) do nothing;
  select * into v_row from app.sms_balances b where b.organization_id = v_job.organization_id for update;
  -- a later try of a job already charged (a provider throttle): not charged again
  if coalesce((select sum(m.segments) from app.sms_balance_movements m
                where m.job_id = p_job and m.organization_id = v_job.organization_id and m.kind in ('charge', 'refund')), 0) < 0 then
    return null;
  end if;
  v_marketing := not coalesce((v_job.payload ->> 'message_type') = any (app.service_message_types()), false);
  v_floor := case when v_marketing then 0 else -app.sms_service_overdraft() end;
  if v_row.loaded_at is null or v_row.balance - v_segments < v_floor then
    return 'sms_balance';
  end if;
  perform app.sms_balance_move(v_job.organization_id, 'charge', -v_segments, p_job, null, null, null, v_segments);
  return null;
end;
$$;
revoke all on function app.sms_balance_charge(uuid, text) from public, anon, authenticated, service_role;

-- A job's charge given back (a refusal after the charge, notSent, a failed delivery report): true when something was given
-- back. Idempotent: only while the job's charges exceed its give-backs, and never into a balance cleared after the charge.
create or replace function app.sms_balance_refund(p_job uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_net integer;
  v_charged_seq bigint;
begin
  select m.organization_id into v_org from app.sms_balance_movements m where m.job_id = p_job and m.kind = 'charge' limit 1;
  if v_org is null then
    return false;
  end if;
  perform 1 from app.sms_balances b where b.organization_id = v_org for update;
  select coalesce(sum(m.segments), 0), max(m.seq) filter (where m.kind = 'charge') into v_net, v_charged_seq
    from app.sms_balance_movements m
   where m.job_id = p_job and m.organization_id = v_org and m.kind in ('charge', 'refund');
  if v_net >= 0 then
    return false;
  end if;
  -- review (3): judged by the write order under the balance lock (seq), never by the transactions' start times
  if exists (select 1 from app.sms_balance_movements m
              where m.organization_id = v_org and m.kind = 'clear' and m.seq > v_charged_seq) then
    return false;
  end if;
  perform app.sms_balance_move(v_org, 'refund', -v_net, p_job, null, null, null);
  return true;
end;
$$;
revoke all on function app.sms_balance_refund(uuid) from public, anon, authenticated, service_role;

-- (439) א: a business that becomes cancelled or is marked deleted loses its balance: one 'clear' movement to 0, the channel off
create or replace function app.sms_balance_clear(p_org uuid, p_reason text) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row app.sms_balances;
begin
  select * into v_row from app.sms_balances b where b.organization_id = p_org for update;
  if v_row.organization_id is null or (v_row.balance = 0 and v_row.loaded_at is null) then
    return false;
  end if;
  perform app.sms_balance_move(p_org, 'clear', -v_row.balance, null, null, null, p_reason);
  return true;
end;
$$;
revoke all on function app.sms_balance_clear(uuid, text) from public, anon, authenticated, service_role;

create or replace function app.organizations_sms_balance_clear() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform app.sms_balance_clear(new.id, 'העסק נמחק');
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform app.sms_balance_clear(new.id, 'המנוי בוטל');
  end if;
  return null;
end;
$$;
revoke all on function app.organizations_sms_balance_clear() from public, anon, authenticated, service_role;
create or replace trigger organizations_sms_balance_clear
  after update of status, deleted_at on public.organizations
  for each row execute function app.organizations_sms_balance_clear();

-- a failed delivery (the provider's report, or a job that ended failed at the provider) gives the job's segments back;
-- 'delivered', 'sent' and 'unknown' stay charged. Never fails the write.
create or replace function app.messages_sms_failed_refund() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.channel = 'sms' and new.direction = 'outbound' and new.status = 'failed' and new.job_id is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'failed')
     and coalesce(new.provider_error_code, '') not like 'unknown\_%' then
    begin
      perform app.sms_balance_refund(new.job_id);
    exception when others then
      raise warning 'messages_sms_failed_refund: job % (%)', new.job_id, sqlstate;
    end;
  end if;
  return null;
end;
$$;
revoke all on function app.messages_sms_failed_refund() from public, anon, authenticated, service_role;
create or replace trigger messages_sms_failed_refund
  after insert or update of status on public.messages
  for each row execute function app.messages_sms_failed_refund();

-- whether the business's SMS channel is open: 'off_plan' (no `sms` flag), 'no_balance' (never loaded, or cleared) or 'open';
-- null for a caller who is not a member. For public.record_sms_send (invoker) and the settings screens.
create or replace function app.sms_channel_state(p_org uuid) returns text
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_org is null or (auth.uid() is not null and not coalesce(app.is_member(p_org), false)) then
    return null;
  end if;
  if not coalesce(app.org_has_feature(p_org, 'sms'), false) then
    return 'off_plan';
  end if;
  if not exists (select 1 from app.sms_balances b where b.organization_id = p_org and b.loaded_at is not null) then
    return 'no_balance';
  end if;
  return 'open';
end;
$$;
revoke all on function app.sms_channel_state(uuid) from public, anon, authenticated, service_role;
grant execute on function app.sms_channel_state(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Reads
-- ----------------------------------------------------------------------------
-- the balance as one business's owners and admins see it (counts only; no job, actor or movement id)
create or replace function app.sms_balance_view(p_org uuid, p_limit integer) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'balance', coalesce(b.balance, 0),
    'loaded', coalesce(b.loaded_at is not null, false),
    'loaded_at', b.loaded_at,
    'last_load', b.last_load_segments,
    'low_at', case when b.last_load_segments is null then null else b.last_load_segments / 5 end,
    'overdraft', app.sms_service_overdraft(),
    'cleared_at', b.cleared_at,
    'packs', app.sms_packs(),
    'movements', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'segments', x.segments,
                                                               'message_segments', x.message_segments,
                                                               'balance_after', x.balance_after, 'pack', x.pack,
                                                               'at', x.created_at) order by x.seq desc)
                             from (select m.* from app.sms_balance_movements m
                                    where m.organization_id = p_org
                                    order by m.seq desc limit greatest(least(p_limit, 100), 1)) x), '[]'::jsonb))
    from (select p_org as id) o
    left join app.sms_balances b on b.organization_id = o.id
$$;
revoke all on function app.sms_balance_view(uuid, integer) from public, anon, authenticated, service_role;

create or replace function public.sms_balance_summary(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) then
    return jsonb_build_object('allowed', false);
  end if;
  return jsonb_build_object('allowed', true, 'channel', app.sms_channel_state(p_org)) || app.sms_balance_view(p_org, 20);
end;
$$;
revoke all on function public.sms_balance_summary(uuid) from public, anon;
grant execute on function public.sms_balance_summary(uuid) to authenticated;

create or replace function public.platform_sms_balance(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return app.sms_balance_view(p_org, 10);
end;
$$;
revoke all on function public.platform_sms_balance(uuid) from public, anon;
grant execute on function public.platform_sms_balance(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The platform owner loads a pack by hand until a clearing provider exists (logged)
-- ----------------------------------------------------------------------------
create or replace function public.platform_sms_grant(p_org uuid, p_pack integer, p_note text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status text;
  v_balance integer;
begin
  perform app.require_platform(array['owner']);
  if p_pack is null or p_pack not in (300, 1000, 5000) then
    raise exception 'a pack of 300, 1000 or 5000 segments' using errcode = '22023', hint = 'sms_grant:pack';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'the note is up to 200 characters' using errcode = '22023';
  end if;
  select o.status into v_status from public.organizations o where o.id = p_org and o.deleted_at is null for share;
  if v_status is null then
    raise exception 'business not found' using errcode = 'P0002';
  end if;
  if v_status = 'cancelled' then
    raise exception 'the business is cancelled' using errcode = 'P0001', hint = 'sms_grant:cancelled';
  end if;
  v_balance := app.sms_balance_move(p_org, 'grant', p_pack, null, p_pack, auth.uid(), v_note);
  perform app.log_platform('sms.grant', p_org, jsonb_build_object('pack', p_pack, 'balance_after', v_balance));
  return jsonb_build_object('ok', true, 'balance', v_balance);
end;
$$;
revoke all on function public.platform_sms_grant(uuid, integer, text) from public, anon;
grant execute on function public.platform_sms_grant(uuid, integer, text) to authenticated;

-- ----------------------------------------------------------------------------
-- (437) א: the monthly SMS quota is 0 in every plan and no longer read; the flag `sms` is on in every sold plan
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": { "max_sms_per_month": 0 }, "features": { "sms": true } },
  "basic": { "limits": { "max_sms_per_month": 0 }, "features": { "sms": true } },
  "pro": { "limits": { "max_sms_per_month": 0 }, "features": { "sms": true } },
  "business": { "limits": { "max_sms_per_month": 0 }, "features": { "sms": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- owner (445) ב: the hidden free plan may buy packs too: the flag on there as well, no monthly SMS
update public.plans p
   set limits = coalesce(p.limits, '{}'::jsonb) || '{"max_sms_per_month": 0}'::jsonb,
       features = coalesce(p.features, '{}'::jsonb) || '{"sms": true}'::jsonb
 where p.key = 'free'
   and (p.limits, p.features) is distinct from (coalesce(p.limits, '{}'::jsonb) || '{"max_sms_per_month": 0}'::jsonb,
                                               coalesce(p.features, '{}'::jsonb) || '{"sms": true}'::jsonb);

-- a room for an SMS the jobs choose a channel by (COL-07 collection reminders, RET-02 review requests): the flag and a
-- loaded balance above 0 (021226 read the monthly quota)
create or replace function app.collection_sms_room(p_org uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not coalesce(app.org_has_feature(p_org, 'sms'), false) then
    return false;
  end if;
  return exists (select 1 from app.sms_balances b
                  where b.organization_id = p_org and b.loaded_at is not null and b.balance > 0);
end;
$$;
revoke all on function app.collection_sms_room(uuid) from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- The send check
-- ----------------------------------------------------------------------------
-- public.job_message_may_send: 021300's body; SMS-06 replaces only the SMS lines (the monthly quota) by the prepaid balance
create or replace function public.job_message_may_send(p_job uuid, p_lease uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs%rowtype;
  v_channel text;
  v_type text;
  v_record uuid;
  v_found boolean := false;
  v_email text;
  v_phone text;
  v_address text;
  v_suppressed boolean;
  v_blocked boolean;
  v_reason text;
  v_event_at timestamptz;
  v_paused_at timestamptz;
  v_pause public.org_sending_pauses%rowtype;
  v_open timestamptz;
  v_minute timestamptz;
  v_rate app.message_send_rate%rowtype;
  v_zone text;
  v_today date;
  v_marketing boolean;
  v_used_month integer;
  v_used_day integer;
  v_cap integer;
  v_cap_business integer;
  v_cap_plan integer;
  v_cap_day integer;
  v_wait timestamptz;
  v_hold app.message_cap_holds%rowtype;
  v_held boolean := false;
  -- SMS (owner (210) ב, scope (א2)): the plan's flag and month quota over every SMS to a customer
  v_sms_cap integer;
  v_sms_used integer;
  v_sms_counted boolean := false;
  -- SMS-06: the prepaid balance
  v_balance app.sms_balances;
  v_need integer;
  v_room boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.kind <> 'message.send' or v_job.status <> 'running'
     or p_lease is null or v_job.lease_id is distinct from p_lease or not (v_job.locked_until > now()) then
    return jsonb_build_object('may_send', false, 'reason', 'stale');
  end if;

  v_channel := v_job.payload ->> 'channel';
  v_type := v_job.payload ->> 'message_type';
  if v_job.payload ? 'sender_check_id' then
    -- SMS-01b (owner (211) א): a sender-number check's code goes to the business's own phone the check holds, while the
    -- check is open (not verified, not expired, not dead)
    select true, null, k.phone into v_found, v_email, v_phone
      from app.sms_sender_checks k
     where k.organization_id = v_job.organization_id and k.id = (v_job.payload ->> 'sender_check_id')::uuid
       and k.verified_at is null and k.attempts < app.sms_sender_max_attempts() and k.created_at > now() - interval '1 hour';
  elsif v_job.payload ? 'lead_id' then
    v_record := (v_job.payload ->> 'lead_id')::uuid;
    select true, l.email, l.phone into v_found, v_email, v_phone
      from public.leads l
     where l.organization_id = v_job.organization_id and l.id = v_record and l.deleted_at is null;
  else
    v_record := (v_job.payload ->> 'contact_id')::uuid;
    select true, c.email, c.phone into v_found, v_email, v_phone
      from public.contacts c
     where c.organization_id = v_job.organization_id and c.id = v_record and c.deleted_at is null;
  end if;

  if v_job.payload ? 'event_at' then
    begin
      v_event_at := (v_job.payload ->> 'event_at')::timestamptz;
    exception when others then
      v_event_at := '-infinity';
    end;
  end if;

  -- RVW-105, owner (399) א: during ADM-03's 30-day deletion wait (and only then: deleted, suspended, cancelled and read-only
  -- are refused as before) the business is not writable, yet the message waits like HEB-09's pause instead of being refused
  if not app.org_writable(v_job.organization_id) and not app.org_deletion_waiting(v_job.organization_id) then
    v_reason := 'business_closed';
  elsif v_event_at is not null and v_event_at < now() then
    v_reason := 'event_passed';
  elsif app.org_deletion_waiting(v_job.organization_id) then
    -- uncounted, checked again in 15 minutes (sooner when the deletion is cancelled: trigger org_deletions_release_jobs);
    -- if the business is purged at the end of the 30 days the job goes with it (app.jobs cascades with the business)
    update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                          next_run_at = now() + interval '15 minutes', last_error = 'waiting:org_deletion'
     where j.id = p_job;
    return jsonb_build_object('may_send', false, 'reason', 'org_deletion', 'retry', true);
  -- SMS-01b review (6): a sender check's code goes to the business's own phone, not a customer: HEB-09's pause does not hold it
  elsif not (v_job.payload ? 'sender_check_id') and app.customer_sending_paused(v_job.organization_id) then
    select p.paused_at into v_paused_at from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if coalesce(v_paused_at, now()) < now() - interval '24 hours' then
      v_reason := 'pause_expired';
    else
      -- (52) ג: wait for the business to resume; not refused, the attempt not counted
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = now() + interval '5 minutes', last_error = 'waiting:sending_paused'
       where j.id = p_job;
      -- the business's other message jobs already due wait with it, in one update (no attempt is counted: they were
      -- not claimed), so a paused business does not churn the queue one job at a time. Only jobs already due: a job
      -- due later is marked when its own time comes, so one due after the resume never carries the mark (review)
      -- (review 5) in id order, through the one batch move
      perform app.message_move_waiting(v_job.organization_id, p_job, now() + interval '5 minutes', 'sending_paused', null, 'pause');
      return jsonb_build_object('may_send', false, 'reason', 'sending_paused', 'retry', true);
    end if;
  end if;

  -- (52) ג after the resume: the business's latest pause lasted more than 24 hours and this job waited through it
  -- (it was told to wait, or it was made before the resume and due by its end) = cancelled, even when no check
  -- happened during the pause (worker down, hourly wake). A job made during the pause for a time after the resume
  -- never waited and is sent (review M-1). Only the latest pause is known: a re-pause before an older long pause's
  -- backlog drained forgets it (review L-a, accepted)
  if v_reason is null and not (v_job.payload ? 'sender_check_id') then
    select * into v_pause from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if found and not v_pause.paused and v_pause.paused_at is not null and v_pause.resumed_at is not null
       and v_pause.resumed_at - v_pause.paused_at > interval '24 hours'
       and (v_job.last_error = 'waiting:sending_paused'
            or (v_job.created_at <= v_pause.resumed_at and v_job.next_run_at <= v_pause.resumed_at)) then
      v_reason := 'pause_expired';
    end if;
  end if;

  if v_reason is not null then
    null;
  elsif not coalesce(v_found, false) then
    v_reason := 'record_gone';
  else
    v_address := nullif(btrim(case when v_channel = 'email' then v_email else v_phone end), '');
    if v_address is null then
      v_reason := 'no_address';
    else
      if v_type = any (app.service_message_types()) then
        -- CNS-07, owner (73) א: a service message goes after an ordinary opt-out from marketing, never to an address on
        -- the blocklist or blocked by a privacy erasure (the address, business-wide; cannot check = refused)
        v_blocked := app.consent_service_blocked(v_job.organization_id, v_channel, v_address);
        if v_blocked is null then
          v_reason := 'consent_unknown';
        elsif v_blocked then
          v_reason := 'consent_blocked';
        end if;
      else
        -- marketing (every type not in the service list, or none): no opt-out, and a recorded grant for the channel
        v_suppressed := app.consent_suppressed(v_job.organization_id, v_channel, v_address);
        if v_suppressed is null then
          v_reason := 'consent_unknown';
        elsif v_suppressed then
          v_reason := 'consent_suppressed';
        elsif app.consent_granted(v_job.organization_id, v_channel, v_address) is not true then
          v_reason := 'consent_missing';
        end if;
      end if;
    end if;
  end if;

  if v_reason is null then
    -- MSG-06 (119)-(120): outside the business's sending hours the message waits for the window, uncounted; a verification
    -- code always goes, and a meeting reminder goes when its meeting starts before the window opens
    -- SPD-04 (120) ג: the window exemption is app.message_window_exempt (verification_code, instant_reply); the rates below
    -- keep app.message_always_sends (verification_code only, (136) ב)
    if not app.message_window_exempt(v_type) then
      v_open := app.message_window_open_at(v_job.organization_id, now());
      if v_open > now() and not (v_type = 'meeting_reminder' and v_event_at is not null and v_event_at < v_open) then
        update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                              next_run_at = v_open, last_error = 'waiting:sending_hours'
         where j.id = p_job;
        -- the business's other due message jobs that would wait too (app.message_move_waiting 'hours': never a pause-marked
        -- one or one still covered by the latest long pause, never one that always goes, a meeting reminder or a cap waiter)
        perform app.message_move_waiting(v_job.organization_id, p_job, v_open, 'sending_hours', null, 'hours');
        return jsonb_build_object('may_send', false, 'reason', 'sending_hours', 'retry', true);
      end if;
    end if;

    -- MSG-06 (121) א: at most app.message_rate_per_minute(channel) a minute per business and channel; the row is the
    -- business's lock for the channel, so two workers never pass the limit together
    v_minute := date_trunc('minute', now());
    insert into app.message_send_rate (organization_id, channel, minute_start, sent)
    values (v_job.organization_id, v_channel, v_minute, 0)
    on conflict (organization_id, channel) do nothing;
    select * into v_rate from app.message_send_rate r
     where r.organization_id = v_job.organization_id and r.channel = v_channel for update;

    -- MSG-05 (122) ג, (123) ב, (125) ב: a marketing message over the month's cap (the business's, or the plan's email quota)
    -- or over the plan's daily email quota waits, uncounted; a service message is never held by them. A job counted on an
    -- earlier attempt (the provider failed, it is tried again) already holds its place
    v_marketing := not coalesce(v_type = any (app.service_message_types()), false);
    select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_job.organization_id;
    v_zone := coalesce(v_zone, 'Asia/Jerusalem');
    v_today := (now() at time zone v_zone)::date;
    if v_marketing then
      v_cap_business := app.message_business_cap(v_job.organization_id, v_channel);
      v_cap_plan := app.message_plan_cap(v_job.organization_id, v_channel, 'month');
      v_cap_day := app.message_plan_cap(v_job.organization_id, v_channel, 'day');
      v_cap := least(v_cap_business, v_cap_plan);
      select coalesce(sum(u.marketing), 0)::integer,
             coalesce(sum(u.marketing) filter (where u.day = v_today), 0)::integer
        into v_used_month, v_used_day
        from app.message_usage_days u
       where u.organization_id = v_job.organization_id and u.channel = v_channel
         and u.day >= date_trunc('month', v_today)::date and u.day <= v_today;
    end if;
    -- (135) ב: a full month's cap holds the business's channel until the cap is raised, also across a new month; the hold
    -- keeps the cap it filled at and is lifted only by a higher cap (or none)
    if v_marketing and not v_job.usage_counted then
      select * into v_hold from app.message_cap_holds h
       where h.organization_id = v_job.organization_id and h.channel = v_channel;
      v_held := found and v_hold.cleared_at is null;
      if v_held and (v_cap is null or v_cap > v_hold.held_cap) then
        update app.message_cap_holds h set cleared_at = now()
         where h.organization_id = v_job.organization_id and h.channel = v_channel;
        v_held := false;
      end if;
      if not v_held and v_cap is not null and v_used_month >= v_cap then
        insert into app.message_cap_holds (organization_id, channel, held_cap, held_at, cleared_at)
        values (v_job.organization_id, v_channel, v_cap, now(), null)
        on conflict (organization_id, channel) do update
          set held_cap = excluded.held_cap, held_at = excluded.held_at, cleared_at = null;
        v_held := true;
      end if;
    end if;
    if v_marketing and not v_job.usage_counted and (v_held or (v_cap_day is not null and v_used_day >= v_cap_day)) then
      if v_held then
        -- the cap is full: checked again every 15 minutes, so a raised cap lets it go (a new month does not)
        v_wait := now() + interval '15 minutes';
        v_reason := 'over_cap';
        perform app.message_cap_notify(v_job.organization_id, v_channel, 'full', v_used_month, v_cap,
                                       v_cap_plan is not null and v_cap_plan = v_cap, v_today);
      else
        -- the plan's daily email quota: the next day in the business's zone
        v_wait := greatest((v_today + 1)::timestamp at time zone v_zone, now() + interval '1 minute');
        v_reason := 'day_quota';
        perform app.message_cap_notify(v_job.organization_id, v_channel, 'day', v_used_day, v_cap_day, true, v_today);
      end if;
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = v_wait, last_error = 'waiting:' || v_reason, cap_wait = v_reason
       where j.id = p_job;
      -- the channel's other due marketing messages wait with it (app.message_move_waiting 'cap': never a pause-marked one,
      -- one still covered by the latest long pause, a service type or one already counted)
      perform app.message_move_waiting(v_job.organization_id, p_job, v_wait, v_reason, v_channel, 'cap');
      return jsonb_build_object('may_send', false, 'reason', v_reason, 'retry', true);
    end if;
    -- SMS-06 (owner 18 November 2026, answers (437) א, (438) א): an SMS is paid from the business's prepaid balance of segments
    -- (app.sms_balances), never from a monthly plan quota any more. Every SMS to a customer (never the sender-number code)
    -- needs the plan's `sms` flag (the channel offered at all) and a balance loaded once and not cleared (else the channel is
    -- off). A marketing SMS goes only while the balance holds its segments; a service SMS (app.service_message_types) down to
    -- minus app.sms_service_overdraft() (50), which the next pack covers. The segments are the ones the composer counted on an
    -- earlier try (app.jobs.sms_segments), else 1: the composer charges the real count of the final text. Without room the job
    -- waits uncounted (15 minutes, cap_wait 'sms_balance', so the owners' cancel takes it too), and a job that has waited for
    -- the balance more than 24 hours is cancelled ('sms_balance_expired'). Read under the channel's rate row lock taken above.
    if v_channel = 'sms' and v_type is distinct from 'verification_code' and not v_job.usage_counted then
      if not coalesce(app.org_has_feature(v_job.organization_id, 'sms'), false) then
        update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                              next_run_at = now() + interval '1 hour', last_error = 'waiting:sms_off', cap_wait = 'sms_off'
         where j.id = p_job;
        return jsonb_build_object('may_send', false, 'reason', 'sms_off', 'retry', true);
      end if;
      v_need := greatest(coalesce(v_job.sms_segments, 1), 1);
      select * into v_balance from app.sms_balances b where b.organization_id = v_job.organization_id;
      v_room := v_balance.organization_id is not null and v_balance.loaded_at is not null
                and v_balance.balance - v_need >= case when v_marketing then 0 else -app.sms_service_overdraft() end;
      if not v_room then
        if v_job.sms_balance_wait_since is not null and v_job.sms_balance_wait_since < now() - interval '24 hours' then
          update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                                last_error = 'refused:sms_balance_expired'
           where j.id = p_job;
          insert into app.job_cancel_counts (organization_id, reason, pending)
          values (v_job.organization_id, 'sms_balance_expired', 1)
          on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + 1;
          return jsonb_build_object('may_send', false, 'reason', 'sms_balance_expired');
        end if;
        update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                              next_run_at = now() + interval '15 minutes', last_error = 'waiting:sms_balance',
                              cap_wait = 'sms_balance', sms_balance_wait_since = coalesce(j.sms_balance_wait_since, now())
         where j.id = p_job;
        return jsonb_build_object('may_send', false, 'reason', 'sms_balance', 'retry', true);
      end if;
      v_sms_counted := true;
    end if;
    -- (review 6) the cap no longer holds this job: it is not a cap waiter any more
    if v_job.cap_wait is not null then
      update app.jobs j set cap_wait = null where j.id = p_job;
    end if;
    -- (136) ב: a verification code never waits for a rate and uses none; every other message passes the business's rate,
    -- then (133) ג the system-wide rate of the channel
    if not app.message_always_sends(v_type) then
    if v_rate.minute_start = v_minute and v_rate.sent >= app.message_rate_per_minute(v_channel) then
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = v_minute + interval '1 minute', last_error = 'waiting:rate'
       where j.id = p_job;
      -- the channel's other due marketing messages (app.message_move_waiting 'rate': never a service type, a pause-marked
      -- one, one still covered by the latest long pause or a cap waiter)
      perform app.message_move_waiting(v_job.organization_id, p_job, v_minute + interval '1 minute', 'rate', v_channel, 'rate');
      return jsonb_build_object('may_send', false, 'reason', 'rate', 'retry', true);
    end if;
    if not app.message_take_system_rate(v_channel, v_minute) then
      -- the whole system's minute is full for the channel: this job waits for the next minute, uncounted (other businesses'
      -- jobs are never moved from here)
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = v_minute + interval '1 minute', last_error = 'waiting:system_rate'
       where j.id = p_job;
      return jsonb_build_object('may_send', false, 'reason', 'system_rate', 'retry', true);
    end if;
    update app.message_send_rate r
       set minute_start = v_minute, sent = case when r.minute_start = v_minute then r.sent + 1 else 1 end
     where r.organization_id = v_job.organization_id and r.channel = v_channel;
    end if;

    -- MSG-05: the message is counted once, marketing or service, on the business's day; then the notices of the month's cap
    if not v_job.usage_counted then
      insert into app.message_usage_days (organization_id, channel, day, marketing, service)
      values (v_job.organization_id, v_channel, v_today, case when v_marketing then 1 else 0 end, case when v_marketing then 0 else 1 end)
      on conflict (organization_id, channel, day) do update
        set marketing = app.message_usage_days.marketing + excluded.marketing,
            service = app.message_usage_days.service + excluded.service;
      update app.jobs j set usage_counted = true where j.id = p_job;
      -- SMS-06: no monthly quota counter any more (app.sms_quota_months keeps its history); the composer charges the job's
      -- segments from the balance, only for a job this check passed (sms_metered)
      if v_sms_counted then
        update app.jobs j set sms_metered = true, sms_balance_wait_since = null where j.id = p_job;
      end if;
      if v_marketing and v_cap is not null and v_cap > 0 then
        v_used_month := v_used_month + 1;
        if v_used_month >= v_cap then
          perform app.message_cap_notify(v_job.organization_id, v_channel, 'full', v_used_month, v_cap,
                                         v_cap_plan is not null and v_cap_plan = v_cap, v_today);
        elsif v_used_month::bigint * 5 >= v_cap::bigint * 4 then
          perform app.message_cap_notify(v_job.organization_id, v_channel, 'warn', v_used_month, v_cap, false, v_today);
        end if;
      end if;
    end if;

    -- MSG-03: this lease passed the check; finish_job records the message only for such an attempt
    update app.jobs j set send_checked_lease = p_lease where j.id = p_job;
    return jsonb_build_object('may_send', true);
  end if;
  update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                        last_error = 'refused:' || v_reason
   where j.id = p_job;
  insert into app.job_cancel_counts (organization_id, reason, pending)
  values (v_job.organization_id, v_reason, 1)
  on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + 1;
  return jsonb_build_object('may_send', false, 'reason', v_reason);
end;
$$;

revoke all on function public.job_message_may_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.job_message_may_send(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- The composer's wrapper and the give-back (021247's bodies plus the balance lines)
-- ----------------------------------------------------------------------------
-- 021247's body: a refused job (not 'stale') gives its count back. SMS-06: a job under the balance (sms_metered) gives back its
-- charge (app.sms_balance_refund); a job counted under the old monthly quota is returned to its month as before.
create or replace function app.sms_usage_give_back(p_job uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_type text;
  v_today date;
  v_marketing boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  -- delta review (2): the day the job was counted on; unknown = nothing is given back
  if v_job.id is null or v_job.kind <> 'message.send' or not v_job.usage_counted or v_job.sms_counted_on is null
     or (v_job.payload ->> 'channel') is distinct from 'sms' then
    return false;
  end if;
  v_type := v_job.payload ->> 'message_type';
  v_marketing := not coalesce(v_type = any (app.service_message_types()), false);
  v_today := v_job.sms_counted_on;
  update app.message_usage_days u
     set marketing = greatest(u.marketing - case when v_marketing then 1 else 0 end, 0),
         service = greatest(u.service - case when v_marketing then 0 else 1 end, 0)
   where u.organization_id = v_job.organization_id and u.channel = 'sms' and u.day = v_today;
  if v_job.sms_metered then
    -- SMS-06: the segments the composer charged go back to the balance (nothing when it charged none)
    perform app.sms_balance_refund(p_job);
  elsif v_type is distinct from 'verification_code' then
    update app.sms_quota_months m set used = greatest(m.used - 1, 0)
     where m.organization_id = v_job.organization_id and m.month = date_trunc('month', v_today)::date;
  end if;
  -- a later try is counted again by the send check, and stamped again by the composer
  update app.jobs j set usage_counted = false, sms_counted_on = null, sms_metered = false where j.id = p_job;
  return true;
end;
$$;
revoke all on function app.sms_usage_give_back(uuid) from public, anon, authenticated, service_role;

-- The composer the worker calls: the core's answer as it is (on every refusal but 'stale' the count given back, owner (326)
-- ב). SMS-06: a composed text is charged from the balance (app.sms_balance_charge). The core and the charge run in one
-- sub-block; when the charge finds no room it raises the private SQLSTATE 'SMS06', so EVERY write the core made is undone:
-- the links it minted (app.signature_link_issue, public.meeting_reminder_link, consent and quote links: the customer's
-- earlier link keeps working, a CAL-10b link keeps its confirmed_at), and its composed_lease and sms_counted_on stamps.
-- Outside the block the job gives its count back from the day the core would have stamped (read before the block, with the
-- core's own expression, so the rollback cannot lose it), and waits for the balance as the send check makes it wait
-- (uncounted, cap_wait 'sms_balance'), answering {refused: 'sms_balance'}, which the worker treats as a wait (its finish
-- finds no lease and changes nothing). Nothing was charged on that path, so nothing is refunded.
create or replace function public.sms_job_compose(p_job uuid, p_lease uuid, p_site_url text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_answer jsonb;
  v_charge text;
  v_day date;
  v_segments integer;
begin
  -- the business day the core stamps (coalesce(stamp, today in the business zone), the same now() as the core's)
  select coalesce(j.sms_counted_on, (select (now() at time zone app.intake_zone(o.timezone))::date
                                       from public.organizations o where o.id = j.organization_id))
    into v_day
    from app.jobs j where j.id = p_job;
  begin
    v_answer := app.sms_compose_core(p_job, p_lease, p_site_url);
    if not (v_answer ? 'refused') then
      v_charge := app.sms_balance_charge(p_job, v_answer ->> 'text');
      if v_charge is not null then
        v_segments := greatest(app.sms_segments(v_answer ->> 'text'), 1);
        raise exception 'no room in the SMS balance' using errcode = 'SMS06';
      end if;
    end if;
  exception when sqlstate 'SMS06' then
    v_charge := 'sms_balance';
  end;
  if v_charge is null then
    if v_answer ? 'refused' and (v_answer ->> 'refused') is distinct from 'stale' then
      perform app.sms_usage_give_back(p_job);
    end if;
    return v_answer;
  end if;
  -- the core's writes are undone: the job is as the send check left it (counted, metered, no stamp). Its count goes back to
  -- the day read above, once (app.sms_usage_give_back resets usage_counted, so a second call gives nothing)
  update app.jobs j set sms_counted_on = v_day, sms_segments = v_segments where j.id = p_job and j.usage_counted;
  perform app.sms_usage_give_back(p_job);
  update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                        next_run_at = now() + interval '15 minutes', last_error = 'waiting:sms_balance',
                        cap_wait = 'sms_balance', sms_balance_wait_since = coalesce(j.sms_balance_wait_since, now()),
                        sms_segments = v_segments
   where j.id = p_job;
  return jsonb_build_object('refused', v_charge);
end;
$$;
revoke all on function public.sms_job_compose(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sms_job_compose(uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- (438) א: the sender-number code is never charged, and at most 3 checks a business day (021220's body plus that line)
-- ----------------------------------------------------------------------------
create or replace function public.sms_sender_verify_start(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_until timestamptz;
  v_check uuid;
  v_zone text;
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) or not coalesce(app.org_writable(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- RVW-81: the code is an SMS the platform pays for; a business whose plan has no SMS asks for none
  if not coalesce(app.org_has_feature(p_org, 'sms'), false) then
    raise exception 'sms is not in the plan' using errcode = 'P0001', hint = 'feature:sms';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_sender_check:' || p_org::text, 0));
  select app.normalize_phone(o.phone), app.intake_zone(o.timezone) into v_phone, v_zone from public.organizations o where o.id = p_org;
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'no_phone');
  end if;
  v_until := app.sms_sender_cooling(p_org);
  if v_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_seconds', greatest(ceil(extract(epoch from v_until - now())), 1)::integer);
  end if;
  -- SMS-06, owner (438) א: the codes are not charged from the balance, so at most 3 a business day
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  if (select count(*) from app.sms_sender_checks k
       where k.organization_id = p_org
         and k.created_at >= (date_trunc('day', now() at time zone v_zone) at time zone v_zone)) >= app.sms_sender_daily_max() then
    return jsonb_build_object('ok', false, 'reason', 'daily');
  end if;
  if (select count(*) from app.sms_sender_checks k where k.organization_id = p_org and k.created_at > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'rate');
  end if;
  insert into app.sms_sender_checks (organization_id, phone, created_by) values (p_org, v_phone, auth.uid())
  returning id into v_check;
  perform app.enqueue_job(p_org, 'message.send',
    jsonb_build_object('channel', 'sms', 'message_type', 'verification_code', 'sender_check_id', v_check), null);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.sms_sender_verify_start(uuid) from public, anon;
grant execute on function public.sms_sender_verify_start(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The card's send (021202's body): a business without a loaded balance has the channel off, said before anything is queued
-- ----------------------------------------------------------------------------
create or replace function public.record_sms_send(p_org uuid, p_kind text, p_record uuid, p_template uuid)
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_contact uuid;
  v_answer jsonb;
begin
  if auth.uid() is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'contact', 'deal') then
    raise exception 'unknown record type' using errcode = 'P0001', hint = 'record_sms:kind';
  end if;
  -- the record, as the caller reads it (RLS)
  if p_kind = 'lead' then
    perform 1 from public.leads l where l.organization_id = p_org and l.id = p_record and l.deleted_at is null;
  elsif p_kind = 'contact' then
    perform 1 from public.contacts c where c.organization_id = p_org and c.id = p_record and c.deleted_at is null;
  else
    select d.contact_id into v_contact from public.deals d
     where d.organization_id = p_org and d.id = p_record and d.deleted_at is null;
  end if;
  if not found then
    raise exception 'record not found' using errcode = 'P0001', hint = 'record_sms:not_found';
  end if;
  if p_kind = 'deal' then
    perform 1 from public.contacts c where c.organization_id = p_org and c.id = v_contact and c.deleted_at is null;
    if v_contact is null or not found then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_sms:no_contact';
    end if;
  end if;
  -- the template, as the caller reads it
  perform 1 from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    raise exception 'template not found' using errcode = 'P0001', hint = 'record_sms:template';
  end if;
  v_answer := app.record_sms_enqueue(p_org, p_kind, p_record, p_template);
  -- SMS-06: no SMS balance was ever loaded (or it was cleared): the channel is off, with the offer to buy on the screen. Judged
  -- after every refusal of the enqueue (rights, record, template, rate), so it tells nothing to whom the send was refused to
  -- anyway; raising here rolls back the queued job and its counts with the statement
  if app.sms_channel_state(p_org) = 'no_balance' then
    raise exception 'no sms balance' using errcode = 'P0001', hint = 'sms_balance:none';
  end if;
  return v_answer;
end;
$$;
revoke all on function public.record_sms_send(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.record_sms_send(uuid, text, uuid, uuid) to authenticated;
