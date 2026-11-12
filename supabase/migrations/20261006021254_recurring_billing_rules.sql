-- SUB-01..SUB-05, part 2 of 8: the deal check, make-up and the billing rules. Split from one file so each part fits one apply call;
-- the parts run in name order. Every statement is safe to run twice. No drop statement, no delete.

-- The deal a billing comes from (review M2): of the billing's own customer, exactly. A contact's billing: the deal's contact
-- is that contact, or the deal has no contact and its company is the contact's company. A company's billing: the deal's
-- company is that company. Nulls never match.
create or replace function app.recurring_deal_matches(p_deal_contact uuid, p_deal_company uuid, p_contact uuid, p_company uuid,
                                                     p_contact_company uuid) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_contact is not null then
      coalesce(p_deal_contact = p_contact, false)
      or (p_deal_contact is null and p_deal_company is not null and coalesce(p_deal_company = p_contact_company, false))
    when p_company is not null then coalesce(p_deal_company = p_company, false)
    else false end
$$;
revoke all on function app.recurring_deal_matches(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.recurring_deal_matches(uuid, uuid, uuid, uuid, uuid) to authenticated;

-- A person's deal: read under the caller's RLS (invoker), so an unreadable deal answers exactly like a missing one or one
-- of another customer (one hint). Runs before the definer check (trigger name order).
create or replace function app.recurring_billings_deal_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_deal record;
begin
  if new.deal_id is null or auth.uid() is null
     or not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  select d.contact_id, d.company_id,
         (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id) as contact_company
    into v_deal
    from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id and d.deleted_at is null;
  if not found or not app.recurring_deal_matches(v_deal.contact_id, v_deal.company_id, new.contact_id, new.company_id, v_deal.contact_company) then
    raise exception 'the deal is not found or is of another customer' using errcode = 'P0001', hint = 'recurring_billing:deal';
  end if;
  return new;
end;
$$;
revoke all on function app.recurring_billings_deal_check() from public, anon, authenticated;

-- the billing dates from p_from up to (not including) p_until: how many cycles a gap passed over (review L2)
create or replace function app.recurring_cycles_between(p_start date, p_cycle text, p_day integer, p_from date, p_until date) returns integer
language plpgsql immutable
set search_path = ''
as $$
declare
  v_day date := app.recurring_next_cycle(p_start, p_cycle, p_day, p_from);
  v_n integer := 0;
begin
  while v_day is not null and v_day < p_until and v_n < 1000 loop
    v_n := v_n + 1;
    v_day := app.recurring_next_cycle(p_start, p_cycle, p_day, v_day + 1);
  end loop;
  return v_n;
end;
$$;
revoke all on function app.recurring_cycles_between(date, text, integer, date, date) from public, anon, authenticated, service_role;

-- the day a billing was made, in the business's zone
create or replace function app.recurring_created_on(p_org uuid, p_at timestamptz) returns date
language sql stable security definer
set search_path = ''
as $$
  select (p_at at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date
$$;
revoke all on function app.recurring_created_on(uuid, timestamptz) from public, anon, authenticated, service_role;

-- delta review MED-1: where a make-up starts: the first billing date on or after p_from, moved on so that at most 24 cycles
-- fall up to p_today (the older ones are not made)
create or replace function app.recurring_make_up_from(p_start date, p_cycle text, p_day integer, p_from date, p_today date) returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_day date := app.recurring_next_cycle(p_start, p_cycle, p_day, p_from);
  v_n integer := app.recurring_cycles_between(p_start, p_cycle, p_day, p_from, p_today + 1);
begin
  while v_n > 24 loop
    v_day := app.recurring_next_cycle(p_start, p_cycle, p_day, v_day + 1);
    v_n := v_n - 1;
  end loop;
  return v_day;
end;
$$;
revoke all on function app.recurring_make_up_from(date, text, integer, date, date) from public, anon, authenticated, service_role;

-- Server-set columns and the status rules, for every writer. Definer: the events and the deal check read past RLS.
create or replace function app.recurring_billings_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_deal record;
begin
  -- the job and the amount recompute (app.recurring_billing_server names the business, transaction-local)
  if current_setting('app.recurring_billing_server', true) = new.organization_id::text then
    return new;
  end if;
  -- a merge moves only the customer (app.merge_recurring_billings sets the marker around its own update)
  if tg_op = 'UPDATE' and current_setting('app.recurring_billing_merge', true) = new.organization_id::text then
    if row(new.organization_id, new.name, new.cycle, new.start_date, new.billing_day, new.end_date, new.status,
           new.amount_agorot, new.next_cycle_on, new.prices_include_vat)
       is not distinct from row(old.organization_id, old.name, old.cycle, old.start_date, old.billing_day, old.end_date,
           old.status, old.amount_agorot, old.next_cycle_on, old.prices_include_vat)
       and ((new.deal_id is not distinct from old.deal_id
             and ((old.contact_id is not null and new.contact_id is not null and new.company_id is null)
                  or (old.company_id is not null and new.company_id is not null and new.contact_id is null)))
            -- a deal merge moves only the deal, or clears it when the kept deal is another customer's (L5, delta review L-d)
            or (old.deal_id is not null
                and row(new.contact_id, new.company_id) is not distinct from row(old.contact_id, old.company_id))) then
      return new;
    end if;
    raise exception 'a merge moves only the customer of a recurring billing' using errcode = 'P0001', hint = 'recurring_billing:fixed';
  end if;
  -- outsider guard: RLS refuses (42501) a person who may not write here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  v_today := app.recurring_today(new.organization_id);
  new.name := btrim(new.name);
  new.cancel_reason := nullif(btrim(coalesce(new.cancel_reason, '')), '');

  if tg_op = 'INSERT' then
    if not app.org_has_feature(new.organization_id, 'recurring_billing') then
      raise exception 'recurring billing is not in this plan' using errcode = 'P0001', hint = 'feature:recurring_billing';
    end if;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.status := 'active';
    new.amount_agorot := 0;
    new.make_up_until := null;
    new.paused_at := null;
    new.cancelled_at := null;
    new.cancel_reason := null;
    new.prices_include_vat := coalesce(new.prices_include_vat,
      (select s.prices_include_vat from public.org_document_settings s where s.organization_id = new.organization_id), false);
    if new.deal_id is not null then
      select d.contact_id, d.company_id,
             (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id) as contact_company
        into v_deal
        from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id and d.deleted_at is null;
      if not found or not app.recurring_deal_matches(v_deal.contact_id, v_deal.company_id, new.contact_id, new.company_id, v_deal.contact_company) then
        raise exception 'the deal is not found or is of another customer' using errcode = 'P0001', hint = 'recurring_billing:deal';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('recurring_billing_deal:' || new.deal_id::text, 0));
      if exists (select 1 from public.recurring_billings b
                  where b.organization_id = new.organization_id and b.deal_id = new.deal_id and b.status <> 'cancelled') then
        raise exception 'the deal already has a recurring billing' using errcode = 'P0001', hint = 'recurring_billing:deal_exists';
      end if;
    end if;
    new.next_cycle_on := app.recurring_next_cycle(new.start_date, new.cycle, new.billing_day, v_today);
    if new.end_date is not null and new.next_cycle_on > new.end_date then
      new.next_cycle_on := null;
    end if;
  else
    -- (the currency is held by its own check constraint)
    if row(new.organization_id, new.contact_id, new.company_id, new.deal_id, new.cycle, new.start_date, new.prices_include_vat,
           new.created_by, new.created_at)
       is distinct from row(old.organization_id, old.contact_id, old.company_id, old.deal_id, old.cycle, old.start_date,
           old.prices_include_vat, old.created_by, old.created_at)
       -- the FK's own set-null of a purged deal
       and not (pg_trigger_depth() > 1 and old.deal_id is not null and new.deal_id is null
                and row(new.contact_id, new.company_id, new.cycle, new.start_date) is not distinct from row(old.contact_id, old.company_id, old.cycle, old.start_date)) then
      raise exception 'the customer, cycle and start of a recurring billing stay as made' using errcode = 'P0001', hint = 'recurring_billing:fixed';
    end if;
    if old.status = 'cancelled' and pg_trigger_depth() <= 1 then
      raise exception 'a cancelled recurring billing does not change' using errcode = 'P0001', hint = 'recurring_billing:cancelled';
    end if;
    -- review L7: without the plan key a recorder only stops a billing (pause, or cancel with a reason)
    if auth.uid() is not null and pg_trigger_depth() <= 1 and not app.org_has_feature(new.organization_id, 'recurring_billing')
       and not (new.status is distinct from old.status and new.status in ('paused', 'cancelled')
                and row(new.name, new.billing_day, new.end_date, new.commitment_months)
                    is not distinct from row(old.name, old.billing_day, old.end_date, old.commitment_months)) then
      raise exception 'recurring billing is not in this plan' using errcode = 'P0001', hint = 'feature:recurring_billing';
    end if;
    -- server columns keep their values
    new.amount_agorot := old.amount_agorot;
    new.next_cycle_on := old.next_cycle_on;
    new.make_up_until := old.make_up_until;
    new.paused_at := old.paused_at;
    new.cancelled_at := old.cancelled_at;

    if new.status is distinct from old.status then
      if new.status = 'failed' then
        raise exception 'only the system marks a billing failed' using errcode = 'P0001', hint = 'recurring_billing:status';
      elsif new.status = 'paused' then
        if old.status <> 'active' then
          raise exception 'only an active billing is paused' using errcode = 'P0001', hint = 'recurring_billing:status';
        end if;
        new.paused_at := now();
        -- delta review 2 (L): a pause ends a make-up that was still waiting, so the L-a lock never outlives it
        new.make_up_until := null;
      elsif new.status = 'active' then
        new.paused_at := null;
        if current_setting('app.recurring_resume_make_up', true) = new.id::text then
          -- owner (353) ג, delta review MED-1: make up the missed cycles from the first missed date (the next cycle date the
          -- pause or failure kept), never before the day the billing was made (business zone), and at most the last 24
          new.next_cycle_on := app.recurring_make_up_from(new.start_date, new.cycle, new.billing_day,
            greatest(coalesce(old.next_cycle_on, v_today), app.recurring_created_on(new.organization_id, new.created_at)), v_today);
          new.make_up_until := v_today;
        else
          -- continue: the first billing date from today; missed cycles are not made up
          new.next_cycle_on := app.recurring_next_cycle(new.start_date, new.cycle, new.billing_day, v_today);
          new.make_up_until := null;
        end if;
      elsif new.status = 'cancelled' then
        if new.cancel_reason is null then
          raise exception 'a cancel needs a reason' using errcode = 'P0001', hint = 'recurring_billing:cancel_reason';
        end if;
        new.cancelled_at := now();
        new.next_cycle_on := null;
      end if;
    elsif new.cancel_reason is distinct from old.cancel_reason then
      raise exception 'the reason is given with the cancel' using errcode = 'P0001', hint = 'recurring_billing:cancel_reason';
    end if;

    -- delta review L-a: while a make-up is still running, the billing day and end date wait for it
    if old.make_up_until is not null and (new.billing_day is distinct from old.billing_day or new.end_date is distinct from old.end_date) then
      raise exception 'the missed cycles are still being made' using errcode = 'P0001', hint = 'recurring_billing:make_up_pending';
    end if;
    -- a changed billing day or end date moves the next cycle (from the day after the last made cycle, or today)
    if new.status = 'active' and new.make_up_until is null
       and (new.billing_day is distinct from old.billing_day or new.end_date is distinct from old.end_date
            or new.status is distinct from old.status) then
      new.next_cycle_on := app.recurring_next_cycle(new.start_date, new.cycle, new.billing_day,
        greatest(v_today, coalesce((select max(c.cycle_on) + 1 from public.recurring_billing_cycles c
                                     where c.organization_id = new.organization_id and c.billing_id = new.id), v_today)));
    end if;
    if new.end_date is not null and new.next_cycle_on > new.end_date then
      new.next_cycle_on := null;
    end if;
    -- delta review 2 (MED): a make-up is pending only while a missed cycle is still due, so nothing missed (or no next cycle
    -- at all, after the end date) leaves no L-a lock behind
    if new.make_up_until is not null and (new.next_cycle_on is null or new.next_cycle_on > v_today) then
      new.make_up_until := null;
    end if;
  end if;

  if auth.uid() is not null and new.end_date is not null and new.end_date < new.start_date then
    raise exception 'the end date is after the start' using errcode = 'P0001', hint = 'recurring_billing:end_date';
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;
revoke all on function app.recurring_billings_check() from public, anon, authenticated;

create or replace trigger recurring_billings_a_deal_check before insert on public.recurring_billings
  for each row execute function app.recurring_billings_deal_check();
create or replace trigger recurring_billings_check before insert or update on public.recurring_billings
  for each row execute function app.recurring_billings_check();
create or replace trigger recurring_billings_touch before update on public.recurring_billings
  for each row execute function app.touch_row();
-- an update of the deal alone is the FK's set-null of a purged deal (also while the business itself is deleted): not logged
create or replace trigger recurring_billings_audit after insert or delete on public.recurring_billings
  for each row execute function app.audit_row();
create or replace trigger recurring_billings_audit_update after update of contact_id, company_id, name, billing_day, end_date,
  commitment_months, status, cancel_reason, amount_agorot on public.recurring_billings
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- History (server written)
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_billing_events (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  billing_id        uuid not null,
  kind              text not null check (kind in ('created', 'paused', 'resumed', 'cancelled', 'failed', 'ended', 'day_changed',
                                                  'price_changed', 'cycle_due', 'cycles_skipped', 'no_lines', 'order_not_made', 'deal_unlinked')),
  -- owner (355) א: a cancel keeps its reason and whether it fell inside the commitment period (its last day in effective_on)
  reason            text check (reason is null or char_length(btrim(reason)) between 1 and 500),
  in_commitment     boolean,
  -- owner (353) ג: a resume says whether the missed cycles are made up
  make_up           boolean,
  -- cycles_skipped: how many billing dates passed while no cycle could be made (review L2)
  skipped_cycles    integer check (skipped_cycles is null or skipped_cycles > 0),
  old_amount_agorot bigint,
  new_amount_agorot bigint,
  effective_on      date,
  currency          text not null default 'ILS' check (currency = 'ILS'),
  actor_id          uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (organization_id, id),
  constraint recurring_billing_events_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade
);
create index if not exists recurring_billing_events_billing_idx on public.recurring_billing_events (organization_id, billing_id, created_at);
alter table public.recurring_billing_events enable row level security;
revoke all on public.recurring_billing_events from anon, authenticated;
grant select on public.recurring_billing_events to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_events' and policyname = 'recurring_billing_events_select') then
    create policy recurring_billing_events_select on public.recurring_billing_events for select to authenticated
      using (exists (select 1 from public.recurring_billings b
                      where b.organization_id = recurring_billing_events.organization_id and b.id = recurring_billing_events.billing_id));
  end if;
end;
$$;
