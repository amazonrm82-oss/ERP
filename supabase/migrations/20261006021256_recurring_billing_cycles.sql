-- SUB-01..SUB-05, part 4 of 8: cycles and the draft order of a cycle. Split from one file so each part fits one apply call;
-- the parts run in name order. Every statement is safe to run twice. No drop statement, no delete.

create index if not exists recurring_billing_cycles_billing_idx on public.recurring_billing_cycles (organization_id, billing_id, cycle_on);
create index if not exists recurring_billing_cycles_document_idx on public.recurring_billing_cycles (organization_id, accounting_document_id);
-- review L4: one document links to at most one cycle
create unique index if not exists recurring_billing_cycles_document_once on public.recurring_billing_cycles (organization_id, accounting_document_id)
  where accounting_document_id is not null;
create index if not exists recurring_billing_cycles_task_idx on public.recurring_billing_cycles (organization_id, task_id);

alter table public.recurring_billing_cycles enable row level security;
revoke all on public.recurring_billing_cycles from anon, authenticated;
grant select on public.recurring_billing_cycles to authenticated;
grant update (accounting_document_id, status) on public.recurring_billing_cycles to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_cycles' and policyname = 'recurring_billing_cycles_select') then
    create policy recurring_billing_cycles_select on public.recurring_billing_cycles for select to authenticated
      using (exists (select 1 from public.recurring_billings b
                      where b.organization_id = recurring_billing_cycles.organization_id and b.id = recurring_billing_cycles.billing_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_cycles' and policyname = 'recurring_billing_cycles_update') then
    create policy recurring_billing_cycles_update on public.recurring_billing_cycles for update to authenticated
      using (app.recurring_billing_writer(organization_id)
             and exists (select 1 from public.recurring_billings b
                          where b.organization_id = recurring_billing_cycles.organization_id and b.id = recurring_billing_cycles.billing_id))
      with check (app.recurring_billing_writer(organization_id));
  end if;
end;
$$;

-- A person's write: only the document link and the status (column grants); the document read under the caller's RLS, so an
-- unreadable one answers like a missing one. Invoker on purpose (current RLS of accounting_documents).
create or replace function app.recurring_billing_cycles_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_billing record;
  v_doc record;
begin
  if auth.uid() is null then
    return new;
  end if;
  if not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if row(new.organization_id, new.billing_id, new.cycle_on, new.period_end, new.net_agorot, new.vat_agorot, new.total_agorot,
         new.vat_rate_bp, new.task_id, new.order_id, new.created_at)
     is distinct from row(old.organization_id, old.billing_id, old.cycle_on, old.period_end, old.net_agorot, old.vat_agorot,
         old.total_agorot, old.vat_rate_bp, old.task_id, old.order_id, old.created_at)
     and not (pg_trigger_depth() > 1 and ((old.task_id is not null and new.task_id is null) or (old.order_id is not null and new.order_id is null))) then
    raise exception 'a cycle keeps its date and amounts' using errcode = 'P0001', hint = 'recurring_cycle:fixed';
  end if;
  if new.accounting_document_id is distinct from old.accounting_document_id then
    if new.accounting_document_id is not null then
      select b.contact_id, b.company_id, b.deal_id into v_billing
        from public.recurring_billings b where b.organization_id = new.organization_id and b.id = new.billing_id;
      select d.contact_id, d.company_id, d.deal_id, d.status, d.doc_type,
             (select c.company_id from public.contacts c where c.organization_id = d.organization_id and c.id = d.contact_id) as contact_company
        into v_doc
        from public.accounting_documents d where d.organization_id = new.organization_id and d.id = new.accounting_document_id;
      if not found or v_doc.status <> 'active' or v_doc.doc_type not in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'proforma')
         -- review L4: the billing's own customer (a contact's own document; a company's, or one of its contacts'), not merely
         -- the same deal
         or not ((v_billing.contact_id is not null and v_doc.contact_id = v_billing.contact_id)
                 or (v_billing.company_id is not null and (v_doc.company_id = v_billing.company_id or v_doc.contact_company = v_billing.company_id))) then
        raise exception 'an active invoice or receipt of the same customer' using errcode = 'P0001', hint = 'recurring_cycle:document';
      end if;
      -- one document is the record of one cycle (the unique index holds it under races)
      if exists (select 1 from public.recurring_billing_cycles c
                  where c.organization_id = new.organization_id and c.accounting_document_id = new.accounting_document_id and c.id <> new.id) then
        raise exception 'the document is already the record of another cycle' using errcode = 'P0001', hint = 'recurring_cycle:document_used';
      end if;
      new.status := 'documented';
      new.documented_at := now();
    else
      new.documented_at := null;
      if new.status = 'documented' then
        new.status := 'due';
      end if;
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'documented' or (new.status = 'skipped' and new.accounting_document_id is not null) then
      raise exception 'a documented cycle names its document' using errcode = 'P0001', hint = 'recurring_cycle:status';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.recurring_billing_cycles_check() from public, anon, authenticated;

