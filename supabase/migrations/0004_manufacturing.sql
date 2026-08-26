-- Light manufacturing: a bill of materials (what an assembled item is made of) and work orders
-- that consume component stock and produce finished-item stock when completed. Deliberately not
-- a full MRP/routing/MES system — no work centers, no scheduling, no capacity planning. Just the
-- part that's genuinely useful to a small shop: "finishing this thing uses up these other things."

create table public.bom_components (
  id uuid primary key default gen_random_uuid(),
  parent_item_id uuid not null references public.inventory_items(id),
  component_item_id uuid not null references public.inventory_items(id),
  qty_per_unit numeric not null check (qty_per_unit > 0),
  constraint bom_no_self_reference check (parent_item_id <> component_item_id)
);

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id),
  qty numeric not null check (qty > 0),
  status text not null default 'פתוחה' check (status in ('פתוחה', 'בייצור', 'הושלמה', 'בוטלה')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.bom_components enable row level security;
alter table public.work_orders enable row level security;

create policy bom_components_select on public.bom_components for select using (auth.uid() is not null);
create policy bom_components_write on public.bom_components for all using (public.can_manage_procurement()) with check (public.can_manage_procurement());

create policy work_orders_select on public.work_orders for select using (auth.uid() is not null);
create policy work_orders_insert on public.work_orders for insert with check (public.can_manage_procurement());
create policy work_orders_update on public.work_orders for update using (public.can_manage_procurement()) with check (public.can_manage_procurement());

-- Completing a work order is the one meaningful side effect: consume qty * qty_per_unit of each
-- component (negative movement) and produce qty of the finished item (positive movement) — no
-- stock check/reservation beyond that (a real availability check belongs in a fuller MRP system,
-- out of scope here; this trusts whoever completes the order to have verified it manually, same
-- trust level the rest of this schema places in can_manage_procurement()).
create or replace function public.enforce_work_order_completion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'הושלמה' and new.status is distinct from old.status then
    raise exception 'לא ניתן לשנות פקודת עבודה שכבר הושלמה';
  end if;

  if new.status = 'הושלמה' and old.status is distinct from new.status then
    new.completed_at := now();

    insert into public.inventory_movements (item_id, delta, reason, reference_id, created_by)
    select component_item_id, -1 * qty_per_unit * new.qty, 'צריכה לפקודת עבודה', new.id, auth.uid()
    from public.bom_components
    where parent_item_id = new.item_id;

    insert into public.inventory_movements (item_id, delta, reason, reference_id, created_by)
    values (new.item_id, new.qty, 'תוצרת פקודת עבודה', new.id, auth.uid());
  end if;

  return new;
end;
$$;

create trigger work_orders_completion_guard
  before update on public.work_orders
  for each row execute function public.enforce_work_order_completion();
