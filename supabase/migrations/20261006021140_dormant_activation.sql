-- =============================================================================
-- RET-01 follow-up: ask before running a dormant rule on customers already dormant (owner, 2 November 2026, answer (64) ג)
-- =============================================================================
-- When a "customer became dormant" rule is switched on in a business that already has dormant customers, the screen asks
-- "יש כבר N לקוחות רדומים. להריץ את הכלל גם עליהם?" (unticked by default). Yes = one run over them, counted in the
-- automation quota (AUT-07) and logged in the audit log with the count; no = only customers who become dormant from the
-- moment the rule is switched on.
-- * automations.dormant_from (date) and automations.dormant_from_months (integer), server only (no client column grant): the
--   business-zone day on which a customer_dormant rule was switched on (inserted active, is_active false -> true, or an
--   active rule's trigger changed into customer_dormant) and the dormant months in force that day
--   (app.customer_status_months), both set by the BEFORE trigger automations_dormant_from (definer: it reads the business's
--   time zone and settings). Any other write keeps the values it is given (clients cannot name the columns; a server write
--   may move them on purpose).
-- * "Already dormant when switched on" = last purchase + dormant_from_months is before dormant_from (app.dormant_day). The
--   scan (app.scheduled_customer_dormant, body of 021139 with the start point) skips those, so a customer who became dormant
--   only because the dormant months were lowered later is still run by the scan. A rule without a start point counts from
--   the business's today with today's months. A customer whose dormancy day equals the switch-on day is run by the scan and
--   is not in the question (day granularity, accepted).
-- * public.dormant_customer_count(org, kind): the number of customers dormant now whose dormancy day (today's months) is
--   before the business's today. app.can_manage_automations only (42501 otherwise): owners, admins and the PRM-01
--   manage_automations grantees, who see automations organization-wide anyway (option א, accepted).
-- * public.run_dormant_backfill(org, automation): the opt-in run. app.can_manage_automations and a writable business; an
--   active customer_dormant rule of that business. Runs the rule through app.execute_automation (so AUT-07 counts every run
--   and its quota skip applies; conditions are checked) with the scan's run key dormant:<id>:<last purchase>, so a customer is
--   never run twice, over the customers dormant now who were already dormant when the rule was switched on. Each call is
--   short (it holds the business's AUT-07 month row): at most 200 executed runs (app.dormant_backfill_runs_cap()) and 500
--   rows examined (app.dormant_backfill_rows_cap(), every row reached counts); both caps can only be lowered per
--   transaction (tests). It continues from its own cursor (app.dormant_backfills.after_id, in id order); `more` asks for
--   another call (the screen's "להמשיך"). One audit entry per call (action dormant_backfill, the counts). Once the cursor
--   reaches the end of the list the start point is done, and a later call for it answers {ok:false, reason:'done'}. A run
--   skipped by the monthly quota stops the call ({quota:true}) without finishing; the skipped customer keeps its skipped run
--   (AUT-07's rule).
-- * The advisor's findings on the two new definer functions granted to authenticated (dormant_customer_count,
--   run_dormant_backfill) are expected: they check app.can_manage_automations first and answer counts only.
-- * app.automation_run_facts and app.automation_event_still_holds are unchanged.
-- Safe to run twice. No drops, no row removal, no data changes (hosted has no customer_dormant rule: checked read-only).

alter table public.automations add column if not exists dormant_from date;
alter table public.automations add column if not exists dormant_from_months integer;

-- the business's today (its own zone, as the scan reads it)
create or replace function app.org_zone_today(p_org uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select (now() at time zone coalesce((select app.intake_zone(o.timezone) from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date
$$;
revoke all on function app.org_zone_today(uuid) from public, anon, authenticated, service_role;

create or replace function app.automations_dormant_from() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.trigger_type = 'customer_dormant' and new.is_active
     and (tg_op = 'INSERT' or not old.is_active or old.trigger_type is distinct from 'customer_dormant') then
    new.dormant_from := app.org_zone_today(new.organization_id);
    new.dormant_from_months := (select m.dormant_months from app.customer_status_months(new.organization_id) m);
  end if;
  return new;
end;
$$;
revoke all on function app.automations_dormant_from() from public, anon, authenticated, service_role;

create or replace trigger automations_dormant_from before insert or update on public.automations
  for each row execute function app.automations_dormant_from();

-- the day a customer became dormant, by today's thresholds (the dormant_on fact of app.automation_run_facts)
create or replace function app.dormant_day(p_last date, p_months integer) returns date
language sql immutable
set search_path = ''
as $$ select (p_last + make_interval(months => p_months))::date $$;
revoke all on function app.dormant_day(date, integer) from public, anon, authenticated, service_role;

-- which start point a backfill finished for (no grants)
create table if not exists app.dormant_backfills (
  automation_id uuid primary key,
  organization_id uuid not null,
  dormant_from date not null,
  after_id uuid,
  runs integer not null default 0,
  done_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, automation_id) references public.automations (organization_id, id) on delete cascade
);
create index if not exists dormant_backfills_org_idx on app.dormant_backfills (organization_id, automation_id);
alter table app.dormant_backfills enable row level security;
revoke all on app.dormant_backfills from public, anon, authenticated, service_role;

-- the caps of one backfill call; a transaction may lower them (tests), never raise them
create or replace function app.dormant_backfill_runs_cap() returns integer
language sql stable
set search_path = ''
as $$ select least(200, greatest(1, coalesce(nullif(current_setting('app.dormant_backfill_runs_cap', true), '')::integer, 200))) $$;
revoke all on function app.dormant_backfill_runs_cap() from public, anon, authenticated, service_role;

create or replace function app.dormant_backfill_rows_cap() returns integer
language sql stable
set search_path = ''
as $$ select least(500, greatest(1, coalesce(nullif(current_setting('app.dormant_backfill_rows_cap', true), '')::integer, 500))) $$;
revoke all on function app.dormant_backfill_rows_cap() from public, anon, authenticated, service_role;

-- body of 20261006021139 with the start point
create or replace function app.scheduled_customer_dormant(p_auto public.automations, p_budget integer) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_local timestamp;
  v_after uuid;
  v_row record;
  v_key text;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_count integer := 0;
  v_months integer;
  v_from date;
begin
  if p_auto.entity_type not in ('contact', 'company') or p_budget <= 0 then
    return 0;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_auto.organization_id;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_local := now() at time zone v_zone;
  if extract(hour from v_local) < app.date_trigger_hour() then
    return 0;
  end if;
  -- RET-01 (64) ג: only customers who became dormant on or after the day the rule was switched on, by the dormant months
  -- in force that day (a later change of the months never hides a newly dormant customer)
  v_months := p_auto.dormant_from_months;
  if v_months is null then
    select m.dormant_months into v_months from app.customer_status_months(p_auto.organization_id) m;
  end if;
  v_from := coalesce(p_auto.dormant_from, v_local::date);
  select c.after_id into v_after from app.scan_cursor_get(p_auto) c;
  <<pages>>
  loop
    v_page := 0;
    -- only the customers dormant today, from the kept facts, by id from the cursor
    for v_row in
      select r.id, r.last_purchase_on from app.dormant_customer_rows(p_auto.organization_id, p_auto.entity_type, v_after, v_page_size) r
    loop
      v_page := v_page + 1;
      v_after := v_row.id;
      continue when app.dormant_day(v_row.last_purchase_on, v_months) < v_from;
      -- once per customer and last purchase: a change of the thresholds never runs the rule again for the same quiet spell
      v_key := 'dormant:' || v_row.id || ':' || v_row.last_purchase_on;
      continue when exists (select 1 from public.automation_runs r where r.automation_id = p_auto.id and r.run_key = v_key);
      if app.execute_automation(p_auto, v_row.id, v_key) is not null then
        v_count := v_count + 1;
      end if;
      if v_count >= p_budget then
        perform app.scan_cursor_set(p_auto, '-infinity', v_after);
        exit pages;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: the next pass starts again from the first customer
      perform app.scan_cursor_set(p_auto, '-infinity', '00000000-0000-0000-0000-000000000000');
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, '-infinity', v_after);
      exit;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.scheduled_customer_dormant(public.automations, integer) from public, anon, authenticated, service_role;

-- the question's number: customers dormant now who became dormant before the business's today
create or replace function public.dormant_customer_count(p_org uuid, p_kind text) returns integer
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_months integer;
  v_today date;
  v_count integer;
begin
  if p_kind is null or p_kind not in ('contact', 'company') then
    raise exception 'a contact or a company list' using errcode = '22023', hint = 'customer_status:kind';
  end if;
  if not app.can_manage_automations(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select m.dormant_months into v_months from app.customer_status_months(p_org) m;
  v_today := app.org_zone_today(p_org);
  select count(*)::integer into v_count
    from app.dormant_customer_rows(p_org, p_kind, null, 1000000) r
   where app.dormant_day(r.last_purchase_on, v_months) < v_today;
  return v_count;
end;
$$;
revoke all on function public.dormant_customer_count(uuid, text) from public, anon;
grant execute on function public.dormant_customer_count(uuid, text) to authenticated;

-- the opt-in run over the customers already dormant when the rule was switched on; short calls from a cursor
create or replace function public.run_dormant_backfill(p_org uuid, p_automation uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_state app.dormant_backfills%rowtype;
  v_months integer;
  v_runs_cap integer := app.dormant_backfill_runs_cap();
  v_rows_cap integer := app.dormant_backfill_rows_cap();
  v_after uuid := '00000000-0000-0000-0000-000000000000';
  v_row record;
  v_key text;
  v_status text;
  v_examined integer := 0;
  v_ran integer := 0;
  v_skipped integer := 0;
  v_quota boolean := false;
  v_more boolean := false;
begin
  if not app.can_manage_automations(p_org) or not app.org_writable(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the rule, locked: two calls for one rule wait for each other
  select a.* into v_auto from public.automations a
   where a.organization_id = p_org and a.id = p_automation for update;
  if not found then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_auto.trigger_type is distinct from 'customer_dormant' or v_auto.entity_type not in ('contact', 'company') then
    raise exception 'not a dormant customer rule' using errcode = '22023', hint = 'dormant_backfill:rule';
  end if;
  if not v_auto.is_active or v_auto.dormant_from is null then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  select * into v_state from app.dormant_backfills b where b.automation_id = v_auto.id;
  if found and v_state.dormant_from = v_auto.dormant_from then
    if v_state.done_at is not null then
      return jsonb_build_object('ok', false, 'reason', 'done');
    end if;
    v_after := coalesce(v_state.after_id, v_after);
  end if;
  v_months := v_auto.dormant_from_months;
  if v_months is null then
    select m.dormant_months into v_months from app.customer_status_months(p_org) m;
  end if;

  -- by id from the cursor; every row reached counts toward the rows cap
  for v_row in
    select r.id, r.last_purchase_on from app.dormant_customer_rows(p_org, v_auto.entity_type, v_after, v_rows_cap) r
  loop
    if v_ran + v_skipped >= v_runs_cap then
      v_more := true;
      exit;
    end if;
    v_examined := v_examined + 1;
    v_after := v_row.id;
    -- only those already dormant when the rule was switched on: the others belong to the scan
    continue when app.dormant_day(v_row.last_purchase_on, v_months) >= v_auto.dormant_from;
    v_key := 'dormant:' || v_row.id || ':' || v_row.last_purchase_on;
    continue when exists (select 1 from public.automation_runs r where r.automation_id = v_auto.id and r.run_key = v_key);
    v_status := app.execute_automation(v_auto, v_row.id, v_key);
    if v_status = 'skipped' then
      v_skipped := v_skipped + 1;
      -- AUT-07: the month's runs are used up; stop here
      if exists (select 1 from public.automation_runs r
                  where r.automation_id = v_auto.id and r.run_key = v_key and r.status = 'skipped'
                    and r.steps -> 0 ->> 'error' = 'the monthly automation runs of the plan are used up') then
        v_quota := true;
        exit;
      end if;
    elsif v_status is not null then
      v_ran := v_ran + 1;
    end if;
  end loop;
  -- the rows cap reached: the list may go on
  if not v_quota and v_examined >= v_rows_cap then
    v_more := true;
  end if;

  insert into app.dormant_backfills as b (automation_id, organization_id, dormant_from, after_id, runs, done_at, updated_at)
  values (v_auto.id, p_org, v_auto.dormant_from, v_after, v_ran, case when v_more or v_quota then null else now() end, now())
  on conflict (automation_id) do update
     set dormant_from = excluded.dormant_from,
         after_id = excluded.after_id,
         runs = case when b.dormant_from = excluded.dormant_from then b.runs else 0 end + excluded.runs,
         done_at = excluded.done_at,
         updated_at = now();

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'dormant_backfill', 'automations', v_auto.id,
          jsonb_build_object('count', v_ran, 'skipped', v_skipped, 'examined', v_examined, 'dormant_from', v_auto.dormant_from,
                             'more', v_more, 'quota', v_quota));

  return jsonb_build_object('ok', true, 'ran', v_ran, 'skipped', v_skipped, 'more', v_more, 'quota', v_quota);
end;
$$;
revoke all on function public.run_dormant_backfill(uuid, uuid) from public, anon;
grant execute on function public.run_dormant_backfill(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
