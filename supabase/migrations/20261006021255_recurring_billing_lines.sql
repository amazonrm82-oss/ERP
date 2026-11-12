-- SUB-01..SUB-05, part 3 of 8: history and lines. Split from one file so each part fits one apply call;
-- the parts run in name order. Every statement is safe to run twice. No drop statement, no delete.

create or replace function app.recurring_billings_events() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_commitment date;
begin
  if not app.org_exists(new.organization_id) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on, actor_id)
    values (new.organization_id, new.id, 'created', new.next_cycle_on, auth.uid());
    return null;
  end if;
  if new.status is distinct from old.status then
    v_kind := case new.status when 'paused' then 'paused' when 'cancelled' then 'cancelled' when 'failed' then 'failed'
                              else 'resumed' end;
    if v_kind = 'cancelled' then
      v_commitment := case when new.commitment_months > 0
                           then (new.start_date + make_interval(months => new.commitment_months))::date - 1 end;
      insert into public.recurring_billing_events (organization_id, billing_id, kind, reason, in_commitment, effective_on, actor_id)
      values (new.organization_id, new.id, 'cancelled', new.cancel_reason,
              v_commitment is not null and app.recurring_today(new.organization_id) <= v_commitment, v_commitment, auth.uid());
    else
      insert into public.recurring_billing_events (organization_id, billing_id, kind, make_up, effective_on, actor_id)
      values (new.organization_id, new.id, v_kind, case when v_kind = 'resumed' then current_setting('app.recurring_resume_make_up', true) = new.id::text end,
              new.next_cycle_on, auth.uid());
    end if;
    -- review L1: a resumed billing starts with a clean failure count
    if v_kind = 'resumed' then
      update app.recurring_billing_failures f set failures = 0, last_attempt_at = null
       where f.organization_id = new.organization_id and f.billing_id = new.id and f.failures > 0;
    end if;
  elsif new.billing_day is distinct from old.billing_day then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on, actor_id)
    values (new.organization_id, new.id, 'day_changed', new.next_cycle_on, auth.uid());
  end if;
  if new.status = 'active' and old.next_cycle_on is not null and new.next_cycle_on is null and new.end_date is not null then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on, actor_id)
    values (new.organization_id, new.id, 'ended', new.end_date, auth.uid());
  end if;
  if new.amount_agorot is distinct from old.amount_agorot
     and exists (select 1 from public.recurring_billing_cycles c where c.organization_id = new.organization_id and c.billing_id = new.id) then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, old_amount_agorot, new_amount_agorot, effective_on, actor_id)
    values (new.organization_id, new.id, 'price_changed', old.amount_agorot, new.amount_agorot, new.next_cycle_on, auth.uid());
  end if;
  return null;
end;
$$;
revoke all on function app.recurring_billings_events() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Lines
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_billing_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  billing_id         uuid not null,
  position           integer not null default 0 check (position between 0 and 100000),
  product_id         uuid,
  description        text not null check (char_length(btrim(description)) between 1 and 1000),
  quantity           numeric not null default 1,
  unit_price_agorot  bigint not null default 0 check (unit_price_agorot between 0 and 1000000000000),
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot    bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  total_agorot       bigint not null default 0,
  vat_exempt         boolean not null default false,
  price_source       text not null default 'manual' check (price_source in ('product', 'price_list', 'manual')),
  price_list_id      uuid,
  price_list_name    text,
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint recurring_billing_lines_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade,
  -- no action: a product on a line cannot be removed, only archived (PRD-02)
  constraint recurring_billing_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint recurring_billing_lines_price_list_fk foreign key (organization_id, price_list_id)
    references public.price_lists (organization_id, id) on delete set null (price_list_id),
  constraint recurring_billing_lines_quantity check (quantity > 0 and quantity <= 1000000 and quantity = round(quantity, 3)),
  constraint recurring_billing_lines_one_discount check (discount_bp is null or discount_agorot is null),
  constraint recurring_billing_lines_free_manual check (product_id is not null or price_source = 'manual'),
  constraint recurring_billing_lines_list_source check (price_source = 'price_list' or price_list_id is null)
);
create index if not exists recurring_billing_lines_billing_idx on public.recurring_billing_lines (organization_id, billing_id, position);
create index if not exists recurring_billing_lines_product_idx on public.recurring_billing_lines (organization_id, product_id);
create index if not exists recurring_billing_lines_price_list_idx on public.recurring_billing_lines (organization_id, price_list_id);

alter table public.recurring_billing_lines enable row level security;
revoke all on public.recurring_billing_lines from anon, authenticated;
grant select, delete on public.recurring_billing_lines to authenticated;
grant insert (organization_id, billing_id, position, product_id, description, quantity, unit_price_agorot, discount_bp,
              discount_agorot, vat_exempt, price_source, price_list_id, currency)
  on public.recurring_billing_lines to authenticated;
