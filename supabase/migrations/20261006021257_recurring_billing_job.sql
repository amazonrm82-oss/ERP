-- SUB-01..SUB-05, part 5 of 8: the job, resume, from a won deal. Split from one file so each part fits one apply call;
-- the parts run in name order. Every statement is safe to run twice. No drop statement, no delete.

-- One cycle of a billing on a day: its row, its task and (352) its draft order; nothing for a billing with no lines (one
-- `no_lines` event until a cycle is made again). Returns the next billing date (null past the end date). Called by the job
-- inside its per-billing exception block, with app.recurring_billing_server set.
create or replace function app.recurring_billing_make_cycle(p_org uuid, p_billing uuid, p_on date) returns date
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.recurring_billings;
  v_zone text;
  v_next date;
  v_end date;
  v_totals jsonb;
  v_cycle uuid;
  v_task uuid;
  v_order uuid;
  v_rep uuid;
begin
  select * into v_b from public.recurring_billings b where b.organization_id = p_org and b.id = p_billing;
  v_zone := app.intake_zone((select o.timezone from public.organizations o where o.id = p_org));
  v_next := app.recurring_next_cycle(v_b.start_date, v_b.cycle, v_b.billing_day, p_on + 1);
  v_end := v_next - 1;
  if v_b.end_date is not null and v_end > v_b.end_date then
    v_end := v_b.end_date;
  end if;
  if not exists (select 1 from public.recurring_billing_lines l where l.organization_id = p_org and l.billing_id = p_billing) then
    -- review L3: a billing with no lines makes no cycle and no task; it says so once (until a cycle is made again)
    if not exists (select 1 from public.recurring_billing_events e
                    where e.organization_id = p_org and e.billing_id = p_billing and e.kind = 'no_lines'
                      and e.created_at > coalesce((select max(c.created_at) from public.recurring_billing_cycles c
                                                    where c.organization_id = p_org and c.billing_id = p_billing), '-infinity')) then
      insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on)
      values (p_org, p_billing, 'no_lines', p_on);
    end if;
  else
    v_totals := app.recurring_billing_totals(p_org, p_billing, p_on);
    insert into public.recurring_billing_cycles (organization_id, billing_id, cycle_on, period_end, net_agorot, vat_agorot,
                                                 total_agorot, vat_rate_bp)
    values (p_org, p_billing, p_on, v_end,
            (v_totals ->> 'net_total_agorot')::bigint, (v_totals ->> 'vat_agorot')::bigint, (v_totals ->> 'total_agorot')::bigint,
            case when (v_totals ->> 'rate_known')::boolean then (v_totals ->> 'rate_bp')::integer end)
    on conflict (billing_id, cycle_on) do nothing
    returning id into v_cycle;
  end if;

  if v_cycle is not null then
    v_rep := app.recurring_billing_rep(p_org, p_billing);
    insert into public.tasks (organization_id, title, description, task_type, due_at, priority, owner_id, deal_id, contact_id, company_id)
    values (p_org,
            left('חיוב חוזר: ' || v_b.name || ' · מחזור ' || to_char(p_on, 'DD/MM/YYYY'), 300),
            'להפיק מסמך ללקוח במערכת החשבונות, לרשום אותו במסמכים ולשייך אותו למחזור בדף החיוב החוזר. אם נוצרה טיוטת הזמנה, לבדוק ולאשר אותה.',
            'todo', greatest(now(), (p_on + time '12:00') at time zone v_zone), 2, v_rep,
            (select dl.id from public.deals dl where dl.organization_id = p_org and dl.id = v_b.deal_id and dl.deleted_at is null),
            v_b.contact_id, v_b.company_id)
    returning id into v_task;
    -- owner (352) ב: the cycle's draft order, in its own block (a refused order leaves the cycle and the task)
    begin
      v_order := app.recurring_cycle_order(p_org, p_billing, v_rep);
    exception when others then
      v_order := null;
      perform set_config('app.order_server', '', true);
      insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on)
      values (p_org, p_billing, 'order_not_made', p_on);
      raise warning 'crm-recurring-billings: billing % cycle % order not made (SQLSTATE %)', p_billing, p_on, sqlstate;
    end;
    update public.recurring_billing_cycles c set task_id = v_task, order_id = v_order
     where c.organization_id = p_org and c.id = v_cycle;
    insert into public.recurring_billing_events (organization_id, billing_id, kind, new_amount_agorot, effective_on)
    values (p_org, p_billing, 'cycle_due', (v_totals ->> 'net_total_agorot')::bigint, p_on);
  end if;
  return case when v_b.end_date is not null and v_next > v_b.end_date then null else v_next end;
