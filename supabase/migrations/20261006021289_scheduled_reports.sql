-- =============================================================================
-- RPT-03: a scheduled report by email, with a link only (OPS-04 job kind report.send)
-- =============================================================================
-- Owner (386) א (16 November 2026): the email holds ONLY the report's name, the period and a link to the report page with
-- the period in the address; never a number. The recipient opens the link with their own sign-in and sees what their own
-- rights allow (the report page and the report functions decide, as today). The owner approved the new job kind in the same
-- answer, under answer (55)'s conditions: ids and codes only in the queue, the worker's functions pinned by md5 (test 284),
-- its own "In use" line.
--
-- The lead's choices (16 November 2026), recorded in DECISIONS.md:
-- * Owners and admins of a writable business make, switch and remove schedules (app.is_admin); a recipient sees the schedules
--   they receive and may take themselves off one.
-- * No new plan key: a report's own availability holds (its plan key, the leads module, and for the reports that are not for
--   everyone, owners, admins and managers by role only as recipients).
-- * Recipients: active members of the business, 1..20 per schedule; 20 schedules per business; 200 report emails a business
--   day per business (the rest of that day's are not queued).
-- * Periods: a closed list, worked out on the business's day the job runs: yesterday | last_7 (the seven days before today) |
--   this_month (the first of the month to today) | last_month | last_30 (the thirty days before today). A report without a
--   period filter (the current state) has none.
-- * Frequency daily (business working days only, app.org_rest_day) or weekly (on its weekday, whatever that day is); a send
--   time on a quarter hour between 06:00 and 22:00 in the business's zone; queued from that time for three hours, once per
--   schedule, recipient and day; the job waits for the end of the recipient's quiet hours on the same day
--   (app.digest_run_at); nothing while the recipient is on leave.
--
-- What this file holds:
-- * app.scheduled_report_catalog(): the reports a schedule may name (mirrors src/features/reports/definitions.ts; unit test
--   report-schedules reads the block between the markers).
-- * public.report_schedules and public.report_schedule_recipients (new-table checklist; audited; no client update of a
--   recipient row), app.report_schedules_check / app.report_schedule_recipients_check (definer, outsider guard first).
-- * public.scheduled_report_create(...) (invoker): the schedule and its recipients in one call, all or nothing.
-- * app.job_kinds() gains 'report.send'; app.job_payload_ok() (021281's body, one more branch) takes exactly
--   {schedule_id, user_id, day}.
-- * app.queue_scheduled_reports(): pg_cron `crm-scheduled-reports` (every 15 minutes); nothing while no worker asked for
--   report.send in the last day.
-- * public.scheduled_report_compose(job, lease) (service_role, the live lease only) for the worker.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The reports a schedule may name
-- ----------------------------------------------------------------------------
-- has_period: the report takes a period filter; features: the plan keys it needs (all); restricted: only owners, admins
-- and managers by role receive it (a report about costs, balances or collection, or one marked for managers; review fix 6:
-- the cost reports categories, campaign_roi and profit too); module: the module that must be on; costs: a report about
-- costs, whose recipient must also see costs (app.can_view_costs's rule for that person, app.scheduled_report_user_may).
create or replace function app.scheduled_report_catalog()
returns table (report_key text, has_period boolean, features text[], restricted boolean, module text, costs boolean)
language sql immutable
set search_path = ''
as $$
  values
    -- scheduled-report-catalog
    ('sources', true, '{}'::text[], false, 'leads', false),
    ('funnel', true, '{}'::text[], false, null, false),
    ('response', true, '{}'::text[], false, 'leads', false),
    ('reps', true, '{}'::text[], false, null, false),
    ('activity', true, '{}'::text[], false, null, false),
    ('forecast', false, '{}'::text[], false, null, false),
    ('lost', true, '{}'::text[], false, null, false),
    ('cycle', true, '{}'::text[], false, null, false),
    ('stuck', false, '{}'::text[], false, null, false),
    ('revenue', true, '{}'::text[], false, null, false),
    ('source_revenue', true, '{}'::text[], false, null, false),
    ('campaign_roi', true, '{campaign_costs}'::text[], true, null, true),
    ('products', true, '{}'::text[], false, null, false),
    ('recurring', true, '{}'::text[], false, null, false),
    ('categories', true, '{}'::text[], true, null, true),
    ('profit', true, '{}'::text[], true, null, true),
    ('meetings', true, '{}'::text[], false, null, false),
    ('referrals', true, '{}'::text[], false, null, false),
    ('quotes', true, '{quotes}'::text[], false, null, false),
    ('debt_aging', false, '{balances,documents,payments}'::text[], true, null, false),
    ('collection', true, '{collection,documents,payments}'::text[], true, null, false),
    ('punch_cards', false, '{punch_cards}'::text[], true, null, false),
    ('recurring_billing', true, '{recurring_billing}'::text[], true, null, false)
    -- end scheduled-report-catalog
$$;
revoke all on function app.scheduled_report_catalog() from public, anon, authenticated, service_role;

-- the closed list of periods
create or replace function app.scheduled_report_periods() returns text[]
language sql immutable
set search_path = ''
as $$ select array['yesterday', 'last_7', 'this_month', 'last_month', 'last_30']::text[] $$;
revoke all on function app.scheduled_report_periods() from public, anon, authenticated, service_role;

-- a period's first and last day (both inclusive), worked out on the business's day p_today
create or replace function app.scheduled_report_period(p_period text, p_today date, out from_date date, out to_date date)
language sql immutable
set search_path = ''
as $$
  select case p_period
           when 'yesterday' then p_today - 1
           when 'last_7' then p_today - 7
           when 'this_month' then date_trunc('month', p_today)::date
           when 'last_month' then (date_trunc('month', p_today) - interval '1 month')::date
           when 'last_30' then p_today - 30
         end,
         case p_period
           when 'yesterday' then p_today - 1
           when 'last_7' then p_today - 1
           when 'this_month' then p_today
           when 'last_month' then (date_trunc('month', p_today) - interval '1 day')::date
           when 'last_30' then p_today - 1
         end
$$;
revoke all on function app.scheduled_report_period(text, date) from public, anon, authenticated, service_role;

-- every plan key the report needs, and its module
create or replace function app.scheduled_report_available(p_org uuid, p_report text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row record;
  v_key text;
begin
  select * into v_row from app.scheduled_report_catalog() c where c.report_key = p_report;
  if v_row.report_key is null then
    return false;
  end if;
  foreach v_key in array v_row.features loop
    if not app.org_has_feature(p_org, v_key) then
      return false;
    end if;
  end loop;
  if v_row.module = 'leads' and not app.org_leads_enabled(p_org) then
    return false;
  end if;
  return true;
end;
$$;
revoke all on function app.scheduled_report_available(uuid, text) from public, anon, authenticated, service_role;

-- may this person (an active member) receive the report: restricted = owners, admins and managers by role; costs = also
-- app.can_view_costs's rule for that person (owner/admin/manager by role, or the PRM-01 grant view_costs with the plan key)
create or replace function app.scheduled_report_user_may(p_org uuid, p_user uuid, p_report text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row record;
  v_role public.membership_role;
begin
  select * into v_row from app.scheduled_report_catalog() c where c.report_key = p_report;
  if v_row.report_key is null then
    return false;
  end if;
  select m.role into v_role from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_role is null then
    return false;
  end if;
  if v_row.restricted and v_role not in ('owner', 'admin', 'manager') then
    return false;
  end if;
  if v_row.costs and v_role not in ('owner', 'admin', 'manager')
     and not (v_role in ('manager', 'member') and app.org_has_feature(p_org, 'granular_permissions')
              and exists (select 1 from public.member_permissions mp
                           where mp.organization_id = p_org and mp.user_id = p_user
                             and 'view_costs' = any (mp.permissions))) then
    return false;
  end if;
  return true;
end;
$$;
revoke all on function app.scheduled_report_user_may(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The schedules and their recipients
-- ----------------------------------------------------------------------------
create table if not exists public.report_schedules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  report_key      text not null,
  period          text,
  frequency       text not null default 'weekly',
  -- weekly only: 0 = Sunday .. 6 = Saturday (extract(dow))
  weekday         smallint,
  send_at         time not null default '08:00',
  enabled         boolean not null default true,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint report_schedules_frequency check (frequency in ('daily', 'weekly')),
  constraint report_schedules_weekday check (
    (frequency = 'weekly') = (weekday is not null) and (weekday is null or weekday between 0 and 6)),
  constraint report_schedules_period check (
    period is null or period in ('yesterday', 'last_7', 'this_month', 'last_month', 'last_30')),
  constraint report_schedules_send_at check (
    send_at >= '06:00'::time and send_at <= '22:00'::time
    and extract(second from send_at) = 0 and (extract(minute from send_at))::int % 15 = 0)
);
comment on table public.report_schedules is
  'RPT-03 (386) א: a report sent by email on a schedule, with a link only (no numbers in the email).';

create table if not exists public.report_schedule_recipients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  schedule_id     uuid not null,
  user_id         uuid not null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (schedule_id, user_id),
  foreign key (organization_id, schedule_id) references public.report_schedules (organization_id, id) on delete cascade,
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);
create index if not exists report_schedule_recipients_schedule_idx
  on public.report_schedule_recipients (organization_id, schedule_id);
create index if not exists report_schedule_recipients_user_idx
  on public.report_schedule_recipients (organization_id, user_id);

create or replace trigger report_schedules_touch before insert or update on public.report_schedules
  for each row execute function app.touch_row();
create or replace trigger report_schedules_audit after insert or update or delete on public.report_schedules
  for each row execute function app.audit_row();
create or replace trigger report_schedule_recipients_audit after insert or update or delete on public.report_schedule_recipients
  for each row execute function app.audit_row();

alter table public.report_schedules enable row level security;
alter table public.report_schedule_recipients enable row level security;
revoke all on public.report_schedules from public, anon, authenticated;
revoke all on public.report_schedule_recipients from public, anon, authenticated;
grant select, delete on public.report_schedules to authenticated;
grant insert (organization_id, report_key, period, frequency, weekday, send_at, enabled) on public.report_schedules to authenticated;
grant update (period, frequency, weekday, send_at, enabled) on public.report_schedules to authenticated;
grant select, delete on public.report_schedule_recipients to authenticated;
grant insert (organization_id, schedule_id, user_id) on public.report_schedule_recipients to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_select') then
    -- owners and admins see every schedule; a member sees the ones they receive
    create policy report_schedules_select on public.report_schedules for select to authenticated
      using (app.is_admin(organization_id)
             or (app.is_member(organization_id)
                 and exists (select 1 from public.report_schedule_recipients r
                              where r.organization_id = report_schedules.organization_id
                                and r.schedule_id = report_schedules.id
                                and r.user_id = (select auth.uid()))));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_insert') then
    create policy report_schedules_insert on public.report_schedules for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_update') then
    create policy report_schedules_update on public.report_schedules for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedules' and policyname = 'report_schedules_delete') then
    -- removing a schedule is the safe side: allowed also while the business cannot write
    create policy report_schedules_delete on public.report_schedules for delete to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedule_recipients' and policyname = 'report_schedule_recipients_select') then
    create policy report_schedule_recipients_select on public.report_schedule_recipients for select to authenticated
      using (app.is_admin(organization_id) or (user_id = (select auth.uid()) and app.is_member(organization_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedule_recipients' and policyname = 'report_schedule_recipients_insert') then
    create policy report_schedule_recipients_insert on public.report_schedule_recipients for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_schedule_recipients' and policyname = 'report_schedule_recipients_delete') then
    -- an owner or admin takes anyone off; a member takes themselves off
    create policy report_schedule_recipients_delete on public.report_schedule_recipients for delete to authenticated
      using (app.is_admin(organization_id) or (user_id = (select auth.uid()) and app.is_member(organization_id)));
  end if;
end;
$$;

-- the schedule's rules (definer: it counts the business's schedules and reads its plan)
create or replace function app.report_schedules_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  -- RVW-23: an outsider gets RLS's plain 42501 and learns nothing about another business
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- insert-only and server-only columns keep their values for every writer
    new.organization_id := old.organization_id;
    new.report_key := old.report_key;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  elsif auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  select * into v_row from app.scheduled_report_catalog() c where c.report_key = new.report_key;
  if v_row.report_key is null then
    raise exception 'not a report a schedule may send' using errcode = 'P0001', hint = 'report_schedule:report';
  end if;
  if not v_row.has_period then
    new.period := null;
  elsif new.period is null then
    raise exception 'a period is needed' using errcode = 'P0001', hint = 'report_schedule:period';
  end if;
  -- the report's own availability, judged on a new schedule and when one is switched on
  if tg_op = 'INSERT' or (new.enabled and not old.enabled) then
    if not app.scheduled_report_available(new.organization_id, new.report_key) then
      raise exception 'the report is not available in this business' using errcode = 'P0001', hint = 'report_schedule:unavailable';
    end if;
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('report_schedules:' || new.organization_id::text, 0));
    if (select count(*) from public.report_schedules s where s.organization_id = new.organization_id) >= 20 then
      raise exception 'too many scheduled reports' using errcode = 'P0001', hint = 'report_schedules:max';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.report_schedules_check() from public, anon, authenticated;

create or replace trigger report_schedules_check before insert or update on public.report_schedules
  for each row execute function app.report_schedules_check();

-- a recipient: an active member; for a restricted report an owner, admin or manager; 20 per schedule
create or replace function app.report_schedule_recipients_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_report text;
  v_role public.membership_role;
begin
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  select s.report_key into v_report from public.report_schedules s
   where s.organization_id = new.organization_id and s.id = new.schedule_id
   for share;
  if v_report is null then
    -- the foreign key answers it
    return new;
  end if;
  select m.role into v_role from public.memberships m
   where m.organization_id = new.organization_id and m.user_id = new.user_id and m.status = 'active';
  if v_role is null then
    raise exception 'a recipient is an active member' using errcode = 'P0001', hint = 'report_schedule:recipient';
  end if;
  if not app.scheduled_report_user_may(new.organization_id, new.user_id, v_report) then
    raise exception 'this report goes to owners, admins and managers' using errcode = 'P0001', hint = 'report_schedule:recipient_role';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('report_schedule_recipients:' || new.schedule_id::text, 0));
  if (select count(*) from public.report_schedule_recipients r where r.schedule_id = new.schedule_id) >= 20 then
    raise exception 'too many recipients' using errcode = 'P0001', hint = 'report_schedule:recipients_max';
  end if;
  return new;
end;
$$;
revoke all on function app.report_schedule_recipients_check() from public, anon, authenticated;

create or replace trigger report_schedule_recipients_check before insert on public.report_schedule_recipients
  for each row execute function app.report_schedule_recipients_check();

-- one call: the schedule and its recipients, all or nothing (invoker: RLS and the triggers decide)
create or replace function public.scheduled_report_create(
  p_org uuid,
  p_report text,
  p_period text,
  p_frequency text,
  p_weekday smallint,
  p_send_at time,
  p_recipients uuid[]
) returns uuid
language plpgsql volatile
set search_path = ''
as $$
declare
  v_id uuid;
  v_user uuid;
begin
  if p_recipients is null or cardinality(p_recipients) = 0 then
    raise exception 'at least one recipient' using errcode = 'P0001', hint = 'report_schedule:recipients';
  end if;
  if cardinality(p_recipients) > 20 then
    raise exception 'too many recipients' using errcode = 'P0001', hint = 'report_schedule:recipients_max';
  end if;
  insert into public.report_schedules (organization_id, report_key, period, frequency, weekday, send_at)
  values (p_org, p_report, p_period, p_frequency, case when p_frequency = 'weekly' then p_weekday end, p_send_at)
  returning id into v_id;
  for v_user in select distinct u from unnest(p_recipients) u where u is not null order by 1 loop
    insert into public.report_schedule_recipients (organization_id, schedule_id, user_id) values (p_org, v_id, v_user);
  end loop;
  return v_id;
end;
$$;
revoke all on function public.scheduled_report_create(uuid, text, text, text, smallint, time, uuid[]) from public, anon;
grant execute on function public.scheduled_report_create(uuid, text, text, text, smallint, time, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- The job kind and its payload
-- ----------------------------------------------------------------------------
create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run', 'digest.send', 'report.send']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021283's body (QUO-18 quote_id), plus report.send (owner (386) א): exactly {schedule_id, user_id, day}
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
                               'collection_document_id', 'review_request_id', 'quote_id'))
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
      -- QUO-18: the quote a requested_document is (the sender re-reads it and mints its link); to a contact, by email or SMS,
      -- with no files, rule, button, sender check or other subject
      and (not (p_payload ? 'quote_id')
           or (jsonb_typeof(p_payload -> 'quote_id') = 'string'
               and (p_payload ->> 'quote_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and (p_payload ->> 'message_type') is not distinct from 'requested_document'
               and p_payload ? 'contact_id'
               and (p_payload ->> 'channel') in ('email', 'sms')
               and not (p_payload ?| array['deal_id', 'file_ids', 'library_file_ids', 'automation_id', 'pressed_by_user_id',
                                           'sender_check_id', 'signature_document_id', 'collection_document_id',
                                           'form_submission_id', 'review_request_id', 'punch_card_id', 'meeting_id'])))
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
    -- RPT-03 (owner (386) א): the schedule, the recipient and the business day, nothing else
    when p_kind = 'report.send' then
      coalesce(
        coalesce((select bool_and(k in ('schedule_id', 'user_id', 'day')) from jsonb_object_keys(p_payload) k), false)
        and (select count(*) from jsonb_object_keys(p_payload)) = 3
        and jsonb_typeof(p_payload -> 'schedule_id') = 'string'
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and jsonb_typeof(p_payload -> 'day') = 'string'
        and (p_payload ->> 'schedule_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'day') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
        false)
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Once per schedule, recipient and day
-- ----------------------------------------------------------------------------
create table if not exists app.report_schedule_sends (
  -- review fix 4: no foreign key to the schedule, so removing a schedule never gives its day's sends back (the 200 a day
  -- cap and "once per schedule, recipient and day" hold); the rows go with the business
  schedule_id     uuid not null,
  user_id         uuid not null,
  day             date not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  job_id          uuid,
  queued_at       timestamptz not null default now(),
  primary key (schedule_id, user_id, day)
);
create index if not exists report_schedule_sends_org_day_idx on app.report_schedule_sends (organization_id, day);
alter table app.report_schedule_sends enable row level security;
revoke all on app.report_schedule_sends from public, anon, authenticated, service_role;

-- the most report emails one business gets a business day
create or replace function app.report_schedule_day_cap() returns integer
language sql immutable
set search_path = ''
as $$ select 200 $$;
revoke all on function app.report_schedule_day_cap() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The cron: one job per schedule, recipient and business day
-- ----------------------------------------------------------------------------
create or replace function app.queue_scheduled_reports(p_limit integer default 2000, p_now timestamptz default null)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 0), 2000);
  v_row record;
  v_rcpt record;
  v_job uuid;
  v_queued integer := 0;
begin
  -- no worker sends this kind yet: queue nothing (a job nobody claims would only wait)
  if not exists (select 1 from app.job_kind_seen s
                  where s.kind = 'report.send' and s.last_claimed_at > now() - interval '1 day') then
    return 0;
  end if;
  for v_row in
    select s.id, s.organization_id, s.report_key, s.frequency, s.weekday, s.send_at, z.zone,
           (v_now at time zone z.zone)::date as local_day,
           (v_now at time zone z.zone)::time as local_time
      from public.report_schedules s
      join public.organizations o on o.id = s.organization_id
      cross join lateral (select app.intake_zone(o.timezone) as zone) z
     where s.enabled
       and o.deleted_at is null
       and not app.org_status_closed(o.status)
       and not app.org_deletion_pending(o.id)
     order by s.organization_id, s.id
  loop
    exit when v_queued >= v_limit;
    -- from the chosen time, for three hours; time - time is an interval that never wraps past midnight (review fix 2: a
    -- send time of 21:00..22:00 would wrap with time + interval)
    continue when v_row.local_time < v_row.send_at or (v_row.local_time - v_row.send_at) >= interval '3 hours';
    -- weekly: on its weekday; daily: on the business's working days
    continue when v_row.frequency = 'weekly' and extract(dow from v_row.local_day)::int <> v_row.weekday;
    begin
      continue when v_row.frequency = 'daily' and app.org_rest_day(v_row.organization_id, v_row.local_day);
      continue when not app.scheduled_report_available(v_row.organization_id, v_row.report_key);
      -- one business at a time counts its day's cap
      perform pg_advisory_xact_lock(hashtextextended('report_schedule_sends:' || v_row.organization_id::text, 0));
      for v_rcpt in
        select r.user_id from public.report_schedule_recipients r
          join public.memberships m on m.organization_id = r.organization_id and m.user_id = r.user_id and m.status = 'active'
         where r.organization_id = v_row.organization_id and r.schedule_id = v_row.id
           and app.scheduled_report_user_may(v_row.organization_id, r.user_id, v_row.report_key)
           and not exists (select 1 from app.report_schedule_sends x
                            where x.schedule_id = v_row.id and x.user_id = r.user_id and x.day = v_row.local_day)
         order by r.user_id
      loop
        exit when v_queued >= v_limit;
        exit when (select count(*) from app.report_schedule_sends x
                    where x.organization_id = v_row.organization_id and x.day = v_row.local_day) >= app.report_schedule_day_cap();
        continue when app.member_on_leave(v_row.organization_id, v_rcpt.user_id, v_now);
        insert into app.report_schedule_sends (schedule_id, user_id, day, organization_id)
        values (v_row.id, v_rcpt.user_id, v_row.local_day, v_row.organization_id)
        on conflict do nothing;
        continue when not found;
        v_job := app.enqueue_job(v_row.organization_id, 'report.send',
                   jsonb_build_object('schedule_id', v_row.id::text, 'user_id', v_rcpt.user_id::text,
                                      'day', to_char(v_row.local_day, 'YYYY-MM-DD')),
                   app.digest_run_at(v_rcpt.user_id, v_row.zone, v_now));
        update app.report_schedule_sends x set job_id = v_job
         where x.schedule_id = v_row.id and x.user_id = v_rcpt.user_id and x.day = v_row.local_day;
        v_queued := v_queued + 1;
      end loop;
    exception when others then
      raise warning 'scheduled report not queued (%): %', v_row.organization_id, sqlstate;
    end;
  end loop;
  return v_queued;
end;
$$;
revoke all on function app.queue_scheduled_reports(integer, timestamptz) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-scheduled-reports', '*/15 * * * *', 'select app.queue_scheduled_reports();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The worker's composer: one function, service_role only, on the job's live lease
-- ----------------------------------------------------------------------------
-- Answers {refused: stale} on a lease that is not this job's live one, {refused: <code>} when nothing may be sent (the worker
-- ends the job, nothing sent): invalid, business_closed (deleted, suspended, cancelled, waiting to be removed), schedule_gone,
-- switched_off, unavailable (the report's plan key or module is off), not_member, not_recipient, not_allowed (a restricted
-- report and the recipient is no longer an owner, admin or manager), expired (the job's day is no longer the business's
-- today), no_address. Else {to, business_name, terms, report_key, period, from_date, to_date, day}: the recipient's sign-in
-- email, the business's display name, its FLD-10 term keys (org_terms), the report's key, the period's code and its days (null for a report without a period) and the
-- day. NO number of any report: the recipient opens the link and the report is computed then, with their own session.
create or replace function public.scheduled_report_compose(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_org public.organizations;
  v_schedule public.report_schedules;
  v_user uuid;
  v_role public.membership_role;
  v_zone text;
  v_today date;
  v_email text;
  v_from date;
  v_to date;
  v_terms jsonb;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'report.send' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if not app.job_payload_ok('report.send', v_job.payload) then
    return jsonb_build_object('refused', 'invalid');
  end if;
  v_user := (v_job.payload ->> 'user_id')::uuid;
  select * into v_org from public.organizations o where o.id = v_job.organization_id;
  if v_org.id is null or v_org.deleted_at is not null or app.org_status_closed(v_org.status) or app.org_deletion_pending(v_org.id) then
    return jsonb_build_object('refused', 'business_closed');
  end if;
  select * into v_schedule from public.report_schedules s
   where s.organization_id = v_org.id and s.id = (v_job.payload ->> 'schedule_id')::uuid;
  if v_schedule.id is null then
    return jsonb_build_object('refused', 'schedule_gone');
  end if;
  if not v_schedule.enabled then
    return jsonb_build_object('refused', 'switched_off');
  end if;
  if not app.scheduled_report_available(v_org.id, v_schedule.report_key) then
    return jsonb_build_object('refused', 'unavailable');
  end if;
  select m.role into v_role from public.memberships m
   where m.organization_id = v_org.id and m.user_id = v_user and m.status = 'active';
  if v_role is null then
    return jsonb_build_object('refused', 'not_member');
  end if;
  if not exists (select 1 from public.report_schedule_recipients r
                  where r.organization_id = v_org.id and r.schedule_id = v_schedule.id and r.user_id = v_user) then
    return jsonb_build_object('refused', 'not_recipient');
  end if;
  -- restricted reports: owners, admins and managers by role; cost reports: also whoever sees costs (review fix 6)
  if not app.scheduled_report_user_may(v_org.id, v_user, v_schedule.report_key) then
    return jsonb_build_object('refused', 'not_allowed');
  end if;
  v_zone := app.intake_zone(v_org.timezone);
  v_today := (now() at time zone v_zone)::date;
  if (v_job.payload ->> 'day') is distinct from to_char(v_today, 'YYYY-MM-DD') then
    return jsonb_build_object('refused', 'expired');
  end if;
  select u.email into v_email from auth.users u where u.id = v_user;
  if not app.email_address_ok(v_email) then
    return jsonb_build_object('refused', 'no_address');
  end if;
  if v_schedule.period is not null then
    select p.from_date, p.to_date into v_from, v_to from app.scheduled_report_period(v_schedule.period, v_today) p;
  end if;
  -- delta review 4: the report's name in the business's own words (FLD-10, org_terms; no row = today's words)
  select jsonb_build_object('contact_term', t.contact_term, 'lead_term', t.lead_term, 'deal_term', t.deal_term) into v_terms
    from public.org_terms t where t.organization_id = v_org.id;
  return jsonb_build_object(
    'to', v_email,
    'business_name', v_org.name,
    'terms', coalesce(v_terms, '{}'::jsonb),
    'report_key', v_schedule.report_key,
    'period', v_schedule.period,
    'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') end,
    'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') end,
    'day', v_job.payload ->> 'day');
end;
$$;
revoke all on function public.scheduled_report_compose(uuid, uuid) from public, anon, authenticated;
grant execute on function public.scheduled_report_compose(uuid, uuid) to service_role;