grant update (position, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, price_source,
              price_list_id, currency)
  on public.recurring_billing_lines to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_select') then
    create policy recurring_billing_lines_select on public.recurring_billing_lines for select to authenticated
      using (exists (select 1 from public.recurring_billings b
                      where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_insert') then
    create policy recurring_billing_lines_insert on public.recurring_billing_lines for insert to authenticated
      with check (app.recurring_billing_writer(organization_id)
                  and exists (select 1 from public.recurring_billings b
                               where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id
                                 and b.status <> 'cancelled'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_update') then
    create policy recurring_billing_lines_update on public.recurring_billing_lines for update to authenticated
      using (app.recurring_billing_writer(organization_id)
             and exists (select 1 from public.recurring_billings b
                          where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id
                            and b.status <> 'cancelled'))
      with check (app.recurring_billing_writer(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_delete') then
    create policy recurring_billing_lines_delete on public.recurring_billing_lines for delete to authenticated
      using (app.recurring_billing_writer(organization_id)
             and exists (select 1 from public.recurring_billings b
                          where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id
                            and b.status <> 'cancelled'));
  end if;
end;
$$;

-- deal_lines_check's rules for a billing's line (DLI-01, PL-03), in the billing's VAT mode, for every writer
create or replace function app.recurring_billing_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_mode boolean;
  v_status text;
  v_kind text;
  v_active boolean;
  v_archived timestamptz;
  v_name text;
  v_totals jsonb;
begin
  -- outsider guard: a person who may not write here is refused by RLS (42501) right after this trigger
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  select b.prices_include_vat, b.status into v_mode, v_status
    from public.recurring_billings b where b.organization_id = new.organization_id and b.id = new.billing_id;
  if not found then
    -- the foreign key refuses the row (23503)
    return new;
  end if;
  if v_status = 'cancelled' then
    raise exception 'a cancelled recurring billing does not change' using errcode = 'P0001', hint = 'recurring_billing:cancelled';
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('recurring_billing_lines:' || new.billing_id::text, 0));
    if (select count(*) from public.recurring_billing_lines l
         where l.organization_id = new.organization_id and l.billing_id = new.billing_id) >= 200 then
      raise exception 'at most 200 lines in a recurring billing' using errcode = 'P0001', hint = 'recurring_billing_lines:max';
    end if;
    if new.product_id is not null then
      if not app.org_has_feature(new.organization_id, 'products') then
        raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
      end if;
      select p.vat_kind, p.is_active, p.archived_at into v_kind, v_active, v_archived
        from public.products p where p.organization_id = new.organization_id and p.id = new.product_id;
      if found then
        if auth.uid() is not null and (not v_active or v_archived is not null) then
          raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'recurring_billing_lines:product';
        end if;
        new.vat_exempt := v_kind <> 'taxable';
      end if;
    else
      new.vat_exempt := coalesce(new.vat_exempt, false);
    end if;
  else
    new.organization_id := old.organization_id;
    new.billing_id := old.billing_id;
    new.product_id := old.product_id;
    if old.product_id is not null then
      new.vat_exempt := old.vat_exempt;
    else
      new.vat_exempt := coalesce(new.vat_exempt, old.vat_exempt);
    end if;
  end if;

  if (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  if new.price_source <> 'price_list' then
    if new.price_list_id is not null and auth.uid() is not null then
      raise exception 'only a price from a price list names a list' using errcode = 'P0001', hint = 'recurring_billing_lines:price_list';
    end if;
    new.price_list_id := null;
    new.price_list_name := null;
  elsif new.price_list_id is not null and (tg_op = 'INSERT' or new.price_list_id is distinct from old.price_list_id) then
    if not app.org_has_feature(new.organization_id, 'price_lists') then
      raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
    end if;
    select l.name into v_name from public.price_lists l where l.organization_id = new.organization_id and l.id = new.price_list_id;
    new.price_list_name := v_name;
  elsif tg_op = 'INSERT' then
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'recurring_billing_lines:price_list';
  else
    -- a list removed (set null) or unchanged: the line keeps the name it was priced by
    new.price_list_name := old.price_list_name;
  end if;

  v_totals := app.document_totals(
    jsonb_build_array(jsonb_build_object(
      'quantity', new.quantity, 'unit_price_agorot', new.unit_price_agorot, 'discount_bp', new.discount_bp,
      'discount_agorot', new.discount_agorot, 'vat_exempt', new.vat_exempt)),
    0, v_mode);
  new.total_agorot := (v_totals #>> '{lines,0,total_agorot}')::bigint;
  return new;
end;
$$;
revoke all on function app.recurring_billing_lines_check() from public, anon, authenticated;

-- one cycle's amounts of a billing at the VAT rate of a day (null rate: VAT status not set, counted as no VAT)
create or replace function app.recurring_billing_totals(p_org uuid, p_billing uuid, p_day date) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_mode boolean;
  v_rate integer;
  v_lines jsonb;
begin
  select b.prices_include_vat into v_mode from public.recurring_billings b where b.organization_id = p_org and b.id = p_billing;
  if not found then
    return null;
  end if;
  v_rate := app.org_document_vat_rate(p_org, p_day);
  select coalesce(jsonb_agg(jsonb_build_object(
           'quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot, 'discount_bp', l.discount_bp,
           'discount_agorot', l.discount_agorot, 'vat_exempt', l.vat_exempt) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.recurring_billing_lines l where l.organization_id = p_org and l.billing_id = p_billing;
  return app.document_totals(v_lines, coalesce(v_rate, 0), v_mode) || jsonb_build_object('rate_known', v_rate is not null);
end;
$$;
revoke all on function app.recurring_billing_totals(uuid, uuid, date) from public, anon, authenticated, service_role;

-- the billing's amount after its lines changed (a server write of the server-kept column)
create or replace function app.recurring_billing_lines_recompute() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_billing uuid := coalesce(new.billing_id, old.billing_id);
  v_net bigint;
begin
  if not app.org_exists(v_org)
     or not exists (select 1 from public.recurring_billings b where b.organization_id = v_org and b.id = v_billing) then
    return null;
  end if;
  v_net := (app.recurring_billing_totals(v_org, v_billing, app.recurring_today(v_org)) ->> 'net_total_agorot')::bigint;
  perform set_config('app.recurring_billing_server', v_org::text, true);
  update public.recurring_billings b set amount_agorot = coalesce(v_net, 0)
   where b.organization_id = v_org and b.id = v_billing and b.amount_agorot is distinct from coalesce(v_net, 0);
  perform set_config('app.recurring_billing_server', '', true);
  return null;
end;
$$;
revoke all on function app.recurring_billing_lines_recompute() from public, anon, authenticated;

create or replace trigger recurring_billing_lines_check before insert or update on public.recurring_billing_lines
  for each row execute function app.recurring_billing_lines_check();
create or replace trigger recurring_billing_lines_touch before update on public.recurring_billing_lines
  for each row execute function app.touch_row();
-- the list's set-null alone (a removed price list, or the business deleted) is not logged
create or replace trigger recurring_billing_lines_audit after insert or delete on public.recurring_billing_lines
  for each row execute function app.audit_row();
create or replace trigger recurring_billing_lines_audit_update after update of position, description, quantity, unit_price_agorot,
  discount_bp, discount_agorot, vat_exempt, price_source on public.recurring_billing_lines
  for each row execute function app.audit_row();
create or replace trigger recurring_billing_lines_recompute after insert or update or delete on public.recurring_billing_lines
  for each row execute function app.recurring_billing_lines_recompute();

-- ----------------------------------------------------------------------------
-- Cycles (server written; a recorder links the document or skips the cycle)
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_billing_cycles (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  billing_id              uuid not null,
  cycle_on                date not null,
  period_end              date not null,
  net_agorot              bigint not null,
  vat_agorot              bigint not null,
  total_agorot            bigint not null,
  vat_rate_bp             integer,
  currency                text not null default 'ILS' check (currency = 'ILS'),
  status                  text not null default 'due' check (status in ('due', 'documented', 'skipped')),
  accounting_document_id  uuid,
  task_id                 uuid,
  documented_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, id),
  constraint recurring_billing_cycles_once unique (billing_id, cycle_on),
  constraint recurring_billing_cycles_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade,
  constraint recurring_billing_cycles_document_fk foreign key (organization_id, accounting_document_id)
    references public.accounting_documents (organization_id, id) on delete set null (accounting_document_id),
  constraint recurring_billing_cycles_task_fk foreign key (organization_id, task_id)
    references public.tasks (organization_id, id) on delete set null (task_id),
  constraint recurring_billing_cycles_documented check (status <> 'documented' or accounting_document_id is not null)
);
-- owner (352) ב: the draft order the job made for the cycle (server only; a removed draft clears it)
alter table public.recurring_billing_cycles add column if not exists order_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recurring_billing_cycles_order_fk' and conrelid = 'public.recurring_billing_cycles'::regclass) then
    alter table public.recurring_billing_cycles add constraint recurring_billing_cycles_order_fk foreign key (organization_id, order_id)
      references public.orders (organization_id, id) on delete set null (order_id);
  end if;
end;
$$;
create index if not exists recurring_billing_cycles_order_idx on public.recurring_billing_cycles (organization_id, order_id);
