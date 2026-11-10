-- =============================================================================
-- SMS-01b: the SMS sender, by the owner's answer (211) א (10 November 2026)
-- =============================================================================
-- * A sender NUMBER may only be the business's own phone (organizations.phone), and is used only once that phone is
--   verified by an SMS code: public.sms_sender_verify_start (owners/admins of a writable business) opens a check
--   (app.sms_sender_checks, schema app, no grants) and queues ONE OPS-04 message.send job of channel sms, type
--   verification_code, whose payload names only the check (`sender_check_id`, app.job_payload_ok); the queue sends it to
--   the check's phone (public.job_message_may_send reads it from the check; a verification code is never counted in the SMS
--   quota or held by the sending hours). The code is made only when the message goes: public.sms_sender_code_issue(job,
--   lease) (service_role, lease-bound, once per check) draws 6 digits, keeps only their SHA-256 with the check id, sets the
--   expiry to 10 minutes and answers {code, phone}. NO CALLER YET: the future SMS sender calls it (only the fake provider
--   exists); it needs its own "In use" line in hard rule 5 with that sender, after an independent review (the pattern of
--   CAL-12's meeting_reminder_link). public.sms_sender_verify(org, code) (owners/admins) compares; 5 wrong codes end the
--   check and start a 30-minute cool-down for the business (app.sms_sender_max_attempts, sms_sender_cooldown); it answers
--   {ok, reason} and never raises on a wrong code, so the counter survives. A verified phone is kept in server-only
--   org_message_settings.sms_sender_verified_phone / _verified_at; it counts only while it equals the business's phone.
--   At most 3 checks a business an hour.
-- * A LETTER name is stored and shown as "ממתין לאישור הספק"; it is used only after a platform owner or support marks it
--   approved: public.platform_set_sms_sender_approval(org, name, approved) (app.require_platform, aal2, logged in
--   app.platform_log 'sms_sender.approve|reject'; the name must be the stored one, so a change in between is not approved)
--   and public.platform_list_sms_sender_pending() (every platform role). Any change of the name clears its approval
--   (trigger org_message_settings_sms_sender, invoker, a person's write: a number must equal the business's phone, hint
--   sms_sender:not_own_phone; a person never writes the server columns, no grants).
-- * The sender the future SMS sender uses: app.sms_effective_sender(org) (definer, no grants): an approved letter name,
--   else the verified number while it is still the business's phone, else null (the platform's default).
-- * A business phone of the 1700/1800 kind (or any number app.normalize_phone does not read as an Israeli phone) cannot be
--   verified: sms_sender_verify_start answers 'no_phone' (review (10)).
-- * Final review of 10 November 2026: the code is issued only for the lease that passed the send check
--   (app.jobs.send_checked_lease) and again on a NEW lease while the check is open (a provider failure and a retry do not
--   kill it; the earlier code stops working; still within the 5 tries and the check's hour) (1); a rejected letter name is
--   kept as rejected (server-only sms_sender_rejected_at, out of the pending list, shown to the business, one `system`
--   notice to active owners and admins; a new name clears it) (3); an SMS waiting for the plan's flag is a cap waiter
--   ('sms_off', jobs_cap_wait_known), so the owners' "cancel the waiting" takes it (5); a sender check's code is not held
--   by HEB-09's pause, which is about customers (6; another job's pause move can still delay it by 5 minutes, because
--   app.message_move_waiting is not changed here); on sms a verification_code is exactly a job naming a sender check (7);
--   clients no longer select sms_sender_approved_by (column-level select on org_message_settings) (8).
-- * app.job_payload_ok and public.job_message_may_send are 021202's bodies with the sender check (test 284 pins the latter).
--   No row is deleted here. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The server's columns
-- ----------------------------------------------------------------------------
alter table public.org_message_settings add column if not exists sms_sender_verified_phone text;
alter table public.org_message_settings add column if not exists sms_sender_verified_at timestamptz;
alter table public.org_message_settings add column if not exists sms_sender_approved_at timestamptz;
alter table public.org_message_settings add column if not exists sms_sender_approved_by uuid;
alter table public.org_message_settings add column if not exists sms_sender_rejected_at timestamptz;
-- review (8): hiding sms_sender_approved_by from clients (column select grants) is in 021205, applied after the code that
-- names the readable columns is live (the running full export reads this table with select *).
-- review (5): an SMS waiting for the plan's sms flag is a cap waiter too
alter table app.jobs drop constraint if exists jobs_cap_wait_known;
alter table app.jobs add constraint jobs_cap_wait_known check (cap_wait is null or cap_wait in ('over_cap', 'day_quota', 'sms_off'));
comment on column public.org_message_settings.sms_sender_verified_phone is
  'SMS-01b: the business phone verified by an SMS code (server only); used while it equals organizations.phone';
