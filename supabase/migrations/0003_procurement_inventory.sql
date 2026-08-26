-- Procurement (requisition -> purchase order -> receiving) and inventory (append-only stock
-- ledger). Receiving a PO automatically posts a stock movement and an AP bill — one real action,
-- not two disconnected screens the user has to keep in sync by hand.

alter table public.profiles add column can_manage_procurement boolean not null default false;

create or replace function public.can_manage_procurement()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_manager() or coalesce((select can_manage_procurement from public.profiles where id = auth.uid()), false);
$$;

-- ============================================================================
-- INVENTORY
-- ============================================================================

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text not null default 'יח׳',
  location text,
  reorder_threshold numeric not null default 0,
  created_at timestamptz not null default now()
);

-- Append-only, deliberately: current stock is always derived as sum(delta), never a field
-- overwritten in place. That's a real departure from how every other "current state" column in
-- this schema works (e.g. supplier_bills.paid) — worth it here because it's the only way to keep
-- a true audit trail of who changed how much stock and why. Don't "simplify" this back to a
-- mutable quantity column.
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id),
  delta numeric not null,
  reason text not null,
  reference_id uuid,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.inventory_items enable row level security;
alter table public.inventory_movements enable row level security;

create policy inventory_items_select on public.inventory_items for select using (auth.uid() is not null);
create policy inventory_items_write on public.inventory_items for all using (public.can_manage_procurement()) with check (public.can_manage_procurement());
create policy inventory_movements_select on public.inventory_movements for select using (auth.uid() is not null);
create policy inventory_movements_insert on public.inventory_movements for insert with check (public.can_manage_procurement());

-- ============================================================================
-- PROCUREMENT: requisition -> purchase order -> receiving
-- ============================================================================

create table public.purchase_requisitions (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references public.profiles(id),
  item_description text not null,
  qty numeric not null,
  notes text,
  status text not null default 'ממתין לאישור' check (status in ('ממתין לאישור', 'אושר', 'נדחה')),
  created_at timestamptz not null default now()
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  requisition_id uuid references public.purchase_requisitions(id),
  status text not null default 'ממתין לאישור' check (status in ('ממתין לאישור', 'אושר', 'הוזמן', 'התקבל', 'נדחה')),
  created_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  item_id uuid references public.inventory_items(id),
  description text not null,
  qty numeric not null,
  unit_cost numeric not null
);

alter table public.purchase_requisitions enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;

create policy purchase_requisitions_select on public.purchase_requisitions for select using (auth.uid() is not null);
create policy purchase_requisitions_insert on public.purchase_requisitions for insert with check (auth.uid() is not null);
create policy purchase_requisitions_update on public.purchase_requisitions for update using (public.can_manage_procurement()) with check (public.can_manage_procurement());

create policy purchase_orders_select on public.purchase_orders for select using (auth.uid() is not null);
create policy purchase_orders_insert on public.purchase_orders for insert with check (public.can_manage_procurement());
create policy purchase_orders_update on public.purchase_orders for update using (public.can_manage_procurement()) with check (public.can_manage_procurement());

create policy purchase_order_lines_select on public.purchase_order_lines for select using (auth.uid() is not null);
create policy purchase_order_lines_insert on public.purchase_order_lines for insert with check (public.can_manage_procurement());

-- Approving/receiving a PO is manager-level regardless of who created it, and receiving is a
-- one-way door (mirrors arizot-crm-web's enforce_lead_transition_guards pattern) — plus the
-- actual side effects of receiving (stock in, AP bill) belong in a trigger, not client code, so
-- they fire no matter which screen changed the status.
create or replace function public.enforce_po_transition_guards()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status in ('אושר', 'התקבל') and not public.is_manager() then
    raise exception 'רק מנהל יכול לאשר או לקבל הזמנת רכש';
  end if;
  if old.status = 'התקבל' and new.status is distinct from old.status then
    raise exception 'לא ניתן לשנות הזמנת רכש שכבר התקבלה';
  end if;

  if new.status = 'התקבל' and old.status is distinct from new.status then
    insert into public.inventory_movements (item_id, delta, reason, reference_id, created_by)
    select item_id, qty, 'קבלת הזמנת רכש', new.id, auth.uid()
    from public.purchase_order_lines
    where po_id = new.id and item_id is not null;

    insert into public.supplier_bills (supplier_id, bill_number, amount, created_by)
    select new.supplier_id, 'PO-' || new.id, coalesce(sum(qty * unit_cost), 0), auth.uid()
    from public.purchase_order_lines
    where po_id = new.id;
  end if;

  return new;
end;
$$;

create trigger purchase_orders_transition_guard
  before update on public.purchase_orders
  for each row execute function public.enforce_po_transition_guards();
