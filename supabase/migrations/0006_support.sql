-- Customer support: tickets + a message thread per ticket, same shape as a typical lead-notes/
-- lead-messages pairing — one row per ticket, a child table for the back-and-forth.

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  subject text not null,
  status text not null default 'פתוח' check (status in ('פתוח', 'בטיפול', 'סגור')),
  priority text not null default 'רגילה' check (priority in ('נמוכה', 'רגילה', 'גבוהה')),
  assigned_to uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_id uuid references public.profiles(id),
  text text not null,
  created_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;
alter table public.ticket_messages enable row level security;

create policy support_tickets_select on public.support_tickets for select using (auth.uid() is not null);
create policy support_tickets_insert on public.support_tickets for insert with check (auth.uid() is not null);
create policy support_tickets_update on public.support_tickets for update using (auth.uid() is not null) with check (auth.uid() is not null);

create policy ticket_messages_select on public.ticket_messages for select using (auth.uid() is not null);
create policy ticket_messages_insert on public.ticket_messages for insert with check (auth.uid() is not null);