comment on column public.org_message_settings.sms_sender_approved_at is
  'SMS-01b: when the platform approved the letter sender name (server only); null = waiting for the provider''s approval';

-- the business's phone as the sender rule compares it (E.164, else its digits; null = none)
create or replace function app.sms_sender_phone_key(p_value text) returns text
language sql stable set search_path = '' as $$
  select coalesce(app.normalize_phone(p_value), nullif(regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g'), ''))
$$;
revoke all on function app.sms_sender_phone_key(text) from public, anon;
grant execute on function app.sms_sender_phone_key(text) to authenticated, service_role;

-- a sender value that is a number (the SMS-01 rule's phone shapes)
create or replace function app.sms_sender_is_number(p_value text) returns boolean
language sql immutable set search_path = '' as $$
  select p_value ~ '^0[2-9][0-9]{7,8}$' or p_value ~ '^[+]?972[2-9][0-9]{7,8}$' or p_value ~ '^1[78]00[0-9]{6}$'
$$;
revoke all on function app.sms_sender_is_number(text) from public, anon;
grant execute on function app.sms_sender_is_number(text) to authenticated, service_role;

create or replace function app.org_message_settings_sms_sender() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_phone text;
begin
  if tg_op = 'UPDATE' and new.sms_sender_name is not distinct from old.sms_sender_name then
    return new;
  end if;
  -- any new name waits for its own approval
  new.sms_sender_approved_at := null;
  new.sms_sender_approved_by := null;
  new.sms_sender_rejected_at := null;
  if current_user = 'authenticated' and new.sms_sender_name is not null and app.sms_sender_is_number(new.sms_sender_name) then
    select o.phone into v_phone from public.organizations o where o.id = new.organization_id;
    if app.sms_sender_phone_key(v_phone) is null
       or app.sms_sender_phone_key(new.sms_sender_name) is distinct from app.sms_sender_phone_key(v_phone) then
      raise exception 'the sender number must be the business''s own phone' using errcode = 'P0001', hint = 'sms_sender:not_own_phone';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.org_message_settings_sms_sender() from public, anon;
grant execute on function app.org_message_settings_sms_sender() to authenticated;
create or replace trigger org_message_settings_sms_sender
  before insert or update of sms_sender_name on public.org_message_settings
  for each row execute function app.org_message_settings_sms_sender();

-- ----------------------------------------------------------------------------
-- The checks
-- ----------------------------------------------------------------------------
create or replace function app.sms_sender_max_attempts() returns integer
language sql immutable set search_path = '' as $$ select 5 $$;
revoke all on function app.sms_sender_max_attempts() from public, anon, authenticated;
create or replace function app.sms_sender_cooldown() returns interval
language sql immutable set search_path = '' as $$ select interval '30 minutes' $$;
revoke all on function app.sms_sender_cooldown() from public, anon, authenticated;

create table if not exists app.sms_sender_checks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  phone           text not null,
  code_hash       text,
  issued_at       timestamptz,
  -- review (1): the job lease the current code was issued for (a new lease may issue a new one)
  issued_lease    uuid,
  expires_at      timestamptz,
  attempts        integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  verified_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index if not exists sms_sender_checks_org_idx on app.sms_sender_checks (organization_id, created_at desc);
alter table app.sms_sender_checks enable row level security;
revoke all on app.sms_sender_checks from public, anon, authenticated, service_role;

-- the business's cool-down: a check that reached the wrong-code limit within the cool-down
create or replace function app.sms_sender_cooling(p_org uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select max(k.last_attempt_at) + app.sms_sender_cooldown()
    from app.sms_sender_checks k
   where k.organization_id = p_org and k.attempts >= app.sms_sender_max_attempts()
     and k.last_attempt_at > now() - app.sms_sender_cooldown()
$$;
revoke all on function app.sms_sender_cooling(uuid) from public, anon, authenticated, service_role;

create or replace function public.sms_sender_verify_start(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_until timestamptz;
  v_check uuid;
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) or not coalesce(app.org_writable(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_sender_check:' || p_org::text, 0));
  select app.normalize_phone(o.phone) into v_phone from public.organizations o where o.id = p_org;
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'no_phone');
  end if;
  v_until := app.sms_sender_cooling(p_org);
  if v_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_seconds', greatest(ceil(extract(epoch from v_until - now())), 1)::integer);
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

-- NO CALLER YET (see the header): the future SMS sender asks for the code of the check its job names, once per lease that
-- passed the send check
create or replace function public.sms_sender_code_issue(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_check app.sms_sender_checks;
  v_code text;
begin
  select * into v_job from app.jobs j where j.id = p_job for share;
  -- review (1): only the lease that passed the send check (job_message_may_send stamps it)
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now() or not (v_job.payload ? 'sender_check_id')
     or v_job.send_checked_lease is distinct from p_lease then
    return jsonb_build_object('refused', 'stale');
  end if;
  select * into v_check from app.sms_sender_checks k
   where k.organization_id = v_job.organization_id and k.id = (v_job.payload ->> 'sender_check_id')::uuid
   for update;
  if v_check.id is null or v_check.verified_at is not null
     or v_check.attempts >= app.sms_sender_max_attempts() or v_check.created_at <= now() - interval '1 hour' then
    return jsonb_build_object('refused', 'closed');
  end if;
  -- once per lease; a new lease (the provider failed and the job is tried again) issues a new code, the old one stops working
  if v_check.issued_lease is not distinct from p_lease then
    return jsonb_build_object('refused', 'issued');
  end if;
  v_code := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  update app.sms_sender_checks k
     set code_hash = encode(sha256(convert_to(k.id::text || ':' || v_code, 'UTF8')), 'hex'),
         issued_at = now(), expires_at = now() + interval '10 minutes', issued_lease = p_lease
   where k.id = v_check.id;
  return jsonb_build_object('code', v_code, 'phone', v_check.phone);
end;
$$;
revoke all on function public.sms_sender_code_issue(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sms_sender_code_issue(uuid, uuid) to service_role;

create or replace function public.sms_sender_verify(p_org uuid, p_code text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_check app.sms_sender_checks;
  v_until timestamptz;
  v_code text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) or not coalesce(app.org_writable(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_sender_check:' || p_org::text, 0));
  v_until := app.sms_sender_cooling(p_org);
  if v_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_seconds', greatest(ceil(extract(epoch from v_until - now())), 1)::integer);
  end if;
  select * into v_check from app.sms_sender_checks k
   where k.organization_id = p_org and k.verified_at is null and k.code_hash is not null
     and k.attempts < app.sms_sender_max_attempts()
   order by k.created_at desc
   limit 1
   for update;
  if v_check.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_code');
  end if;
  if v_check.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_code !~ '^[0-9]{6}$' or encode(sha256(convert_to(v_check.id::text || ':' || v_code, 'UTF8')), 'hex') <> v_check.code_hash then
    update app.sms_sender_checks k set attempts = k.attempts + 1, last_attempt_at = now() where k.id = v_check.id;
    return jsonb_build_object('ok', false, 'reason', 'wrong',
      'left', greatest(app.sms_sender_max_attempts() - v_check.attempts - 1, 0));
  end if;
  update app.sms_sender_checks k set verified_at = now(), last_attempt_at = now() where k.id = v_check.id;
  insert into public.org_message_settings as s (organization_id, sms_sender_verified_phone, sms_sender_verified_at)
  values (p_org, v_check.phone, now())
  on conflict (organization_id) do update
    set sms_sender_verified_phone = excluded.sms_sender_verified_phone, sms_sender_verified_at = excluded.sms_sender_verified_at;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'sms_sender_verified', 'org_message_settings', null, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.sms_sender_verify(uuid, text) from public, anon;
grant execute on function public.sms_sender_verify(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The platform's approval of a letter name
-- ----------------------------------------------------------------------------
create or replace function public.platform_set_sms_sender_approval(p_org uuid, p_name text, p_approved boolean) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row public.org_message_settings%rowtype;
begin
  perform app.require_platform(array['support']);
  if p_approved is null then
    raise exception 'a state is required' using errcode = '22023';
  end if;
  select * into v_row from public.org_message_settings s where s.organization_id = p_org for update;
  if v_row.organization_id is null or v_row.sms_sender_name is null or app.sms_sender_is_number(v_row.sms_sender_name) then
    return jsonb_build_object('ok', false, 'reason', 'no_name');
  end if;
  if v_row.sms_sender_name is distinct from p_name then
    return jsonb_build_object('ok', false, 'reason', 'changed');
  end if;
  update public.org_message_settings s
     set sms_sender_approved_at = case when p_approved then now() end,
         sms_sender_approved_by = case when p_approved then auth.uid() end,
         sms_sender_rejected_at = case when p_approved then null else now() end
   where s.organization_id = p_org;
  -- review (3): a rejection is told once to the business's active owners and admins (no notice when approved)
  if not p_approved then
    insert into public.notifications (organization_id, user_id, type, title, body)
    select m.organization_id, m.user_id, 'system', 'שם השולח ב-SMS נדחה',
           'ספק ה-SMS לא אישר את שם השולח ' || p_name || '. ההודעות יוצאות ממספר הטלפון המאומת של העסק, או בשם הכללי של המערכת. '
           || 'אפשר לבחור שם אחר בהגדרות "שעות ותקרות שליחה".'
      from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
  end if;
  perform app.log_platform(case when p_approved then 'sms_sender.approve' else 'sms_sender.reject' end, p_org,
    jsonb_build_object('name', p_name));
  return jsonb_build_object('ok', true, 'approved', p_approved);
end;
$$;
revoke all on function public.platform_set_sms_sender_approval(uuid, text, boolean) from public, anon;
grant execute on function public.platform_set_sms_sender_approval(uuid, text, boolean) to authenticated;

create or replace function public.platform_list_sms_sender_pending() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return coalesce((
    select jsonb_agg(jsonb_build_object('organization_id', s.organization_id, 'business', o.name, 'name', s.sms_sender_name,
                                        'since', s.updated_at) order by s.updated_at)
      from public.org_message_settings s
      join public.organizations o on o.id = s.organization_id
     where s.sms_sender_name is not null and not app.sms_sender_is_number(s.sms_sender_name)
       and s.sms_sender_approved_at is null and s.sms_sender_rejected_at is null and o.deleted_at is null), '[]'::jsonb);
end;
$$;
revoke all on function public.platform_list_sms_sender_pending() from public, anon;
grant execute on function public.platform_list_sms_sender_pending() to authenticated;

-- ----------------------------------------------------------------------------
-- The sender a message goes out with (for the future SMS sender)
-- ----------------------------------------------------------------------------
create or replace function app.sms_effective_sender(p_org uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select case
           when s.sms_sender_name is not null and not app.sms_sender_is_number(s.sms_sender_name)
                and s.sms_sender_approved_at is not null then s.sms_sender_name
           when s.sms_sender_verified_phone is not null
                and s.sms_sender_verified_phone = app.normalize_phone(o.phone) then s.sms_sender_verified_phone
         end
    from public.organizations o
    left join public.org_message_settings s on s.organization_id = o.id
   where o.id = p_org
$$;
revoke all on function app.sms_effective_sender(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The queue: 021202's bodies with the sender check
-- ----------------------------------------------------------------------------
create or replace function app.job_payload_ok(p_kind text, p_payload jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then false
    when p_kind = 'message.send' then
      coalesce(
        (select bool_and(k in ('channel', 'lead_id', 'contact_id', 'event_at', 'message_type', 'template_id', 'punch_card_id',
                               'meeting_id', 'deal_id', 'file_ids', 'library_file_ids',
                               'reply_to_user_id', 'sent_by_user_id', 'automation_id', 'pressed_by_user_id',
                               'sender_check_id'))
           from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      -- SMS-01b (owner (211) א): the code that verifies the business's sender number goes to the business's own phone, named by
      -- its check row (public.sms_sender_verify_start), never to a lead or a contact: sms, verification_code, nothing a record carries
      and (case when p_payload ? 'sender_check_id' then
             not (p_payload ? 'lead_id') and not (p_payload ? 'contact_id')
             and jsonb_typeof(p_payload -> 'sender_check_id') = 'string'
             and (p_payload ->> 'sender_check_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             and (p_payload ->> 'channel') = 'sms' and (p_payload ->> 'message_type') is not distinct from 'verification_code'
             and not (p_payload ?| array['template_id', 'punch_card_id', 'meeting_id', 'deal_id', 'event_at', 'sent_by_user_id',
                                         'automation_id', 'pressed_by_user_id'])
           else
             -- review (7): on sms a verification code is only a sender check's
             ((p_payload ->> 'channel') <> 'sms' or (p_payload ->> 'message_type') is distinct from 'verification_code')
             and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
             and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
             and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
                 ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           end)
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
      -- CAL-12: the meeting a meeting_reminder is about (the sender re-reads it and fills its date, time and location)
      and (not (p_payload ? 'meeting_id')
           or (jsonb_typeof(p_payload -> 'meeting_id') = 'string'
               and (p_payload ->> 'meeting_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
      -- EML-02: an email from a record's card: the deal it was sent from (with the deal's contact as the record), the record
      -- files attached and the person who sent it (the reply-to address), ids only and email only
      -- SMS-02: deal_id also on an SMS from a deal's card or a deal rule
      and (not (p_payload ? 'deal_id')
           or (jsonb_typeof(p_payload -> 'deal_id') = 'string'
               and (p_payload ->> 'deal_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and p_payload ? 'contact_id'))
      and (not (p_payload ? 'reply_to_user_id')
           or (jsonb_typeof(p_payload -> 'reply_to_user_id') = 'string'
               and (p_payload ->> 'reply_to_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'file_ids')
           or (jsonb_typeof(p_payload -> 'file_ids') = 'array'
               and jsonb_array_length(p_payload -> 'file_ids') between 1 and 5
               and coalesce((select bool_and(jsonb_typeof(f) = 'string'
                                             and (f #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                               from jsonb_array_elements(p_payload -> 'file_ids') f), false)
               and (select count(distinct f #>> '{}') from jsonb_array_elements(p_payload -> 'file_ids') f)
                   = jsonb_array_length(p_payload -> 'file_ids')))
      and (not (p_payload ? 'library_file_ids')
           or (jsonb_typeof(p_payload -> 'library_file_ids') = 'array'
               and jsonb_array_length(p_payload -> 'library_file_ids') between 1 and 5
               and coalesce((select bool_and(jsonb_typeof(f) = 'string'
                                             and (f #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                               from jsonb_array_elements(p_payload -> 'library_file_ids') f), false)
               and (select count(distinct f #>> '{}') from jsonb_array_elements(p_payload -> 'library_file_ids') f)
                   = jsonb_array_length(p_payload -> 'library_file_ids')))
      -- the two kinds together: at most 5 files on one email
      and (case when jsonb_typeof(p_payload -> 'file_ids') = 'array' then jsonb_array_length(p_payload -> 'file_ids') else 0 end
           + case when jsonb_typeof(p_payload -> 'library_file_ids') = 'array' then jsonb_array_length(p_payload -> 'library_file_ids') else 0 end) <= 5
      and ((not (p_payload ? 'file_ids') and not (p_payload ? 'library_file_ids') and not (p_payload ? 'reply_to_user_id'))
           or (p_payload ->> 'channel') = 'email')
      and (not (p_payload ? 'deal_id') or (p_payload ->> 'channel') in ('email', 'sms'))
      -- SMS-02: the person who sent an SMS from a card, or the rule that queued it; sms only, never both
      and (not (p_payload ? 'sent_by_user_id')
           or (jsonb_typeof(p_payload -> 'sent_by_user_id') = 'string'
               and (p_payload ->> 'sent_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'automation_id')
           or (jsonb_typeof(p_payload -> 'automation_id') = 'string'
               and (p_payload ->> 'automation_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and not ((p_payload ? 'sent_by_user_id') and (p_payload ? 'automation_id'))
      -- review (7): the person who pressed a button rule's SMS (counted in their hourly cap); only with automation_id
      and (not (p_payload ? 'pressed_by_user_id')
           or ((p_payload ? 'automation_id') and jsonb_typeof(p_payload -> 'pressed_by_user_id') = 'string'
               and (p_payload ->> 'pressed_by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and ((not (p_payload ? 'sent_by_user_id') and not (p_payload ? 'automation_id')) or (p_payload ->> 'channel') = 'sms')
    -- IMP-04 (owner (155) א): the order and the person who made it, nothing else
    -- (never null: a missing key is false, not unknown, so the check constraint and enqueue_job refuse it)
    when p_kind in ('import.run', 'export.run') then
      coalesce(
        coalesce((select bool_and(k in ('request_id', 'user_id')) from jsonb_object_keys(p_payload) k), false)
        and jsonb_typeof(p_payload -> 'request_id') = 'string'
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and (p_payload ->> 'request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false)
    else false
  end
$$;

revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

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

  if not app.org_writable(v_job.organization_id) then
    v_reason := 'business_closed';
  elsif v_event_at is not null and v_event_at < now() then
    v_reason := 'event_passed';
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
    if not app.message_always_sends(v_type) then
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
    -- SMS (owner (210) ב, scope (א2)): every SMS to a customer (the card's, automations', CAL-12's, PKG-03's; never a
    -- verification code) needs the plan's `sms` flag and fits its month quota (max_sms_per_month), counted when sent in
    -- app.sms_quota_months (business zone). Without the flag the job waits uncounted (an hour); over the quota it waits
    -- uncounted (15 minutes, as MSG-05's cap: cap_wait 'over_cap', so the owners' cancel takes it too) until the month turns or
    -- the quota is raised, with app.sms_quota_notify's notices (80% once a month, full once a calendar day). A job counted on
    -- an earlier attempt (usage_counted) keeps its place. Under the channel's rate row lock taken above, so two workers cannot
    -- pass the last place together.
    if v_channel = 'sms' and v_type is distinct from 'verification_code' and not v_job.usage_counted then
      if not coalesce(app.org_has_feature(v_job.organization_id, 'sms'), false) then
        update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                              next_run_at = now() + interval '1 hour', last_error = 'waiting:sms_off', cap_wait = 'sms_off'
         where j.id = p_job;
        return jsonb_build_object('may_send', false, 'reason', 'sms_off', 'retry', true);
      end if;
      v_sms_cap := app.sms_plan_quota(v_job.organization_id);
      if v_sms_cap is not null then
        select coalesce(max(m.used), 0) into v_sms_used
          from app.sms_quota_months m
         where m.organization_id = v_job.organization_id and m.month = date_trunc('month', v_today)::date;
        if v_sms_used >= v_sms_cap then
          perform app.sms_quota_notify(v_job.organization_id, 'full', v_sms_used, v_sms_cap, v_today);
          update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                                next_run_at = now() + interval '15 minutes', last_error = 'waiting:over_cap', cap_wait = 'over_cap'
           where j.id = p_job;
          return jsonb_build_object('may_send', false, 'reason', 'over_cap', 'retry', true);
        end if;
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
      -- SMS (owner (210) ב): the SMS is counted once in the month's quota counter; the 80% / full notices
      if v_sms_counted then
        insert into app.sms_quota_months as m (organization_id, month, used)
        values (v_job.organization_id, date_trunc('month', v_today)::date, 1)
        on conflict (organization_id, month) do update set used = m.used + 1
        returning m.used into v_sms_used;
        if v_sms_cap is not null and v_sms_cap > 0 then
          if v_sms_used >= v_sms_cap then
            perform app.sms_quota_notify(v_job.organization_id, 'full', v_sms_used, v_sms_cap, v_today);
          elsif v_sms_used::bigint * 5 >= v_sms_cap::bigint * 4 then
            perform app.sms_quota_notify(v_job.organization_id, 'warn', v_sms_used, v_sms_cap, v_today);
          end if;
        end if;
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
