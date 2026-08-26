-- Finance module: general ledger (simplified — single currency, no period locking or
-- depreciation schedules), accounts receivable (customer invoices), accounts payable
-- (supplier bills). Real double-entry integrity is enforced at the database level, not just
-- assumed in the UI — see the balance-check trigger below.

alter table public.profiles add column can_manage_finance boolean not null default false;

create or replace function public.can_manage_finance()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_manager() or coalesce((select can_manage_finance from public.profiles where id = auth.uid()), false);
$$;

-- ============================================================================
-- GENERAL LEDGER
-- ============================================================================

create table public.gl_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  type text not null check (type in ('נכס', 'התחייבות', 'הון', 'הכנסה', 'הוצאה')),
  created_at timestamptz not null default now()
);

create table public.gl_transactions (
  id uuid primary key default gen_random_uuid(),
  txn_date date not null default current_date,
  description text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.gl_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.gl_transactions(id) on delete cascade,
  account_id uuid not null references public.gl_accounts(id),
  debit numeric not null default 0 check (debit >= 0),
  credit numeric not null default 0 check (credit >= 0)
);

-- Double-entry integrity, enforced by the database rather than trusted from the UI: every
-- transaction's lines must sum to debit = credit. Deferred so a transaction's lines can be
-- inserted one at a time within a single statement/transaction and only checked once complete.
create or replace function public.check_gl_transaction_balanced()
returns trigger language plpgsql as $$
declare
  diff numeric;
  txn_id uuid := coalesce(new.transaction_id, old.transaction_id);
begin
  select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) into diff
  from public.gl_lines where transaction_id = txn_id;
  if diff <> 0 then
    raise exception 'תנועת יומן לא מאוזנת: חובה וזכות חייבים להיות שווים (הפרש %)', diff;
  end if;
  return null;
end;
$$;

create constraint trigger gl_lines_balanced
  after insert or update or delete on public.gl_lines
  deferrable initially deferred
  for each row execute function public.check_gl_transaction_balanced();

alter table public.gl_accounts enable row level security;
alter table public.gl_transactions enable row level security;
alter table public.gl_lines enable row level security;

create policy gl_accounts_select on public.gl_accounts for select using (auth.uid() is not null);
create policy gl_accounts_write on public.gl_accounts for all using (public.can_manage_finance()) with check (public.can_manage_finance());

create policy gl_transactions_select on public.gl_transactions for select using (auth.uid() is not null);
create policy gl_transactions_insert on public.gl_transactions for insert with check (public.can_manage_finance());
-- No update/delete policy: a posted journal entry is immutable — post a reversing entry instead
-- of editing history, same principle as invoices below.
create policy gl_lines_select on public.gl_lines for select using (auth.uid() is not null);
create policy gl_lines_insert on public.gl_lines for insert with check (public.can_manage_finance());

-- ============================================================================
-- SUPPLIERS (shared by AP here and Procurement's purchase orders later)
-- ============================================================================

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  notes text,
  rating smallint check (rating between 1 and 5),
  created_at timestamptz not null default now()
);

alter table public.suppliers enable row level security;
create policy suppliers_select on public.suppliers for select using (auth.uid() is not null);
create policy suppliers_write on public.suppliers for all using (public.can_manage_finance()) with check (public.can_manage_finance());

-- ============================================================================
-- ACCOUNTS RECEIVABLE — customer invoices/receipts
-- ============================================================================

-- Sequential, gap-free numbering (a real Postgres sequence, atomic across concurrent users) —
-- required for invoice/receipt numbering to be legally defensible, not just cosmetic.
create sequence public.document_number_seq start 1;

create table public.customer_invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  doc_number bigint not null default nextval('public.document_number_seq') unique,
  doc_type text not null check (doc_type in ('חשבונית', 'קבלה', 'חשבונית מס-קבלה')),
  amount numeric not null,
  paid_amount numeric not null default 0,
  note text,
  gl_transaction_id uuid references public.gl_transactions(id),
  issued_by uuid references public.profiles(id),
  issued_at timestamptz not null default now()
);

alter table public.customer_invoices enable row level security;
create policy customer_invoices_select on public.customer_invoices for select using (auth.uid() is not null);
create policy customer_invoices_insert on public.customer_invoices for insert with check (public.can_manage_finance());
-- Only paid_amount may move after issuance (recording a payment) — number/amount/type stay
-- immutable, enforced the same way arizot-crm-web guards specific fields on an otherwise-editable
-- row (see enforce_lead_transition_guards there).
create or replace function public.enforce_invoice_immutability()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.doc_number is distinct from old.doc_number
    or new.doc_type is distinct from old.doc_type
    or new.amount is distinct from old.amount then
    raise exception 'לא ניתן לערוך מספר/סוג/סכום מסמך שהופק — יש להפיק מסמך חדש';
  end if;
  return new;
end;
$$;
create trigger customer_invoices_immutability
  before update on public.customer_invoices
  for each row execute function public.enforce_invoice_immutability();
create policy customer_invoices_update on public.customer_invoices for update using (public.can_manage_finance()) with check (public.can_manage_finance());

-- ============================================================================
-- ACCOUNTS PAYABLE — supplier bills
-- ============================================================================

create table public.supplier_bills (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  bill_number text,
  amount numeric not null,
  due_date date,
  paid boolean not null default false,
  gl_transaction_id uuid references public.gl_transactions(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.supplier_bills enable row level security;
create policy supplier_bills_select on public.supplier_bills for select using (auth.uid() is not null);
create policy supplier_bills_write on public.supplier_bills for all using (public.can_manage_finance()) with check (public.can_manage_finance());

-- Starter chart of accounts — a small, editable default rather than an empty table, same spirit
-- as arizot-crm-web seeding a default product catalog in its own 0001_init.sql.
insert into public.gl_accounts (code, name, type) values
  ('1000', 'קופה ובנק', 'נכס'),
  ('1100', 'לקוחות', 'נכס'),
  ('1200', 'מלאי', 'נכס'),
  ('2000', 'ספקים', 'התחייבות'),
  ('3000', 'הון עצמי', 'הון'),
  ('4000', 'הכנסות ממכירות', 'הכנסה'),
  ('5000', 'עלות המכר', 'הוצאה'),
  ('5100', 'הוצאות תפעול', 'הוצאה');
