-- =============================================================================
-- USR-11 second part, WAB-03, MNY-03: the daily summary email (OPS-04 job kind digest.send)
-- =============================================================================
-- Owner (267) א (11 November 2026): job kind `digest.send` under answer (55)'s conditions (ids and codes only in the queue,
-- the worker's functions pinned by md5, its own "In use" line). Owner's answers of 15 November 2026:
-- (375) ב: the numbers are computed by ONE database function under the RECIPIENT's own read rules (app.user_can_read_record's
--   rule and its siblings: the HEB-08 deputy records of app.deputy_records, TASK-07's team tasks, SPD-01's taken leads), never with
--   a background token and never through OPS-09's set functions (those answer for auth.uid() only). public.digest_job_compose
--   (security definer, service_role only) is that function; app.digest_counts holds the counting. A recipient who reads nothing
--   gets fixed text and a link only (counts null). Counts and links only, never a customer's name.
--   Accepted (the lead, 15 November 2026): the counts are made without a session, so a person in a require_mfa business (or
--   with a verified factor) is counted as after the second step: the numbers equal what they see once signed in with it; they
--   go only to the person's own sign-in address, and are numbers and links only.
-- (376) ב: every plan but the free plan: a new plan key `daily_digest`, on in personal, basic, pro and business, off in the free
--   plan (which does not hold it, so app.plan_key_defaults answers false).
-- (377) ב: a one-click stop link without sign-in: one token per email (only its SHA-256 kept, 30 days, used once), the page
--   /f/digest-stop/<token> and the route /api/forms/digest-stop/<token> (also RFC 8058 one-click) through public.digest_stop
--   (definer, service_role only): it checks the token and does only this: switches the person's summary off in that business
--   (digest_settings.enabled, stamped stopped_by_link_at, shown in the person's notification settings, where it is turned back on).
-- (378) א: the draft wording is approved (src/features/digest/email.ts).
--
-- What this file holds:
-- * public.digest_settings: one row per person and business, the person's own switch (off by default) and send time (07:30 by
--   default, a quarter hour between 05:00 and 12:00, in the business's zone), and the server-only stopped_by_link_at.
-- * app.job_kinds() gains 'digest.send'; app.job_payload_ok() (021240's body, one more branch) takes exactly
--   {user_id, organization_id, digest_kind, day}.
-- * app.queue_daily_digests(): pg_cron `crm-daily-digests` (every 15 minutes) queues one digest.send job per person and
--   business day: an active member of a business that is open and holds `daily_digest`, with the switch on, on a working day,
--   from the chosen time for three hours, not on leave; the job runs at the end of the person's quiet hours. Once per person,
--   business and day (app.digest_sends). Nothing is queued while no worker asked for digest.send in the last day.
-- * app.digest_counts(org, user, kind, now) and public.digest_job_compose(job, lease) for the worker.
-- * app.digest_stop_tokens, app.digest_stop_counts and public.digest_stop(token, ip_hash, stop) for the stop link.
-- * app.run_digest_cleanup(): pg_cron `crm-digest-cleanup`; a no-op until the hand-pasted 021282 defines
--   app.digest_cleanup_rows() (the only deletes: expired tokens and old once-a-day rows).
-- Every statement is safe to run twice. No row of any table is rewritten but the plans' features (one key added).

-- ----------------------------------------------------------------------------
-- The person's own setting
-- ----------------------------------------------------------------------------
create table if not exists public.digest_settings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null default auth.uid(),
  enabled         boolean not null default false,
  send_at         time not null default '07:30',
  -- server only: when the person switched the summary off from the stop link in an email (cleared when switched on again)
  stopped_by_link_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade,
  constraint digest_settings_send_at check (
    send_at >= '05:00'::time and send_at <= '12:00'::time
    and extract(second from send_at) = 0 and (extract(minute from send_at))::int % 15 = 0)
);

create or replace trigger digest_settings_touch before insert or update on public.digest_settings
  for each row execute function app.touch_row();

alter table public.digest_settings add column if not exists stopped_by_link_at timestamptz;

-- switching the summary on again clears the stop link's mark; nobody but the server sets it (no client grant)
create or replace function app.digest_settings_stop_mark() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled) then
    new.stopped_by_link_at := null;
  end if;
  return new;
end;
$$;
revoke all on function app.digest_settings_stop_mark() from public, anon, authenticated;

create or replace trigger digest_settings_stop_mark before insert or update on public.digest_settings
  for each row execute function app.digest_settings_stop_mark();

alter table public.digest_settings enable row level security;
revoke all on public.digest_settings from public, anon, authenticated;
grant select on public.digest_settings to authenticated;
grant insert (organization_id, enabled, send_at) on public.digest_settings to authenticated;
grant update (enabled, send_at) on public.digest_settings to authenticated;