-- a documented or skipped cycle closes its open task (definer: the task may be another person's)
create or replace function app.recurring_billing_cycles_close_task() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.task_id is not null and new.status in ('documented', 'skipped') and new.status is distinct from old.status then
    update public.tasks t
       set status = 'done',
           outcome = case new.status when 'documented' then 'נסגרה: נרשם מסמך למחזור' else 'נסגרה: המחזור דולג' end
     where t.organization_id = new.organization_id and t.id = new.task_id and t.status = 'open';
  -- review L4: a cycle back to waiting reopens the task the cycle closed (never one a person closed with their own note)
  elsif new.task_id is not null and new.status = 'due' and old.status in ('documented', 'skipped') then
    update public.tasks t set status = 'open', outcome = null
     where t.organization_id = new.organization_id and t.id = new.task_id and t.status = 'done'
       and t.outcome in ('נסגרה: נרשם מסמך למחזור', 'נסגרה: המחזור דולג');
  end if;
  return null;
end;
$$;
revoke all on function app.recurring_billing_cycles_close_task() from public, anon, authenticated;

create or replace trigger recurring_billing_cycles_check before update on public.recurring_billing_cycles
  for each row execute function app.recurring_billing_cycles_check();
create or replace trigger recurring_billing_cycles_touch before update on public.recurring_billing_cycles
  for each row execute function app.touch_row();
-- a person's link or status (the task's set-null, from a purge, is not logged)
create or replace trigger recurring_billing_cycles_audit after update of accounting_document_id, status on public.recurring_billing_cycles
  for each row execute function app.audit_row();
create or replace trigger recurring_billing_cycles_close_task after update on public.recurring_billing_cycles
  for each row execute function app.recurring_billing_cycles_close_task();

-- the events trigger reads cycles, so it is made after them
create or replace trigger recurring_billings_events after insert or update on public.recurring_billings
  for each row execute function app.recurring_billings_events();

-- ----------------------------------------------------------------------------
-- The job (SUB-02 method A)
-- ----------------------------------------------------------------------------
create table if not exists app.recurring_billing_failures (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  billing_id       uuid not null,
  cycle_on         date not null,
  failures         integer not null default 0,
  last_attempt_at  timestamptz,
  primary key (billing_id, cycle_on),
  constraint recurring_billing_failures_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade
);
create index if not exists recurring_billing_failures_org_idx on app.recurring_billing_failures (organization_id, billing_id);
alter table app.recurring_billing_failures enable row level security;
revoke all on app.recurring_billing_failures from public, anon, authenticated, service_role;

create table if not exists app.recurring_billing_turns (
  organization_id  uuid primary key references public.organizations (id) on delete cascade,
  served_at        timestamptz not null
);
alter table app.recurring_billing_turns enable row level security;
revoke all on app.recurring_billing_turns from public, anon, authenticated, service_role;

create or replace function app.recurring_billing_per_org() returns integer language sql stable set search_path = '' as $$
  select least(200, greatest(1, coalesce(nullif(current_setting('app.recurring_billing_per_org', true), '')::integer, 200)))
$$;
create or replace function app.recurring_billing_limit() returns integer language sql stable set search_path = '' as $$
  select least(2000, greatest(1, coalesce(nullif(current_setting('app.recurring_billing_limit', true), '')::integer, 2000)))
$$;
revoke all on function app.recurring_billing_per_org() from public, anon, authenticated, service_role;
revoke all on function app.recurring_billing_limit() from public, anon, authenticated, service_role;