end;
$$;
revoke all on function app.recurring_billing_make_cycle(uuid, uuid, date) from public, anon, authenticated, service_role;

create or replace function app.run_recurring_billings(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_on date;
  v_skipped integer;
  v_done integer := 0;
  v_failures integer;
  v_served uuid[] := '{}'::uuid[];
  -- cycles made per business in this run (a make-up counts each of its cycles against the per-business cap)
  v_counts jsonb := '{}'::jsonb;
  v_made integer;
  -- the cycle date being made when the block failed (delta review 2: the failure is kept under the date really tried)
  v_trying date;
begin
  for v_row in
    select z.* from (
      select b.organization_id, b.id, b.cycle, b.start_date, b.billing_day, b.end_date, b.next_cycle_on, b.make_up_until,
             t0.today, f.last_attempt_at, coalesce(f.failures, 0) as failures, tn.served_at,
             row_number() over (partition by b.organization_id order by f.last_attempt_at nulls first, b.next_cycle_on, b.id) as n
        from public.recurring_billings b
        join public.organizations o on o.id = b.organization_id
        cross join lateral (select app.intake_zone(o.timezone) as zone, (now() at time zone app.intake_zone(o.timezone))::date as today) t0
        left join app.recurring_billing_failures f on f.billing_id = b.id and f.cycle_on = b.next_cycle_on
        left join app.recurring_billing_turns tn on tn.organization_id = b.organization_id
       where (p_orgs is null or b.organization_id = any (p_orgs))
         and b.status = 'active'
         and b.next_cycle_on is not null
         and b.next_cycle_on <= current_date + 1
         and b.next_cycle_on <= t0.today
         and (now() at time zone t0.zone)::time >= time '08:00'
         and app.org_writable(b.organization_id)
         and app.org_has_feature(b.organization_id, 'recurring_billing')
         and not exists (select 1 from public.contacts ct where ct.organization_id = b.organization_id and ct.id = b.contact_id and ct.deleted_at is not null)
         and not exists (select 1 from public.companies co where co.organization_id = b.organization_id and co.id = b.company_id and co.deleted_at is not null)
    ) z
     where z.n <= app.recurring_billing_per_org()
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.next_cycle_on, z.id
     limit app.recurring_billing_limit()
  loop
    if not (v_row.organization_id = any (v_served)) then
      v_served := v_served || v_row.organization_id;
    end if;
    v_made := coalesce((v_counts ->> v_row.organization_id::text)::integer, 0);
    if v_made >= app.recurring_billing_per_org() then
      continue;
    end if;
    begin
      perform set_config('app.recurring_billing_server', v_row.organization_id::text, true);
      v_on := v_row.next_cycle_on;
      v_trying := null;
      -- review L2: after a gap (the business could not write, the key was off, the customer in the bin) the missed cycles are
      -- not made: one event counts them and the billing goes on from the first billing date from today. Owner (353) ג: a resume
      -- that chose to make them up (make_up_until) makes every one, each counted against the per-business cap.
      -- delta review L-b: a cycle that failed (fewer than 3 times) is tried again on its own date, alone; delta review 2: the
      -- gap rule then applies from the date after it, so a retry never makes the cycles that passed meanwhile
      if v_row.failures > 0 and v_on < v_row.today and not (v_row.make_up_until is not null and v_on <= v_row.make_up_until)
         and not (v_row.end_date is not null and v_on > v_row.end_date) then
        v_trying := v_on;
        v_on := app.recurring_billing_make_cycle(v_row.organization_id, v_row.id, v_on);
        v_trying := null;
        v_made := v_made + 1;
      end if;
      if v_on is not null and v_on < v_row.today and not (v_row.make_up_until is not null and v_on <= v_row.make_up_until) then
        v_skipped := app.recurring_cycles_between(v_row.start_date, v_row.cycle, v_row.billing_day, v_on,
                       least(v_row.today, coalesce(v_row.end_date + 1, v_row.today)));
        v_on := app.recurring_next_cycle(v_row.start_date, v_row.cycle, v_row.billing_day, v_row.today);
        if v_skipped > 0 then
          insert into public.recurring_billing_events (organization_id, billing_id, kind, skipped_cycles, effective_on)
          values (v_row.organization_id, v_row.id, 'cycles_skipped', v_skipped, v_on);
        end if;
      end if;
      loop
        exit when v_on is null or v_on > v_row.today or (v_row.end_date is not null and v_on > v_row.end_date)
                  or v_made >= app.recurring_billing_per_org();
        v_trying := v_on;
        v_on := app.recurring_billing_make_cycle(v_row.organization_id, v_row.id, v_on);
        v_trying := null;
        v_made := v_made + 1;
      end loop;
      if v_row.end_date is not null and v_on > v_row.end_date then
        v_on := null;
      end if;
      update public.recurring_billings b
         set next_cycle_on = v_on,
             make_up_until = case when v_on is null or b.make_up_until is null or v_on > b.make_up_until then null else b.make_up_until end
       where b.organization_id = v_row.organization_id and b.id = v_row.id;
      -- review L1: a billing that went through clears its failure count
      update app.recurring_billing_failures f set failures = 0, last_attempt_at = null
       where f.organization_id = v_row.organization_id and f.billing_id = v_row.id and f.failures > 0;
      perform set_config('app.recurring_billing_server', '', true);
      v_counts := v_counts || jsonb_build_object(v_row.organization_id::text, v_made);
      v_done := v_done + 1;
    exception when others then
      insert into app.recurring_billing_failures (organization_id, billing_id, cycle_on, failures, last_attempt_at)
      values (v_row.organization_id, v_row.id, coalesce(v_trying, v_row.next_cycle_on), 1, now())
      on conflict (billing_id, cycle_on)
        do update set failures = app.recurring_billing_failures.failures + 1, last_attempt_at = excluded.last_attempt_at
      returning failures into v_failures;
      if v_failures >= 3 then
        perform set_config('app.recurring_billing_server', v_row.organization_id::text, true);
        -- delta review 2 (L): a failed billing keeps no pending make-up (its resume asks again)
        update public.recurring_billings b set status = 'failed', make_up_until = null
         where b.organization_id = v_row.organization_id and b.id = v_row.id and b.status = 'active';
      end if;
      perform set_config('app.recurring_billing_server', '', true);
      raise warning 'crm-recurring-billings: billing % failed (SQLSTATE %)%', v_row.id, sqlstate,
        case when v_failures >= 3 then ', marked failed after 3 failures' else '' end;
    end;
  end loop;

  insert into app.recurring_billing_turns (organization_id, served_at)
  select o, clock_timestamp() from unnest(v_served) o
  on conflict (organization_id) do update set served_at = excluded.served_at;
  return v_done;
end;
$$;
revoke all on function app.run_recurring_billings(uuid[]) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-recurring-billings', '*/15 * * * *', 'select app.run_recurring_billings();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Owner (353) ג: resume, and say whether the missed cycles are made up (invoker: the person's own update under RLS)
-- ----------------------------------------------------------------------------
create or replace function public.recurring_billing_resume(p_org uuid, p_billing uuid, p_make_up boolean) returns boolean
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform set_config('app.recurring_resume_make_up', case when coalesce(p_make_up, false) then p_billing::text else '' end, true);
  update public.recurring_billings b set status = 'active'
   where b.organization_id = p_org and b.id = p_billing and b.status in ('paused', 'failed');
  get diagnostics v_n = row_count;
  perform set_config('app.recurring_resume_make_up', '', true);
  return v_n > 0;
end;
$$;
revoke all on function public.recurring_billing_resume(uuid, uuid, boolean) from public, anon;
grant execute on function public.recurring_billing_resume(uuid, uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- SUB-03: one click from a won deal (invoker: every write is the person's)
-- ----------------------------------------------------------------------------
create or replace function public.recurring_billing_from_deal(p_org uuid, p_deal uuid) returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_deal record;
  v_cycle text;
  v_mode boolean;
  v_start date;
  v_billing uuid;
  v_line record;
  v_copied integer := 0;
  v_skipped integer := 0;
  v_other integer := 0;
begin
  select d.id, d.name, d.contact_id, d.company_id, d.billing_kind, d.recurring_start_date, d.deleted_at, s.kind as stage_kind
    into v_deal
    from public.deals d join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
   where d.organization_id = p_org and d.id = p_deal;
  if not found or v_deal.deleted_at is not null then
    raise exception 'deal not found' using errcode = '42501';
  end if;
  if v_deal.stage_kind <> 'won' then
    raise exception 'the deal is not won' using errcode = 'P0001', hint = 'recurring_billing:deal_not_won';
  end if;
  if v_deal.contact_id is null and v_deal.company_id is null then
    raise exception 'the deal has no customer' using errcode = 'P0001', hint = 'recurring_billing:deal_customer';
  end if;
  v_cycle := case when v_deal.billing_kind in ('monthly', 'yearly') then v_deal.billing_kind end;
  if v_cycle is null then
    select l.billing into v_cycle from public.deal_lines l
     where l.organization_id = p_org and l.deal_id = p_deal and l.billing in ('monthly', 'quarterly', 'yearly')
     order by l.position, l.id limit 1;
  end if;
  if v_cycle is null then
    raise exception 'the deal has no recurring lines' using errcode = 'P0001', hint = 'recurring_billing:deal_no_lines';
  end if;
  select l.price_includes_vat into v_mode from public.deal_lines l
   where l.organization_id = p_org and l.deal_id = p_deal order by l.created_at, l.id limit 1;
  v_start := coalesce(v_deal.recurring_start_date,
    (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date);

  insert into public.recurring_billings (organization_id, contact_id, company_id, deal_id, name, cycle, start_date, billing_day,
                                         prices_include_vat)
  values (p_org, v_deal.contact_id, case when v_deal.contact_id is null then v_deal.company_id end, p_deal,
          left(btrim(v_deal.name), 120), v_cycle, v_start, case when extract(day from v_start) > 28 then 0 else extract(day from v_start)::integer end, v_mode)
  returning id into v_billing;

  for v_line in
    select l.* from public.deal_lines l where l.organization_id = p_org and l.deal_id = p_deal order by l.position, l.id
  loop
    if coalesce(v_line.billing, 'one_time') <> v_cycle then
      v_other := v_other + 1;
      continue;
    end if;
    begin
      insert into public.recurring_billing_lines (organization_id, billing_id, position, product_id, description, quantity,
                                                  unit_price_agorot, discount_bp, discount_agorot, vat_exempt, price_source, price_list_id)
      values (p_org, v_billing, v_line.position, v_line.product_id, v_line.description, v_line.quantity, v_line.unit_price_agorot,
              v_line.discount_bp, v_line.discount_agorot, v_line.vat_exempt,
              -- review L6: a list price whose list was removed keeps its price as a typed one
              case when v_line.price_source = 'price_list' and v_line.price_list_id is null then 'manual' else v_line.price_source end,
              case when v_line.price_source = 'price_list' then v_line.price_list_id end);
      v_copied := v_copied + 1;
    exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
      v_skipped := v_skipped + 1;
    end;
  end loop;
  if v_copied = 0 then
    raise exception 'no recurring line could be copied' using errcode = 'P0001', hint = 'recurring_billing:deal_no_lines';
  end if;
  return jsonb_build_object('id', v_billing, 'copied', v_copied, 'skipped', v_skipped, 'other_period', v_other);
end;
$$;
revoke all on function public.recurring_billing_from_deal(uuid, uuid) from public, anon;
grant execute on function public.recurring_billing_from_deal(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- SUB-05: the report (INVOKER: RLS decides what is counted)
-- ----------------------------------------------------------------------------
-- review M3: how many billings the business has whose customer is not in the bin (count only, members only), for the partial
-- rule of the report (BAL-01 / COL-06): a caller who reads fewer gets the rows they read and no totals
create or replace function app.recurring_billing_count(p_org uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then (
    select count(*)::integer from public.recurring_billings r
     where r.organization_id = p_org
       and not exists (select 1 from public.contacts c where c.organization_id = r.organization_id and c.id = r.contact_id and c.deleted_at is not null)
       and not exists (select 1 from public.companies co where co.organization_id = r.organization_id and co.id = r.company_id and co.deleted_at is not null))
  end
$$;
revoke all on function app.recurring_billing_count(uuid) from public, anon;
grant execute on function app.recurring_billing_count(uuid) to authenticated;
