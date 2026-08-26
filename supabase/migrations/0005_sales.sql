-- Sales & CRM: leads -> quotes -> sales orders. Closing a sales order auto-posts a customer
-- invoice (AR) via trigger, the same "the DB wires the modules together" pattern as PO receiving
-- -> AP bill and work-order completion -> stock movement.

alter table public.profiles add column can_manage_sales boolean not null default false;

create or replace function public.can_manage_sales()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_manager() or coalesce((select can_manage_sales from public.profiles where id = auth.uid()), false);
$$;

create table public.sales_leads (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  contact_name text not null,
  phone text,
  status text not null default 'חדש' check (status in ('חדש', 'במגע', 'הצעת מחיר', 'נסגר', 'לא רלוונטי')),
  source text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.sales_leads(id),
  customer_id uuid references public.customers(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  description text not null,
  qty numeric not null,
  unit_price numeric not null
);

create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  quote_id uuid references public.quotes(id),
  status text not null default 'פתוחה' check (status in ('פתוחה', 'בייצור', 'נשלחה', 'נסגרה')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  description text not null,
  qty numeric not null,
  unit_price numeric not null
);

alter table public.sales_leads enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_lines enable row level security;
alter table public.sales_orders enable row level security;
alter table public.sales_order_lines enable row level security;

create policy sales_leads_select on public.sales_leads for select using (auth.uid() is not null);
create policy sales_leads_insert on public.sales_leads for insert with check (auth.uid() is not null);
create policy sales_leads_update on public.sales_leads for update using (auth.uid() is not null) with check (auth.uid() is not null);

create policy quotes_select on public.quotes for select using (auth.uid() is not null);
create policy quotes_insert on public.quotes for insert with check (auth.uid() is not null);
create policy quote_lines_select on public.quote_lines for select using (auth.uid() is not null);
create policy quote_lines_insert on public.quote_lines for insert with check (auth.uid() is not null);

create policy sales_orders_select on public.sales_orders for select using (auth.uid() is not null);
create policy sales_orders_insert on public.sales_orders for insert with check (auth.uid() is not null);
create policy sales_orders_update on public.sales_orders for update using (public.can_manage_sales()) with check (public.can_manage_sales());
create policy sales_order_lines_select on public.sales_order_lines for select using (auth.uid() is not null);
create policy sales_order_lines_insert on public.sales_order_lines for insert with check (auth.uid() is not null);

create or replace function public.enforce_sales_order_close()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'נסגרה' and new.status is distinct from old.status then
    raise exception 'לא ניתן לשנות הזמנת מכירה שכבר נסגרה';
  end if;

  if new.status = 'נסגרה' and old.status is distinct from new.status then
    insert into public.customer_invoices (customer_id, doc_type, amount, note, issued_by)
    select new.customer_id, 'חשבונית', coalesce(sum(qty * unit_price), 0), 'הזמנת מכירה ' || new.id, auth.uid()
    from public.sales_order_lines
    where order_id = new.id;
  end if;

  return new;
end;
$$;

create trigger sales_orders_close_guard
  before update on public.sales_orders
  for each row execute function public.enforce_sales_order_close();