-- reading: the person's own row while a member; writing: the person's own row while they hold a role by their plain
-- membership (never a support session: app.membership_role, not app.role_in)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'digest_settings' and policyname = 'digest_settings_select') then
    create policy digest_settings_select on public.digest_settings for select to authenticated
      using (user_id = (select auth.uid()) and app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'digest_settings' and policyname = 'digest_settings_insert') then
    create policy digest_settings_insert on public.digest_settings for insert to authenticated
      with check (user_id = (select auth.uid()) and app.membership_role(organization_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'digest_settings' and policyname = 'digest_settings_update') then
    create policy digest_settings_update on public.digest_settings for update to authenticated
      using (user_id = (select auth.uid()) and app.membership_role(organization_id) is not null)
      with check (user_id = (select auth.uid()) and app.membership_role(organization_id) is not null);
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The job kind and its payload
-- ----------------------------------------------------------------------------
create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run', 'digest.send']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021240's body, plus digest.send (owner (267) א): exactly {user_id, organization_id, digest_kind, day}
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
                               'sender_check_id', 'signature_document_id', 'form_submission_id',
                               'collection_document_id', 'review_request_id'))
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
                                         'automation_id', 'pressed_by_user_id', 'signature_document_id',
                                         'collection_document_id'])
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
      -- SGN-03 (owner (249) א): the document for signature a requested_document reminder is about (the sender re-reads it)
      and (not (p_payload ? 'signature_document_id')
           or (jsonb_typeof(p_payload -> 'signature_document_id') = 'string'
               and (p_payload ->> 'signature_document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'requested_document'))
      -- COL-07: the debt document a collection reminder to the customer is about (the sender re-reads it); collection only,
      -- on a contact, by SMS or email
      and (not (p_payload ? 'collection_document_id')
           or (jsonb_typeof(p_payload -> 'collection_document_id') = 'string'
               and (p_payload ->> 'collection_document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'collection'
               and p_payload ? 'contact_id'
               and (p_payload ->> 'channel') in ('email', 'sms')))
      -- SPD-04 (owner (80) א): the form submission an instant reply answers (the sender re-reads the address typed there)
      and (not (p_payload ? 'form_submission_id')
           or (jsonb_typeof(p_payload -> 'form_submission_id') = 'string'
               and (p_payload ->> 'form_submission_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'instant_reply'
               and not (p_payload ?| array['deal_id', 'file_ids', 'library_file_ids', 'reply_to_user_id', 'sent_by_user_id',
                                           'automation_id', 'pressed_by_user_id', 'sender_check_id'])))
      -- RET-02: the review request a message is (the sender re-reads it and the business's settings); review_request only, on a
      -- contact or (owner (309) ב) a lead, by SMS or email, with no files, reply-to person, sender or rule
      and (not (p_payload ? 'review_request_id')
           or (jsonb_typeof(p_payload -> 'review_request_id') = 'string'
               and (p_payload ->> 'review_request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'review_request'
               and (p_payload ? 'contact_id' or p_payload ? 'lead_id')
               and (p_payload ->> 'channel') in ('email', 'sms')
               and not (p_payload ?| array['file_ids', 'library_file_ids', 'reply_to_user_id', 'sent_by_user_id',
                                           'automation_id', 'pressed_by_user_id', 'sender_check_id'])))
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
      -- AUT-08: sent_by_user_id stays sms only; automation_id (and so pressed_by_user_id) on sms and email
      and (not (p_payload ? 'sent_by_user_id') or (p_payload ->> 'channel') = 'sms')
      and (not (p_payload ? 'automation_id') or (p_payload ->> 'channel') in ('sms', 'email'))
      -- AUT-08: an automation's email has no reply-to person and no attachments
      and not ((p_payload ? 'automation_id') and (p_payload ?| array['reply_to_user_id', 'file_ids', 'library_file_ids']))
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
    -- USR-11 / WAB-03 (owner (267) א): the person, the business, the kind of summary and the business day, nothing else
    when p_kind = 'digest.send' then
      coalesce(
        coalesce((select bool_and(k in ('user_id', 'organization_id', 'digest_kind', 'day')) from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 4
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and jsonb_typeof(p_payload -> 'organization_id') = 'string'
        and jsonb_typeof(p_payload -> 'digest_kind') = 'string'
        and jsonb_typeof(p_payload -> 'day') = 'string'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'organization_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'digest_kind') in ('manager', 'personal')
        and (p_payload ->> 'day') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
        false)
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Once per person, business and day
-- ----------------------------------------------------------------------------
create table if not exists app.digest_sends (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null,
  day             date not null,
  digest_kind     text not null check (digest_kind in ('manager', 'personal')),
  job_id          uuid,
  queued_at       timestamptz not null default now(),
  primary key (organization_id, user_id, day)
);
alter table app.digest_sends enable row level security;
revoke all on app.digest_sends from public, anon, authenticated, service_role;

-- the kind of summary a role gets: the business lines for owners, admins and managers
create or replace function app.digest_kind_for(p_role text) returns text
language sql immutable
set search_path = ''
as $$ select case when p_role in ('owner', 'admin', 'manager') then 'manager' else 'personal' end $$;
revoke all on function app.digest_kind_for(text) from public, anon, authenticated, service_role;

-- the instant the job runs: the chosen moment, or the end of the person's own quiet hours when it falls inside them, but only
-- when that end is on the same business day; quiet hours that cover the rest of the day do not hold the summary past its own
-- day (the composer would refuse it as expired), so it goes at the chosen time
create or replace function app.digest_run_at(p_user uuid, p_zone text, p_at timestamptz) returns timestamptz
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_from time;
  v_until time;
  v_end timestamptz;
begin
  select s.quiet_from, s.quiet_until into v_from, v_until from public.notification_settings s where s.user_id = p_user;
  if v_from is null or v_until is null then
    return p_at;
  end if;
  v_end := app.quiet_hours_end(v_from, v_until, p_zone, p_at);
  if v_end is null or v_end <= p_at or (v_end at time zone p_zone)::date <> (p_at at time zone p_zone)::date then
    return p_at;
  end if;
  return v_end;
end;
$$;
revoke all on function app.digest_run_at(uuid, text, timestamptz) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The cron: one job per person and business day
-- ----------------------------------------------------------------------------
create or replace function app.queue_daily_digests(p_limit integer default 2000, p_now timestamptz default null)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 0), 2000);
  v_row record;
  v_kind text;
  v_job uuid;
  v_queued integer := 0;
begin
  -- a finished job's stop token is no longer needed in plain form (review 4): only its hash stays
  perform app.digest_clear_plain_tokens();
  -- no worker sends this kind yet: queue nothing (a job nobody claims would only wait)
  if not exists (select 1 from app.job_kind_seen s
                  where s.kind = 'digest.send' and s.last_claimed_at > now() - interval '1 day') then
    return 0;
  end if;
  for v_row in
    select d.organization_id, d.user_id, d.send_at, m.role, z.zone,
           (v_now at time zone z.zone)::date as local_day,
           (v_now at time zone z.zone)::time as local_time
      from public.digest_settings d
      join public.memberships m on m.organization_id = d.organization_id and m.user_id = d.user_id and m.status = 'active'
      join public.organizations o on o.id = d.organization_id
      cross join lateral (select app.intake_zone(o.timezone) as zone) z
     where d.enabled
       and o.deleted_at is null
       -- owner (376) ב: every plan but the free plan
       and app.org_has_feature(d.organization_id, 'daily_digest')
       and not app.org_status_closed(o.status)
       and not app.org_deletion_pending(o.id)
       and not exists (select 1 from app.digest_sends x
                        where x.organization_id = d.organization_id and x.user_id = d.user_id
                          and x.day = (v_now at time zone z.zone)::date)
     order by d.organization_id, d.user_id
  loop
    exit when v_queued >= v_limit;
    -- from the chosen time, for three hours
    continue when v_row.local_time < v_row.send_at or v_row.local_time >= v_row.send_at + interval '3 hours';
    begin
      continue when app.org_rest_day(v_row.organization_id, v_row.local_day);
      continue when app.member_on_leave(v_row.organization_id, v_row.user_id, v_now);
      v_kind := app.digest_kind_for(v_row.role::text);
      insert into app.digest_sends (organization_id, user_id, day, digest_kind)
      values (v_row.organization_id, v_row.user_id, v_row.local_day, v_kind)
      on conflict do nothing;
      continue when not found;
      v_job := app.enqueue_job(v_row.organization_id, 'digest.send',
                 jsonb_build_object('user_id', v_row.user_id::text, 'organization_id', v_row.organization_id::text,
                                    'digest_kind', v_kind, 'day', to_char(v_row.local_day, 'YYYY-MM-DD')),
                 app.digest_run_at(v_row.user_id, v_row.zone, v_now));
      update app.digest_sends x set job_id = v_job
       where x.organization_id = v_row.organization_id and x.user_id = v_row.user_id and x.day = v_row.local_day;
      v_queued := v_queued + 1;
    exception when others then
      raise warning 'daily digest not queued (%): %', v_row.organization_id, sqlstate;
    end;
  end loop;
  return v_queued;
end;
$$;
revoke all on function app.queue_daily_digests(integer, timestamptz) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-daily-digests', '*/15 * * * *', 'select app.queue_daily_digests();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The plan key (owner (376) ב): every plan but the free plan
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": {}, "features": { "daily_digest": true } },
  "basic": { "limits": {}, "features": { "daily_digest": true } },
  "pro": { "limits": {}, "features": { "daily_digest": true } },
  "business": { "limits": {}, "features": { "daily_digest": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- 021263's fallback with the new key (a plan that does not hold it, the free plan: no summary)
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
    "public_page": false,
    "money_waiting_actions": false,
    "recurring_billing": false,
    "prefill_links": false,
    "daily_digest": false
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
    "max_sms_per_month": 0,
    "max_quotes_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- The numbers, under the recipient's own read rules (owner (375) ב)
-- ----------------------------------------------------------------------------
-- The teams whose records a person reads by team (app.user_can_read_record's two team branches): with team visibility the
-- teams the person is a member of; a manager also every team they manage and every team under one (10 levels, the chain
-- that function walks upwards). `managed` = the manager's part alone (SPD-01's taken-lead rule, app.manages_team's set).
create or replace function app.digest_read_teams(p_org uuid, p_user uuid, out read_teams uuid[], out managed uuid[],
                                                 out member_teams uuid[])
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role;
  v_visibility public.record_visibility;
begin
  read_teams := '{}'; managed := '{}'; member_teams := '{}';
  select m.role into v_role from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_role is null then
    return;
  end if;
  select o.record_visibility into v_visibility from public.organizations o where o.id = p_org;
  select coalesce(array_agg(distinct tm.team_id), '{}') into member_teams
    from public.team_members tm join public.teams t on t.id = tm.team_id and t.organization_id = p_org
   where tm.user_id = p_user;
  if v_role = 'manager' then
    with recursive down as (
      select t.id, 1 as depth
        from public.teams t
        join public.team_members tm on tm.team_id = t.id and tm.user_id = p_user and tm.is_manager
       where t.organization_id = p_org
      union all
      select c.id, d.depth + 1
        from public.teams c join down d on c.parent_team_id = d.id
       where c.organization_id = p_org and d.depth < 10
    )
    select coalesce(array_agg(distinct id), '{}') into managed from down;
  end if;
  read_teams := managed;
  if v_visibility = 'team' then
    select coalesce(array_agg(distinct x), '{}') into read_teams from unnest(managed || member_teams) x;
  end if;
end;
$$;
revoke all on function app.digest_read_teams(uuid, uuid) from public, anon, authenticated, service_role;

-- The summary's counts for one person in one business, as of p_now. Counts and amounts only. `reads_anything` false = the
-- person reads no record at all (fixed text and a link only). 'personal' counts the person's own leads and tasks; 'manager'
-- (owners, admins, managers) counts what the person reads, and the money waiting (MNY-01's groups, MNY-03).
-- Mirrors, for another person: leads_select/deals_select/contacts_select/tasks_select (app.user_can_read_record's rule +
-- app.deputy_records), the waiting screen's rule (src/features/leads/waiting.ts, SPD-01's taken filter) and
-- public.report_money_waiting (021144) without p_owner, the estimate and the lists. Keep in step; test 372 compares them.
-- Debts are counted only for owners and admins (who read every money row); a manager's summary leaves them out.
create or replace function app.digest_counts(p_org uuid, p_user uuid, p_kind text, p_now timestamptz default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
set jit = off
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_role public.membership_role;
  v_visibility public.record_visibility;
  v_zone text;
  v_today date;
  v_all boolean;
  v_teams record;
  v_dep_lead uuid[];
  v_dep_contact uuid[];
  v_dep_deal uuid[];
  v_dep_task uuid[];
  v_reads boolean;
  v_leads_on boolean;
  v_new bigint;
  v_waiting bigint;
  v_overdue bigint;
  v_today_tasks bigint;
  v_money jsonb;
  v_rate integer;
  v_mode text;
  v_quotes boolean;
  v_debts boolean;
begin
  select m.role into v_role from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_role is null or p_kind not in ('manager', 'personal') then
    return null;
  end if;
  select o.record_visibility, app.intake_zone(o.timezone) into v_visibility, v_zone from public.organizations o where o.id = p_org;
  v_today := (v_now at time zone v_zone)::date;
  v_all := v_role in ('owner', 'admin') or v_visibility = 'org';
  select * into v_teams from app.digest_read_teams(p_org, p_user);
  select coalesce(array_agg(r.id), '{}') into v_dep_lead from app.deputy_records(p_user, 'lead', false) r where r.organization_id = p_org;
  select coalesce(array_agg(r.id), '{}') into v_dep_contact from app.deputy_records(p_user, 'contact', false) r where r.organization_id = p_org;
  select coalesce(array_agg(r.id), '{}') into v_dep_deal from app.deputy_records(p_user, 'deal', false) r where r.organization_id = p_org;
  select coalesce(array_agg(r.id), '{}') into v_dep_task from app.deputy_records(p_user, 'task', false) r where r.organization_id = p_org;

  v_reads := v_all or cardinality(v_teams.read_teams) > 0
    or cardinality(v_dep_lead) + cardinality(v_dep_contact) + cardinality(v_dep_deal) + cardinality(v_dep_task) > 0
    or exists (select 1 from public.leads l where l.organization_id = p_org and l.owner_id = p_user and l.deleted_at is null)
    or exists (select 1 from public.contacts c where c.organization_id = p_org and c.owner_id = p_user and c.deleted_at is null)
    or exists (select 1 from public.deals d where d.organization_id = p_org and d.owner_id = p_user and d.deleted_at is null)
    or exists (select 1 from public.tasks t where t.organization_id = p_org and t.deleted_at is null
                and (t.owner_id = p_user or t.created_by = p_user))
    or (v_role <> 'viewer' and exists (
          select 1 from public.tasks t where t.organization_id = p_org and t.owner_id is null and t.status = 'open'
             and t.deleted_at is null and t.team_id = any (v_teams.member_teams)));
  if not v_reads then
    return jsonb_build_object('reads_anything', false);
  end if;

  v_leads_on := app.org_leads_enabled(p_org);
  if v_leads_on then
    -- leads that arrived since yesterday began (the business's day), not imported
    if p_kind = 'manager' then
      select count(*) into v_new from public.leads l
       where l.organization_id = p_org and l.deleted_at is null and l.import_job_id is null
         and l.created_at >= ((v_today - 1)::timestamp at time zone v_zone) and l.created_at <= v_now
         and (v_all or l.owner_id = p_user or l.team_id = any (v_teams.read_teams) or l.id = any (v_dep_lead));
    end if;
    -- SPD-02: open, not converted, not imported, no contact entry a person logged that is not private; SPD-01: a lead someone
    -- else took is left out but for owners, admins and the managers of its team
    select count(*) into v_waiting
      from public.leads l
      join public.lead_statuses st on st.organization_id = l.organization_id and st.id = l.status_id and st.kind = 'open'
     where l.organization_id = p_org and l.deleted_at is null and l.converted_at is null and l.import_job_id is null
       and (case when p_kind = 'personal' then l.owner_id = p_user
                 else (v_all or l.owner_id = p_user or l.team_id = any (v_teams.read_teams) or l.id = any (v_dep_lead)) end)
       and (l.taken_at is null or l.owner_id = p_user or v_role in ('owner', 'admin')
            or (v_role = 'manager' and l.team_id = any (v_teams.managed)))
       and not exists (
         select 1 from public.activities a
          where a.organization_id = l.organization_id and a.lead_id = l.id
            and a.created_by is not null and a.type = any (app.contact_types())
            and not a.is_private);
  end if;

  -- open tasks past their due time: the person's own, or (manager) every task the person reads
  select count(*) into v_overdue from public.tasks t
   where t.organization_id = p_org and t.status = 'open' and t.deleted_at is null and t.due_at < v_now
     and (case when p_kind = 'personal' then t.owner_id = p_user
               else (v_all or t.owner_id = p_user or t.team_id = any (v_teams.read_teams) or t.created_by = p_user
                     or t.id = any (v_dep_task)
                     -- TASK-07: an open team task nobody took, for the team's members (not a viewer, not a call-back)
                     or (t.owner_id is null and t.team_id is not null and v_role <> 'viewer'
                         and t.team_id = any (v_teams.member_teams)
                         and not exists (select 1 from app.intake_callback_tasks ct
                                          where ct.organization_id = t.organization_id and ct.task_id = t.id))) end);
  -- the person's own open tasks still ahead today
  select count(*) into v_today_tasks from public.tasks t
   where t.organization_id = p_org and t.status = 'open' and t.deleted_at is null and t.owner_id = p_user
     and t.due_at >= v_now and t.due_at < ((v_today + 1)::timestamp at time zone v_zone);

  -- MNY-01's money waiting, for the manager's summary, with the plan's key
  if p_kind = 'manager' and app.org_has_feature(p_org, 'money_waiting') then
    v_rate := app.org_document_vat_rate(p_org, v_today);
    v_mode := case when v_rate is null then 'unknown' when v_rate = 0 then 'none' else 'included' end;
    v_quotes := app.org_has_feature(p_org, 'quotes');
    v_debts := app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments') and v_role in ('owner', 'admin');
    with rd as (
      select d.* from public.deals d
       where d.organization_id = p_org
         and (v_all or d.owner_id = p_user or d.team_id = any (v_teams.read_teams) or d.id = any (v_dep_deal))
    ), rc as (
      select c.id, c.deleted_at from public.contacts c
       where c.organization_id = p_org
         and (v_all or c.owner_id = p_user or c.team_id = any (v_teams.read_teams) or c.id = any (v_dep_contact))
    ), q_all as (
      select q.id, q.deal_id,
             case when v_mode = 'unknown' then q.net_total_agorot else q.total_agorot end as value
        from public.quotes q
       where q.organization_id = p_org and v_quotes
         and q.status in ('sent', 'viewed') and q.sent_at is not null and q.customer_deleted_at is null
         and (q.valid_until is null or q.valid_until >= v_today)
         and not exists (select 1 from public.quotes n
                          where n.organization_id = q.organization_id and n.previous_id = q.id and n.sent_at is not null)
         and (case when q.deal_id is not null then
                exists (select 1 from rd d where d.id = q.deal_id and d.deleted_at is null and d.status <> 'lost')
              else
                exists (select 1 from rc k where k.id = q.contact_id and k.deleted_at is null)
              end)
    ), q_deals as (
      select distinct deal_id from q_all where deal_id is not null
    ), att as (
      select x.* from (
        select a.id, a.stuck, app.money_with_vat(a.amount_agorot, v_rate) as amount,
               (d.expected_close_date is not null and d.expected_close_date < v_today
                and (d.snoozed_until is null or d.snoozed_until <= v_today)) as overdue
          from app.deal_attention_rows(p_org, null, null, 14, null) a
          join rd d on d.id = a.id
      ) x
       where (x.stuck or x.overdue) and x.id not in (select deal_id from q_deals)
    ), r_rows as (
      select app.money_with_vat(d.recurring_amount_agorot, v_rate) as amount
        from rd d
       where d.deleted_at is null and d.status in ('open', 'won')
         and d.billing_kind is not null and d.renewal_date is not null
         and d.renewal_date >= v_today and d.renewal_date <= v_today + 30
         and not exists (select 1 from rd f where f.previous_deal_id = d.id and f.deleted_at is null)
         and d.id not in (select deal_id from q_deals)
         and d.id not in (select id from att)
    ), debt_docs as (
      select d.id
        from public.accounting_documents d
       where d.organization_id = p_org and v_debts
         and d.status = 'active' and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
         and d.amount_agorot > 0 and d.due_date is not null and d.due_date < v_today
         and not (d.doc_type = 'proforma'
                  and exists (select 1 from public.accounting_documents i
                               where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
         and coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                        where a.organization_id = d.organization_id and a.document_id = d.id
                          and a.released_at is null and a.removed_at is null), 0)
             + coalesce((select sum(o.amount_agorot) from public.opening_credit_allocations o
                          where o.organization_id = d.organization_id and o.document_id = d.id
                            and o.released_at is null and o.removed_at is null), 0)
             < d.amount_agorot
    ), debt_state as (
      select coalesce((x ->> 'balance')::bigint, 0) as balance
        from jsonb_array_elements(
               case when v_debts then
                 public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from debt_docs), '{}'::uuid[])
                   -> 'documents'
               else '[]'::jsonb end) x
    )
    select jsonb_build_object(
      'vat_mode', v_mode,
      'groups', jsonb_build_object(
        'debts', case when v_debts then (select coalesce(sum(balance), 0) from debt_state where balance > 0) end,
        'quotes', case when v_quotes then (select coalesce(sum(value), 0) from q_all) end,
        'stuck', (select coalesce(sum(amount), 0) from att where stuck),
        'overdue', (select coalesce(sum(amount), 0) from att where overdue and not stuck),
        'renewals', (select coalesce(sum(amount), 0) from r_rows)))
      into v_money;
  end if;

  return jsonb_build_object(
    'reads_anything', true,
    'new_leads', v_new,
    'waiting_leads', v_waiting,
    'overdue_tasks', v_overdue,
    'tasks_today', v_today_tasks,
    'money', v_money);
end;
$$;
revoke all on function app.digest_counts(uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The stop link (owner (377) ב)
-- ----------------------------------------------------------------------------
create table if not exists app.digest_stop_tokens (
  token_hash        text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  user_id           uuid not null,
  job_id            uuid,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '30 days',
  used_at           timestamptz,
  window_started_at timestamptz,
  window_count      integer not null default 0,
  -- review 4: the token in plain form, kept only while its job may still be tried (so every try sends the same email, and
  -- Resend's Idempotency-Key, the job id, always meets the same body); cleared by app.digest_clear_plain_tokens once the job
  -- has ended. Schema app, no grants: no API role reads it.
  plain_token       text
);
alter table app.digest_stop_tokens add column if not exists plain_token text;
create unique index if not exists digest_stop_tokens_job_idx on app.digest_stop_tokens (job_id) where job_id is not null;
create index if not exists digest_stop_tokens_plain_idx on app.digest_stop_tokens (job_id) where plain_token is not null;
create index if not exists digest_stop_tokens_person_idx on app.digest_stop_tokens (organization_id, user_id);
create index if not exists digest_stop_tokens_expires_idx on app.digest_stop_tokens (expires_at);
alter table app.digest_stop_tokens enable row level security;
revoke all on app.digest_stop_tokens from public, anon, authenticated, service_role;

-- calls per sender across every stop link (keyed IP hash buckets; no hash is kept)
create table if not exists app.digest_stop_counts (
  bucket       integer primary key check (bucket between 0 and 4095),
  window_start timestamptz not null default now(),
  hits         integer not null default 0
);
alter table app.digest_stop_counts enable row level security;
revoke all on app.digest_stop_counts from public, anon, authenticated, service_role;

-- The stop token of one job (48 random bytes from three UUIDs, base64url: 64 characters): made on the job's first try and
-- answered again on every later try of the same job; its SHA-256 is what the link is checked against, and the plain form is
-- kept only while the job may still be tried.
create or replace function app.digest_stop_token_issue(p_org uuid, p_user uuid, p_job uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text;
  v_used timestamptz;
begin
  select t.plain_token, t.used_at into v_token, v_used from app.digest_stop_tokens t
   where t.job_id = p_job and t.organization_id = p_org and t.user_id = p_user and t.plain_token is not null;
  -- delta review (2): the person used a stop link since this job's first try: its link is dead, so nothing is sent (the
  -- composer answers token_gone)
  if v_used is not null then
    return null;
  end if;
  if v_token is not null then
    return v_token;
  end if;
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  insert into app.digest_stop_tokens (token_hash, organization_id, user_id, job_id, plain_token)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_org, p_user, p_job, v_token)
  on conflict (job_id) where job_id is not null do nothing;
  if not found then
    -- the job's token was made already and its plain form cleared (the job had ended): never a second token for one job
    return null;
  end if;
  return v_token;
end;
$$;
revoke all on function app.digest_stop_token_issue(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Clears the plain form of every stop token whose job has ended (done, dead, refused) or is gone, whose token has expired, or
-- whose job's day is before today in the business's zone (the composer refuses such a job as expired anyway); an update,
-- never a delete.
create or replace function app.digest_clear_plain_tokens() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update app.digest_stop_tokens t set plain_token = null
   where t.plain_token is not null
     and (t.expires_at <= now()
          or not exists (
            select 1 from app.jobs j
              join public.organizations o on o.id = j.organization_id
             where j.id = t.job_id and j.status in ('queued', 'running', 'failed')
               and coalesce(j.payload ->> 'day', '') >= to_char((now() at time zone app.intake_zone(o.timezone))::date, 'YYYY-MM-DD')));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.digest_clear_plain_tokens() from public, anon, authenticated, service_role;

-- The stop page and route: one function, service_role only. p_stop false = the page (reads only); true = the stop.
-- Answers {status: not_found}, {rate_limited: true}, or {status: active|stopped|used, business} (the display name only):
-- active = the summary is on and the link unused; stopped = the summary is off (whatever stopped it); used = this link stopped
-- it once and the person has switched it on again since (a used link changes nothing more).
-- Limits: 60 calls per sender (keyed IP hash, scope digest) across every stop link, counted first, and 30 per link, in 10
-- minutes. A token lives 30 days and stops once: after it is used (or the summary is off) the page says it is stopped.
create or replace function public.digest_stop(p_token text, p_ip_hash text default null, p_stop boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row app.digest_stop_tokens;
  v_bucket integer;
  v_hits integer;
  v_count integer;
  v_business text;
  v_enabled boolean;
  v_state text;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_ip_hash is not null and p_ip_hash ~ '^[0-9a-f]{64}$' then
    v_bucket := ((hashtextextended('digest:' || p_ip_hash, 0) % 4096) + 4096) % 4096;
    insert into app.digest_stop_counts as c (bucket, window_start, hits) values (v_bucket, now(), 1)
    on conflict (bucket) do update
      set window_start = case when c.window_start > now() - interval '10 minutes' then c.window_start else now() end,
          hits = case when c.window_start > now() - interval '10 minutes' then c.hits + 1 else 1 end
    returning c.hits into v_hits;
    if v_hits > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;
  select * into v_row from app.digest_stop_tokens t
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
   for update;
  if v_row.token_hash is null or v_row.expires_at <= now() then
    return jsonb_build_object('status', 'not_found');
  end if;
  select o.name into v_business from public.organizations o where o.id = v_row.organization_id and o.deleted_at is null;
  if v_business is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  update app.digest_stop_tokens t
     set window_started_at = case when t.window_started_at > now() - interval '10 minutes' then t.window_started_at else now() end,
         window_count = case when t.window_started_at > now() - interval '10 minutes' then t.window_count + 1 else 1 end
   where t.token_hash = v_row.token_hash
  returning t.window_count into v_count;
  if v_count > 30 then
    return jsonb_build_object('rate_limited', true);
  end if;
  select d.enabled into v_enabled from public.digest_settings d
   where d.organization_id = v_row.organization_id and d.user_id = v_row.user_id;
  if not coalesce(v_enabled, false) then
    v_state := 'stopped';
  elsif v_row.used_at is not null then
    v_state := 'used';
  else
    v_state := 'active';
  end if;
  if not p_stop or v_state <> 'active' then
    return jsonb_build_object('status', v_state, 'business', v_business);
  end if;
  update public.digest_settings d
     set enabled = false, stopped_by_link_at = now()
   where d.organization_id = v_row.organization_id and d.user_id = v_row.user_id and d.enabled;
  -- every open link of the person in this business is used up with it (one-time)
  update app.digest_stop_tokens t set used_at = now()
   where t.organization_id = v_row.organization_id and t.user_id = v_row.user_id and t.used_at is null;
  return jsonb_build_object('status', 'stopped', 'business', v_business);
end;
$$;
revoke all on function public.digest_stop(text, text, boolean) from public, anon, authenticated;
grant execute on function public.digest_stop(text, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- The worker's composer (owner (375) ב): one function, service_role only, on the job's live lease
-- ----------------------------------------------------------------------------
-- Answers {refused: stale} on a lease that is not this job's live one, {refused: <code>} when nothing may be sent (the worker
-- ends the job, nothing sent): business_closed (deleted, suspended, cancelled, waiting to be removed), feature_off (the plan
-- lacks daily_digest), not_member (no longer an active member), switched_off (the person's switch, or the stop link),
-- expired (the job's day is no longer the business's today), no_address. Else {to, business_name, day, kind, counts,
-- stop_token}: the person's sign-in email, the business's display name, the day, the summary kind by the CURRENT role, the
-- counts of app.digest_counts (null when the person reads nothing) and a new one-time stop token. No customer's name.
create or replace function public.digest_job_compose(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_org public.organizations;
  v_user uuid;
  v_role public.membership_role;
  v_enabled boolean;
  v_zone text;
  v_kind text;
  v_email text;
  v_counts jsonb;
  v_token text;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'digest.send' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if (v_job.payload ->> 'organization_id') is distinct from v_job.organization_id::text then
    return jsonb_build_object('refused', 'invalid');
  end if;
  v_user := (v_job.payload ->> 'user_id')::uuid;
  select * into v_org from public.organizations o where o.id = v_job.organization_id;
  if v_org.id is null or v_org.deleted_at is not null or app.org_status_closed(v_org.status) or app.org_deletion_pending(v_org.id) then
    return jsonb_build_object('refused', 'business_closed');
  end if;
  if not app.org_has_feature(v_org.id, 'daily_digest') then
    return jsonb_build_object('refused', 'feature_off');
  end if;
  select m.role into v_role from public.memberships m
   where m.organization_id = v_org.id and m.user_id = v_user and m.status = 'active';
  if v_role is null then
    return jsonb_build_object('refused', 'not_member');
  end if;
  select d.enabled into v_enabled from public.digest_settings d where d.organization_id = v_org.id and d.user_id = v_user;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('refused', 'switched_off');
  end if;
  v_zone := app.intake_zone(v_org.timezone);
  if (v_job.payload ->> 'day') is distinct from to_char((now() at time zone v_zone)::date, 'YYYY-MM-DD') then
    return jsonb_build_object('refused', 'expired');
  end if;
  select u.email into v_email from auth.users u where u.id = v_user;
  if not app.email_address_ok(v_email) then
    return jsonb_build_object('refused', 'no_address');
  end if;
  v_kind := app.digest_kind_for(v_role::text);
  v_token := app.digest_stop_token_issue(v_org.id, v_user, v_job.id);
  if v_token is null then
    return jsonb_build_object('refused', 'token_gone');
  end if;
  v_counts := app.digest_counts(v_org.id, v_user, v_kind, now());
  return jsonb_build_object(
    'to', v_email,
    'business_name', v_org.name,
    'day', v_job.payload ->> 'day',
    'kind', v_kind,
    'counts', case when coalesce((v_counts ->> 'reads_anything')::boolean, false) then v_counts end,
    'stop_token', v_token);
end;
$$;
revoke all on function public.digest_job_compose(uuid, uuid) from public, anon, authenticated;
grant execute on function public.digest_job_compose(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Cleanup: expired stop tokens and old once-a-day rows. The deletes live in the hand-pasted 021282
-- (app.digest_cleanup_rows); until it is pasted this is a no-op.
-- ----------------------------------------------------------------------------
create or replace function app.run_digest_cleanup() returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if to_regprocedure('app.digest_cleanup_rows()') is not null then
    execute 'select app.digest_cleanup_rows()';
  end if;
end;
$$;
revoke all on function app.run_digest_cleanup() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-digest-cleanup', '37 2 * * *', 'select app.run_digest_cleanup();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- public.plans_public: 021263's body plus 'daily_digest' (a built capability of PLAN_CAPABILITIES, after 'money_waiting')
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
              'booking_page', 'business_card', 'public_page', 'prefill_links', 'qr_codes', 'site_widget', 'money_waiting',
              'daily_digest',
              'instant_reply', 'goals', 'campaign_costs', 'punch_cards', 'recurring_billing', 'segments', 'auto_reassign',
              'lead_distribution', 'meta_leads', 'meeting_reminders', 'signatures', 'sms', 'review_requests', 'orders',
              'goals_per_rep', 'granular_permissions', 'view_seats', 'remove_built_with'
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

-- anon and authenticated only (owner, 11 November 2026), as before; test 01 names it beside health_check
revoke all on function public.plans_public() from public, anon, authenticated, service_role;
grant execute on function public.plans_public() to anon, authenticated;
