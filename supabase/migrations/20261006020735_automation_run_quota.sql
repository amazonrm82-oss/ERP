-- =============================================================================
-- AUT-07: monthly automation runs against the plan quota
-- =============================================================================
-- Owner's answer, 18 October 2026 (DECISIONS.md "מכסת הרצות אוטומציה", (ג)): a warning to the owners at 80% and at 100%
-- of the plan's max_automation_runs_per_month (a system notice and a bar on the automations screen), 10% more, then the
-- automations stop with a fixed bar until the next month or an upgrade. Lead intake does not depend on automations, so no
-- inquiry is lost. Coordinator, 21 October 2026 (recorded as an owner question): only a run that executed at least one
-- step counts; a manual run (run_automation_now, run key 'manual:') and a skipped run do not.
-- * app.automation_run_months: one counter row per business and month (the month in the business's time zone), with when
--   each notice went out. Schema app: RLS on, no policies, no grants.
-- * app.execute_automation (the body of 020020, the automation_rule_runs slot logic unchanged): only while the plan has a
--   limit (app.org_limit, so a subscription override counts; a plan without one neither locks nor counts, review low 1),
--   a counted run first takes
--   its business's row of this month FOR UPDATE (created when missing), so the check and the count are one decision under
--   one lock, held to the end of the transaction: no read-then-write race between concurrent jobs. When the runs have
--   reached 110% of the limit (app.org_limit, so a subscription override counts; null = no limit), the run is logged as
--   'skipped' with one step that says why, and nothing runs (never an error, so nothing retries it). After its actions a
--   run that executed at least one step adds 1; the first time the month's count reaches 80% and 100% of the limit, the
--   active owners get one system notice each.
-- * public.org_plan_usage (the body of 020120) lists max_automation_runs_per_month with this month's count.
-- Two jobs that run several businesses in opposite orders could deadlock on two rows; PostgreSQL then aborts one statement,
-- which the job's own per-event or per-rule exception block catches, and that run is tried again on the next pass.
-- Safe to run twice. No drops, no row removal.

create table if not exists app.automation_run_months (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  month           date not null,
  runs            integer not null default 0 check (runs >= 0),
  warned_80_at    timestamptz,
  warned_100_at   timestamptz,
  primary key (organization_id, month)
);
alter table app.automation_run_months enable row level security;
revoke all on app.automation_run_months from public, anon, authenticated, service_role;

-- the business's current month (its own time zone), as the counter's key
create or replace function app.automation_run_month(p_org uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select date_trunc('month', now() at time zone coalesce(
           (select nullif(o.timezone, '') from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date
$$;
revoke all on function app.automation_run_month(uuid) from public, anon, authenticated, service_role;

-- this month's counted runs of a business (0 when none)
create or replace function app.automation_runs_this_month(p_org uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select m.runs from app.automation_run_months m
                    where m.organization_id = p_org and m.month = app.automation_run_month(p_org)), 0)
$$;
revoke all on function app.automation_runs_this_month(uuid) from public, anon, authenticated, service_role;

create or replace function app.execute_automation(
  p_auto public.automations, p_entity_id uuid, p_run_key text, p_check_conditions boolean default true
) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_record jsonb := app.automation_record(p_auto.entity_type, p_auto.organization_id, p_entity_id);
  v_run uuid;
  v_steps jsonb;
  v_status text;
  v_ok integer;
  v_total integer;
  v_slot integer;
  v_labelled boolean;
  -- AUT-07: the monthly run quota (a manual run is not counted)
  v_counted boolean := p_run_key not like 'manual:%';
  v_month date;
  v_limit numeric;
  v_runs integer;
  v_quota app.automation_run_months%rowtype;
  v_title text;
begin
  if v_record is null or (v_record ->> 'deleted_at') is not null then
    return null;
  end if;
  if p_check_conditions and not app.automation_conditions_match(v_record, p_auto.conditions) then
    return null;
  end if;

  -- loop guard: at most 20 runs of one rule on one record a day
  if (select count(*) from public.automation_runs r
       where r.automation_id = p_auto.id and r.entity_id = p_entity_id and r.created_at > now() - interval '1 day') >= 20 then
    insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status, steps)
    values (p_auto.organization_id, p_auto.id, p_auto.entity_type, p_entity_id, p_run_key, 'skipped',
            jsonb_build_array(jsonb_build_object('action', null, 'status', 'error', 'error', 'daily limit for this record reached')))
    on conflict (automation_id, run_key) do nothing;
    return 'skipped';
  end if;

  -- AUT-07: this month's counter of the business, taken FOR UPDATE before deciding, so the check and the count below are
  -- one decision under one lock (held to the end of the transaction); at 110% of the limit the run is skipped and logged
  -- a plan without a limit neither locks nor counts (runs of the business are not serialised for nothing)
  if v_counted then
    v_limit := app.org_limit(p_auto.organization_id, 'max_automation_runs_per_month');
    v_counted := v_limit is not null;
  end if;
  if v_counted then
    v_month := app.automation_run_month(p_auto.organization_id);
    insert into app.automation_run_months (organization_id, month) values (p_auto.organization_id, v_month)
    on conflict (organization_id, month) do nothing;
    select * into v_quota from app.automation_run_months
     where organization_id = p_auto.organization_id and month = v_month for update;
    if v_quota.runs >= floor(v_limit * 1.1) then
      insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status, steps)
      values (p_auto.organization_id, p_auto.id, p_auto.entity_type, p_entity_id, p_run_key, 'skipped',
              jsonb_build_array(jsonb_build_object('action', null, 'status', 'error',
                'error', 'the monthly automation runs of the plan are used up')))
      on conflict (automation_id, run_key) do nothing;
      return 'skipped';
    end if;
  end if;

  insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status)
  values (p_auto.organization_id, p_auto.id, p_auto.entity_type, p_entity_id, p_run_key, 'success')
  on conflict (automation_id, run_key) do nothing
  returning id into v_run;
  if v_run is null then
    return null; -- this occasion already ran
  end if;

  perform set_config('app.automation_running', 'on', true);
  -- PRM-01: the audit log names the rule behind the inserts and updates its actions make (a delete
  -- gets no audit name). The running rule is kept in app.automation_rule_runs (no client grants), in
  -- this transaction's slot, stamped with this transaction, never in a setting a client session could
  -- set itself. The slot is never waited for: when another open transaction holds it, no label.
  v_slot := (txid_current() % 65536)::integer;
  perform 1 from app.automation_rule_runs where slot = v_slot for update skip locked;
  v_labelled := found;
  if v_labelled then
    update app.automation_rule_runs
       set txid = txid_current(), organization_id = p_auto.organization_id, rule_id = p_auto.id
     where slot = v_slot;
  end if;
  v_steps := app.run_automation_actions(p_auto, p_auto.entity_type, p_entity_id);
  if v_labelled then
    update app.automation_rule_runs set rule_id = null where slot = v_slot and txid = txid_current();
  end if;
  perform set_config('app.automation_running', 'off', true);

  select count(*) filter (where s ->> 'status' = 'ok'), count(*) into v_ok, v_total from jsonb_array_elements(v_steps) s;
  v_status := case when v_ok = v_total then 'success' when v_ok = 0 then 'failed' else 'partial' end;
  update public.automation_runs set status = v_status, steps = v_steps where id = v_run;

  -- AUT-07: a run that executed at least one step counts; the owners hear once at 80% and once at 100% of the month's limit
  if v_counted and v_total > 0 then
    update app.automation_run_months set runs = runs + 1
     where organization_id = p_auto.organization_id and month = v_month
    returning runs into v_runs;
    if v_limit > 0 then
      v_title := null;
      if v_runs >= v_limit and v_quota.warned_100_at is null then
        update app.automation_run_months set warned_100_at = now(), warned_80_at = coalesce(warned_80_at, now())
         where organization_id = p_auto.organization_id and month = v_month and warned_100_at is null;
        if found then
          v_title := 'האוטומציות הגיעו למכסת ההרצות החודשית';
        end if;
      elsif v_runs >= ceil(v_limit * 0.8) and v_quota.warned_80_at is null then
        update app.automation_run_months set warned_80_at = now()
         where organization_id = p_auto.organization_id and month = v_month and warned_80_at is null;
        if found then
          v_title := 'האוטומציות הגיעו ל-80% ממכסת ההרצות החודשית';
        end if;
      end if;
      if v_title is not null then
        insert into public.notifications (organization_id, user_id, type, title, body)
        select p_auto.organization_id, m.user_id, 'system', v_title,
               'בוצעו ' || v_runs || ' מתוך ' || v_limit || ' הרצות החודש. אחרי עוד 10% האוטומציות ייעצרו עד תחילת החודש הבא או עד הגדלת החבילה. קליטת פניות לא נעצרת.'
          from public.memberships m
         where m.organization_id = p_auto.organization_id and m.role = 'owner' and m.status = 'active';
      end if;
    end if;
  end if;
  return v_status;
end;
$$;

revoke all on function app.execute_automation(public.automations, uuid, text, boolean) from public, anon, authenticated;

create or replace function public.org_plan_usage(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not app.is_member(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'plan_key', s.plan_key,
    'plan_name', p.name_he,
    'status', s.status,
    'trial_ends_at', s.trial_ends_at,
    'seats', s.seats,
    'usage', jsonb_build_array(
      jsonb_build_object('key', 'max_users', 'limit', app.org_limit(p_org, 'max_users'),
        'used', (select count(*) from public.memberships m
                  where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full')),
      jsonb_build_object('key', 'max_records', 'limit', app.org_limit(p_org, 'max_records'),
        'used', coalesce((select u.records_count from public.org_usage u where u.organization_id = p_org), 0)),
      jsonb_build_object('key', 'max_pipelines', 'limit', app.org_limit(p_org, 'max_pipelines'),
        'used', (select count(*) from public.pipelines pl where pl.organization_id = p_org and pl.deleted_at is null)),
      jsonb_build_object('key', 'max_forms', 'limit', app.org_limit(p_org, 'max_forms'),
        'used', (select count(*) from public.forms f where f.organization_id = p_org and f.kind = 'form')),
      jsonb_build_object('key', 'max_active_automations', 'limit', app.org_limit(p_org, 'max_active_automations'),
        'used', (select count(*) from public.automations a where a.organization_id = p_org and a.is_active)),
      jsonb_build_object('key', 'storage_gb', 'limit', app.org_limit(p_org, 'storage_gb'),
        'used', round(coalesce((select sum(fl.size_bytes) from public.files fl where fl.organization_id = p_org), 0) / 1073741824.0, 3)),
      jsonb_build_object('key', 'max_products', 'limit', app.org_limit(p_org, 'max_products'),
        'used', (select count(*) from public.products pr where pr.organization_id = p_org)),
      jsonb_build_object('key', 'max_price_lists', 'limit', app.org_limit(p_org, 'max_price_lists'),
        'used', (select count(*) from public.price_lists pli where pli.organization_id = p_org)),
      -- AUT-07: this month's counted automation runs (the month in the business's time zone)
      jsonb_build_object('key', 'max_automation_runs_per_month', 'limit', app.org_limit(p_org, 'max_automation_runs_per_month'),
        'used', app.automation_runs_this_month(p_org))
    )
    -- PRM-02: view seats, while the plan has them (limit = per paid seat x active paid seats; null = no limit)
    || case when app.org_has_feature(p_org, 'view_seats') then jsonb_build_array(
         jsonb_build_object('key', 'view_seats', 'limit', app.view_seat_cap(p_org, null),
           'used', (select count(*) from public.memberships m
                     where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'view')))
       else '[]'::jsonb end
  )
  into v_result
  from public.subscriptions s
  join public.plans p on p.key = s.plan_key
  where s.organization_id = p_org;

  return v_result;
end;
$$;
revoke all on function public.org_plan_usage(uuid) from public, anon;
grant execute on function public.org_plan_usage(uuid) to authenticated;

notify pgrst, 'reload schema';