-- the rep of a billing: MNY-01's owner rule (the deal's owner, else the customer's), an active full-seat non-viewer; else the
-- business's owner, else its oldest admin
create or replace function app.recurring_billing_rep(p_org uuid, p_billing uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select m.user_id
       from public.recurring_billings b
       left join public.deals dl on dl.organization_id = b.organization_id and dl.id = b.deal_id and dl.deleted_at is null
       left join public.contacts ct on ct.organization_id = b.organization_id and ct.id = b.contact_id
       left join public.companies co on co.organization_id = b.organization_id and co.id = b.company_id
       join public.memberships m on m.organization_id = b.organization_id
        and m.user_id = coalesce(dl.owner_id, ct.owner_id, co.owner_id)
        and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
      where b.organization_id = p_org and b.id = p_billing),
    (select m.user_id from public.memberships m
      where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin')
      order by (m.role = 'owner') desc, m.created_at, m.user_id
      limit 1))
$$;
revoke all on function app.recurring_billing_rep(uuid, uuid) from public, anon, authenticated, service_role;



-- owner (352) ב: the draft order of one cycle: the billing's customer, its live deal of the same customer, its lines as
-- priced in the billing (one-time lines of this cycle's charge), the billing's VAT mode, owner = the rep. Written as the server
-- (app.order_server, no session in the job), so every order rule of app.orders_check / app.order_lines_check applies to a
-- server's manual draft. Only with the `orders` key and the orders module on; null otherwise. The caller holds an exception
-- block: a refused order leaves the cycle and its task, and one `order_not_made` event.
create or replace function app.recurring_cycle_order(p_org uuid, p_billing uuid, p_rep uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.recurring_billings;
  v_order uuid := gen_random_uuid();
  v_deal uuid;
  v_server text := current_setting('app.order_server', true);
begin
  if not app.org_has_feature(p_org, 'orders')
     or not coalesce((select mo.orders_enabled from public.org_modules mo where mo.organization_id = p_org), false) then
    return null;
  end if;
  select * into v_b from public.recurring_billings b where b.organization_id = p_org and b.id = p_billing;
  select d.id into v_deal from public.deals d
   where d.organization_id = p_org and d.id = v_b.deal_id and d.deleted_at is null
     and d.contact_id is not distinct from v_b.contact_id
     and (v_b.company_id is null or d.company_id = v_b.company_id);
  -- delta review L-c (CAL-13's rule): the rep owns the draft only while they read its parent (the deal when attached, else the
  -- contact, else the company); otherwise the draft has no owner
  if p_rep is not null and not coalesce((
       select app.user_can_read_record(p_org, p_rep, r.owner_id, r.team_id)
         from (select d.owner_id, d.team_id from public.deals d where d.organization_id = p_org and d.id = v_deal
               union all
               select c.owner_id, c.team_id from public.contacts c where c.organization_id = p_org and c.id = v_b.contact_id and v_deal is null
               union all
               select co.owner_id, co.team_id from public.companies co
                where co.organization_id = p_org and co.id = v_b.company_id and v_deal is null and v_b.contact_id is null) r
        limit 1), false) then
    p_rep := null;
  end if;
  perform set_config('app.order_server', 'on', true);
  -- the order is dated the day it is made, and its VAT is that day's (app.orders_check sets order_date for every new order); the
  -- cycle row keeps the amounts at the cycle date's rate
  insert into public.orders (id, organization_id, status, source, deal_id, contact_id, company_id, owner_id, prices_include_vat, currency)
  values (v_order, p_org, 'draft', 'manual', v_deal, v_b.contact_id, v_b.company_id, p_rep, v_b.prices_include_vat, 'ILS');
  insert into public.order_lines (organization_id, order_id, position, kind, product_id, name, description, quantity, unit_price_agorot,
                                  discount_bp, discount_agorot, vat_exempt, billing, price_source, price_list_id, currency)
  select p_org, v_order, row_number() over (order by l.position, l.id), 'item', l.product_id, left(btrim(l.description), 300),
         case when char_length(btrim(l.description)) > 300 then l.description end,
         l.quantity, l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt, 'one_time',
         case when l.price_source = 'price_list' and l.price_list_id is null then 'manual' else l.price_source end,
         l.price_list_id, 'ILS'
    from public.recurring_billing_lines l
   where l.organization_id = p_org and l.billing_id = p_billing
   order by l.position, l.id;
  perform set_config('app.order_server', coalesce(v_server, ''), true);
  return v_order;
end;
$$;
revoke all on function app.recurring_cycle_order(uuid, uuid, uuid) from public, anon, authenticated, service_role;
