-- =============================================================================
-- BAL-02: the customer's open debt and overdue debt at the top of the contact and company cards, and as a column and a
-- filter in the contacts and companies lists (spec 7.2). Plan key `balances` with `documents` and `payments`, as BAL-01.
-- =============================================================================
-- * One rule for what a customer owes: the balances of public.money_allocation_state (PAY-02, the one rule, not changed
--   here) over the customer's active tax invoices, proformas and positive opening balances. A proforma billed by an active
--   tax invoice is 'transferred' (balance 0) and the invoice carries what is left, so nothing counts twice. The customer
--   is PAY-02's, as BAL-01's ledger takes it: a contact without a company = its own documents; a contact with a company and
--   the company itself = the company's documents (an opening balance of the company) and every document of the company's
--   contacts and deals. Open debt = the sum of the balances; overdue debt = the balances whose due_date is before the
--   business's today (its time zone; CLAUDE.md PAY-02 "באיחור"). A document with no due date is never overdue.
-- * The card (public.customer_debt_summary(org, contact, company), invoker: RLS decides): who may open it is BAL-01's
--   rule (app.can_record_payments with the three keys; anyone else gets {"allowed": false}), and BAL-01's partial rule
--   (owner's answer 3 ב of 25 October 2026): when the customer has any document or payment the caller cannot read
--   (app.customer_money_rows, the ledger's count), the answer is {"allowed": true, "partial": true} and no amount of any
--   kind. The scope and the partial check are the ledger's (keep in step with public.customer_ledger, not changed here);
--   test 262 compares open_debt with the ledger's. Accepted (as BAL-01's ledger): a caller who reads every row of the
--   customer but not the active tax invoice that bills one of its proformas (an invoice outside PAY-02's customer, or
--   one RLS hides) sees that proforma still owed; money_allocation_state counts it 'transferred' only for a reader of
--   the invoice.
-- * The lists (the PAY-03 pattern; owner's answer, 28 October 2026, BAL-02 (3) א): owners and admins only, who read every
--   document and payment, so a total kept by the server is exactly what their cards show. Why kept and not computed when
--   read: a list sorted or filtered by debt evaluates the value for every row it considers, and a contact of a company
--   would recompute the company's documents and their allocations once per contact (measured in scripts/perf/
--   customer-debt*.sql, see the report of BAL-02). Kept by triggers, in two server-only tables:
--     - public.debt_document_customers: one row per document and customer it belongs to (each company: the document's own
--       company, its contact's company, its deal's company, each once; and the document's contact) with its balance and
--       due date. A link that ends keeps its row at 0 (no row is ever removed by this file; the business, the document,
--       the company and the contact cascade).
--     - public.customer_debt_totals: one row per company and per contact: open_agorot (the sum of its open rows) and the
--       open amounts grouped by due date (due_dates[], due_amounts[], in due-date order, a null due date last). The
--       overdue part is summed when read, against the business's today, so it never goes stale at midnight.
--   Both are refreshed by definer app.debt_document_sync(org, document) for a document and the documents its balance
--   depends on (app.debt_document_family_sync: the proforma a tax invoice bills, the invoices that bill a proforma),
--   called by DEFERRABLE INITIALLY DEFERRED constraint triggers on accounting_documents, payment_allocations,
--   opening_credit_allocations and a contact's or a deal's company change (a payment's status change releases its
--   allocations, which is an update of payment_allocations). Every refresh first takes PAY-03's business lock
--   ('customer_credit:<org>', a transaction-level advisory lock): the credit totals and these debt totals are refreshed
--   at commit by one business at a time, so two commits never take their shared rows in opposite orders. Within one
--   refresh the companies are touched in id order, then the contacts. Each refresh recomputes from the state about to
--   be committed (a repeated refresh is a no-op).
--   Known and accepted, as on PAY-03's credit tables: a purge (or any delete) of a contact or company takes the row
--   locks of its FK cascades and set-nulls (these rows, documents, payments) during the statement, before the business
--   lock at its commit; a concurrent allocation's commit holds the business lock and then touches the same rows. The two
--   can meet in a rare deadlock (40P01): PostgreSQL cancels one and the caller retries. Taking the business lock in a
--   before-delete trigger would not remove it (the allocation's row locks come before its own commit-time lock).
--   The documents trigger fires only on the columns that move a balance or a customer (doc_type, status, amount_agorot,
--   due_date, contact_id, deal_id, company_id, proforma_id; the FK set-nulls of a purge are updates of those columns),
--   and app.debt_on_document returns before the lock when neither the old nor the new row is a debt type or bills a
--   proforma (a receipt, a credit invoice, an invoice-receipt), so those writes never wait for the business lock.
--   Computed fields public.debt_balance / overdue_debt (bigint) and has_debt / has_overdue_debt (boolean) on contacts and
--   companies: invoker, no SET, inlined (the advisor's function_search_path_mutable on them is expected, as on
--   credit_balance), over definer app.customer_debt_of (one indexed lookup; null to anyone who is not an owner or admin,
--   and to everyone while the business lacks one of the keys balances, documents and payments).
--   A contact with a company has its company's figures (PAY-02's customer), one without its own.
-- * Both tables carry `currency` (ILS only, TAX-06). When DEAL-12 opens other currencies the debt must be kept per
--   currency: `currency` joins both unique keys and the refresh sums per currency.
-- Every statement is safe to run twice. No object or row is removed.

-- ----------------------------------------------------------------------------
-- Each document's balance per customer, kept by the server
-- ----------------------------------------------------------------------------
create table if not exists public.debt_document_customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id     uuid not null,
  company_id      uuid,
  contact_id      uuid,
  balance_agorot  bigint not null default 0 check (balance_agorot >= 0),
  due_date        date,
  currency        text not null default 'ILS' check (currency = 'ILS'),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint debt_document_customers_one check ((company_id is null) <> (contact_id is null)),
  constraint debt_document_customers_company_once unique (organization_id, document_id, company_id),
  constraint debt_document_customers_contact_once unique (organization_id, document_id, contact_id),
  constraint debt_document_customers_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete cascade,
  constraint debt_document_customers_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade,
  constraint debt_document_customers_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade
);
create index if not exists debt_document_customers_document_idx on public.debt_document_customers (organization_id, document_id);
create index if not exists debt_document_customers_company_idx on public.debt_document_customers (organization_id, company_id);
create index if not exists debt_document_customers_contact_idx on public.debt_document_customers (organization_id, contact_id);

alter table public.debt_document_customers enable row level security;
revoke all on public.debt_document_customers from anon, authenticated;
grant select on public.debt_document_customers to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'debt_document_customers'
                  and policyname = 'debt_document_customers_select') then
    -- the rows hold every document's balance with all its allocations counted: owners and admins, who read them all
    create policy debt_document_customers_select on public.debt_document_customers for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

create or replace trigger debt_document_customers_touch before update on public.debt_document_customers
  for each row execute function app.touch_row();

-- the totals the list columns read: one row per company and per contact
create table if not exists public.customer_debt_totals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id      uuid,
  contact_id      uuid,
  open_agorot     bigint not null default 0 check (open_agorot >= 0),
  -- the open amounts grouped by due date, in due-date order (a null due date last); same length
  due_dates       date[] not null default '{}',
  due_amounts     bigint[] not null default '{}',
  currency        text not null default 'ILS' check (currency = 'ILS'),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint customer_debt_totals_one check ((company_id is null) <> (contact_id is null)),
  constraint customer_debt_totals_shape check (cardinality(due_dates) = cardinality(due_amounts)),
  constraint customer_debt_totals_company unique (organization_id, company_id),
  constraint customer_debt_totals_contact unique (organization_id, contact_id),
  constraint customer_debt_totals_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade,
  constraint customer_debt_totals_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade
);

alter table public.customer_debt_totals enable row level security;
revoke all on public.customer_debt_totals from anon, authenticated;
grant select on public.customer_debt_totals to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_debt_totals'
                  and policyname = 'customer_debt_totals_select') then
    -- the totals count every document of the customer: owners and admins, who read them all
    create policy customer_debt_totals_select on public.customer_debt_totals for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

create or replace trigger customer_debt_totals_touch before update on public.customer_debt_totals
  for each row execute function app.touch_row();

-- a customer's totals from its open rows (p_company or p_contact, one of them)
create or replace function app.customer_debt_refresh(p_org uuid, p_company uuid, p_contact uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_open bigint;
  v_dates date[];
  v_amounts bigint[];
begin
  if p_company is not null then
    if not exists (select 1 from public.companies c where c.organization_id = p_org and c.id = p_company) then
      return;
    end if;
  elsif p_contact is not null then
    if not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact) then
      return;
    end if;
  else
    return;
  end if;
  select coalesce(sum(g.amount), 0),
         coalesce(array_agg(g.due_date order by g.due_date nulls last), '{}'),
         coalesce(array_agg(g.amount order by g.due_date nulls last), '{}')
    into v_open, v_dates, v_amounts
    from (select r.due_date, sum(r.balance_agorot)::bigint as amount
            from public.debt_document_customers r
           where r.organization_id = p_org and r.balance_agorot > 0
             and ((p_company is not null and r.company_id = p_company) or (p_company is null and r.contact_id = p_contact))
           group by r.due_date) g;
  if p_company is not null then
    insert into public.customer_debt_totals as t (organization_id, company_id, open_agorot, due_dates, due_amounts)
    values (p_org, p_company, v_open, v_dates, v_amounts)
    on conflict (organization_id, company_id)
      do update set open_agorot = excluded.open_agorot, due_dates = excluded.due_dates, due_amounts = excluded.due_amounts
       where (t.open_agorot, t.due_dates, t.due_amounts) is distinct from (excluded.open_agorot, excluded.due_dates, excluded.due_amounts);
  else
    insert into public.customer_debt_totals as t (organization_id, contact_id, open_agorot, due_dates, due_amounts)
    values (p_org, p_contact, v_open, v_dates, v_amounts)
    on conflict (organization_id, contact_id)
      do update set open_agorot = excluded.open_agorot, due_dates = excluded.due_dates, due_amounts = excluded.due_amounts
       where (t.open_agorot, t.due_dates, t.due_amounts) is distinct from (excluded.open_agorot, excluded.due_dates, excluded.due_amounts);
  end if;
end;
$$;
revoke all on function app.customer_debt_refresh(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- one document's rows: its balance (money_allocation_state as the owner: every allocation counts) on each customer it
-- belongs to; then the totals of those customers (the ones it left too)
create or replace function app.debt_document_sync(p_org uuid, p_document uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_doc record;
  v_balance bigint := 0;
  v_companies uuid[];
  v_contact uuid;
  v_before_companies uuid[];
  v_before_contacts uuid[];
  v_id uuid;
begin
  -- PAY-03's business lock (see the header): one business's money totals are refreshed one commit at a time
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || p_org::text, 0));
  select d.id, d.doc_type, d.status, d.amount_agorot, d.due_date, d.contact_id, d.deal_id, d.company_id
    into v_doc
    from public.accounting_documents d
   where d.organization_id = p_org and d.id = p_document;
  if not found or v_doc.doc_type not in ('tax_invoice', 'proforma', 'opening_balance') then
    return;
  end if;
  if v_doc.status = 'active' and v_doc.amount_agorot > 0 then
    select coalesce((x ->> 'balance')::bigint, 0) into v_balance
      from jsonb_array_elements(public.money_allocation_state(p_org, array[p_document], '{}'::uuid[]) -> 'documents') x
     where (x ->> 'id')::uuid = p_document;
    v_balance := coalesce(v_balance, 0);
  end if;
  v_companies := array(select distinct x from unnest(array[
                   v_doc.company_id,
                   (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = v_doc.contact_id),
                   (select d.company_id from public.deals d where d.organization_id = p_org and d.id = v_doc.deal_id)]) x
                 where x is not null);
  v_contact := v_doc.contact_id;
  v_before_companies := array(select r.company_id from public.debt_document_customers r
                               where r.organization_id = p_org and r.document_id = p_document and r.company_id is not null
                                 and r.balance_agorot > 0);
  v_before_contacts := array(select r.contact_id from public.debt_document_customers r
                              where r.organization_id = p_org and r.document_id = p_document and r.contact_id is not null
                                and r.balance_agorot > 0);
  -- a customer the document left, or a balance that reached 0: the row stays at 0
  update public.debt_document_customers r set balance_agorot = 0
   where r.organization_id = p_org and r.document_id = p_document and r.balance_agorot <> 0
     and (v_balance = 0
          or (r.company_id is not null and not (r.company_id = any (v_companies)))
          or (r.contact_id is not null and r.contact_id is distinct from v_contact));
  if v_balance > 0 then
    insert into public.debt_document_customers as r (organization_id, document_id, company_id, balance_agorot, due_date)
    select p_org, p_document, x, v_balance, v_doc.due_date from unnest(v_companies) x
    on conflict (organization_id, document_id, company_id)
      do update set balance_agorot = excluded.balance_agorot, due_date = excluded.due_date
       where (r.balance_agorot, r.due_date) is distinct from (excluded.balance_agorot, excluded.due_date);
    if v_contact is not null then
      insert into public.debt_document_customers as r (organization_id, document_id, contact_id, balance_agorot, due_date)
      values (p_org, p_document, v_contact, v_balance, v_doc.due_date)
      on conflict (organization_id, document_id, contact_id)
        do update set balance_agorot = excluded.balance_agorot, due_date = excluded.due_date
         where (r.balance_agorot, r.due_date) is distinct from (excluded.balance_agorot, excluded.due_date);
    end if;
  end if;
  for v_id in select distinct x from unnest(v_before_companies || v_companies) x where x is not null order by x loop
    perform app.customer_debt_refresh(p_org, v_id, null);
  end loop;
  for v_id in select distinct x from unnest(v_before_contacts || array[v_contact]) x where x is not null order by x loop
    perform app.customer_debt_refresh(p_org, null, v_id);
  end loop;
end;
$$;
revoke all on function app.debt_document_sync(uuid, uuid) from public, anon, authenticated, service_role;

-- a document and the documents whose balance moves with it: the proforma a tax invoice bills ('transferred' while
-- billed), and the active invoices that bill a proforma (they count the proforma's allocations)
create or replace function app.debt_document_family_sync(p_org uuid, p_document uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_document is null then
    return;
  end if;
  perform app.debt_document_sync(p_org, p_document);
  for v_id in
    select d.proforma_id from public.accounting_documents d
     where d.organization_id = p_org and d.id = p_document and d.proforma_id is not null
    union
    select i.id from public.accounting_documents i
     where i.organization_id = p_org and i.proforma_id = p_document
    order by 1
  loop
    perform app.debt_document_sync(p_org, v_id);
  end loop;
end;
$$;
revoke all on function app.debt_document_family_sync(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.debt_on_document() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- not a debt and not billing a proforma, before and after: no balance moves, so no lock
  if not (new.doc_type in ('tax_invoice', 'proforma', 'opening_balance') or new.proforma_id is not null
          or (tg_op = 'UPDATE' and (old.doc_type in ('tax_invoice', 'proforma', 'opening_balance') or old.proforma_id is not null))) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || new.organization_id::text, 0));
  perform app.debt_document_family_sync(new.organization_id, new.id);
  -- an invoice that stopped billing a proforma: that proforma again
  if tg_op = 'UPDATE' and old.proforma_id is not null and old.proforma_id is distinct from new.proforma_id then
    perform app.debt_document_sync(old.organization_id, old.proforma_id);
  end if;
  return null;
end;
$$;
revoke all on function app.debt_on_document() from public, anon, authenticated, service_role;

-- a payment allocation or an opening-credit offset: the document it counts on
create or replace function app.debt_on_allocation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.debt_document_family_sync(new.organization_id, new.document_id);
  return null;
end;
$$;
revoke all on function app.debt_on_allocation() from public, anon, authenticated, service_role;

-- a contact's or a deal's company changed (a person, a merge, the companies FK's set-null): its documents again
create or replace function app.debt_on_customer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if new.company_id is not distinct from old.company_id then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || new.organization_id::text, 0));
  for v_id in
    select d.id from public.accounting_documents d
     where d.organization_id = new.organization_id
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
       and ((tg_table_name = 'contacts' and d.contact_id = new.id) or (tg_table_name = 'deals' and d.deal_id = new.id))
     order by d.id
  loop
    perform app.debt_document_sync(new.organization_id, v_id);
  end loop;
  return null;
end;
$$;
revoke all on function app.debt_on_customer() from public, anon, authenticated, service_role;

-- Constraint triggers, deferred to commit (see the header). CREATE OR REPLACE is not available for constraint triggers:
-- each is created only when missing; one of these names that is not a deferred constraint trigger is refused.
do $$
declare
  v_plain text;
begin
  select string_agg(t.tgname, ', ') into v_plain
    from pg_trigger t
   where not t.tgisinternal
     and (t.tgrelid, t.tgname) in (('public.accounting_documents'::regclass, 'accounting_documents_customer_debt'),
                                   ('public.payment_allocations'::regclass, 'payment_allocations_customer_debt'),
                                   ('public.opening_credit_allocations'::regclass, 'opening_credit_allocations_customer_debt'),
                                   ('public.contacts'::regclass, 'contacts_customer_debt'),
                                   ('public.deals'::regclass, 'deals_customer_debt'))
     and not (t.tgconstraint <> 0 and t.tgdeferrable and t.tginitdeferred);
  if v_plain is not null then
    raise exception 'BAL-02: % exist as plain triggers; they must be deferred constraint triggers', v_plain
      using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.accounting_documents'::regclass
                  and tgname = 'accounting_documents_customer_debt' and not tgisinternal) then
    create constraint trigger accounting_documents_customer_debt
      after insert or update of doc_type, status, amount_agorot, due_date, contact_id, deal_id, company_id, proforma_id
      on public.accounting_documents
      deferrable initially deferred
      for each row execute function app.debt_on_document();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.payment_allocations'::regclass
                  and tgname = 'payment_allocations_customer_debt' and not tgisinternal) then
    create constraint trigger payment_allocations_customer_debt
      after insert or update on public.payment_allocations
      deferrable initially deferred
      for each row execute function app.debt_on_allocation();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.opening_credit_allocations'::regclass
                  and tgname = 'opening_credit_allocations_customer_debt' and not tgisinternal) then
    create constraint trigger opening_credit_allocations_customer_debt
      after insert or update on public.opening_credit_allocations
      deferrable initially deferred
      for each row execute function app.debt_on_allocation();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.contacts'::regclass
                  and tgname = 'contacts_customer_debt' and not tgisinternal) then
    create constraint trigger contacts_customer_debt
      after update of company_id on public.contacts
      deferrable initially deferred
      for each row execute function app.debt_on_customer();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.deals'::regclass
                  and tgname = 'deals_customer_debt' and not tgisinternal) then
    create constraint trigger deals_customer_debt
      after update of company_id on public.deals
      deferrable initially deferred
      for each row execute function app.debt_on_customer();
  end if;
end;
$$;

-- the documents recorded so far
select app.debt_document_sync(d.organization_id, d.id)
  from public.accounting_documents d
 where d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.status = 'active' and d.amount_agorot > 0
 order by d.organization_id, d.id;

-- ----------------------------------------------------------------------------
-- The list columns and filters
-- ----------------------------------------------------------------------------
-- the value of a list column: owners and admins only (the totals count every document of the customer); a contact with a
-- company has its company's total, one without its own. p_overdue: only the part due before the business's today.
create or replace function app.customer_debt_of(p_org uuid, p_company uuid, p_contact uuid, p_overdue boolean) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select case when not app.is_admin(p_org) then null
              -- the ledger's three keys (BAL-01), whatever the app offers
              when not (app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
                        and app.org_has_feature(p_org, 'payments')) then null
              else coalesce((
                select case when not p_overdue then t.open_agorot
                            else (select coalesce(sum(x.amount), 0)::bigint
                                    from unnest(t.due_dates, t.due_amounts) x(due_date, amount)
                                   where x.due_date < (select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date
                                                         from public.organizations o where o.id = p_org)) end
                  from public.customer_debt_totals t
                 where t.organization_id = p_org
                   and ((p_company is not null and t.company_id = p_company)
                        or (p_company is null and t.contact_id = p_contact))), 0) end
$$;
revoke all on function app.customer_debt_of(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function app.customer_debt_of(uuid, uuid, uuid, boolean) to authenticated;

create or replace function public.debt_balance(public.contacts) returns bigint
language sql stable
as $$
  select app.customer_debt_of(($1).organization_id, ($1).company_id, ($1).id, false)
$$;
revoke all on function public.debt_balance(public.contacts) from public, anon;
grant execute on function public.debt_balance(public.contacts) to authenticated;

create or replace function public.debt_balance(public.companies) returns bigint
language sql stable
as $$
  select app.customer_debt_of(($1).organization_id, ($1).id, null, false)
$$;
revoke all on function public.debt_balance(public.companies) from public, anon;
grant execute on function public.debt_balance(public.companies) to authenticated;

create or replace function public.overdue_debt(public.contacts) returns bigint
language sql stable
as $$
  select app.customer_debt_of(($1).organization_id, ($1).company_id, ($1).id, true)
$$;
revoke all on function public.overdue_debt(public.contacts) from public, anon;
grant execute on function public.overdue_debt(public.contacts) to authenticated;

create or replace function public.overdue_debt(public.companies) returns bigint
language sql stable
as $$
  select app.customer_debt_of(($1).organization_id, ($1).id, null, true)
$$;
revoke all on function public.overdue_debt(public.companies) from public, anon;
grant execute on function public.overdue_debt(public.companies) to authenticated;

create or replace function public.has_debt(public.contacts) returns boolean
language sql stable
as $$
  select coalesce(public.debt_balance($1) > 0, false)
$$;
revoke all on function public.has_debt(public.contacts) from public, anon;
grant execute on function public.has_debt(public.contacts) to authenticated;

create or replace function public.has_debt(public.companies) returns boolean
language sql stable
as $$
  select coalesce(public.debt_balance($1) > 0, false)
$$;
revoke all on function public.has_debt(public.companies) from public, anon;
grant execute on function public.has_debt(public.companies) to authenticated;

create or replace function public.has_overdue_debt(public.contacts) returns boolean
language sql stable
as $$
  select coalesce(public.overdue_debt($1) > 0, false)
$$;
revoke all on function public.has_overdue_debt(public.contacts) from public, anon;
grant execute on function public.has_overdue_debt(public.contacts) to authenticated;

create or replace function public.has_overdue_debt(public.companies) returns boolean
language sql stable
as $$
  select coalesce(public.overdue_debt($1) > 0, false)
$$;
revoke all on function public.has_overdue_debt(public.companies) from public, anon;
grant execute on function public.has_overdue_debt(public.companies) to authenticated;

-- ----------------------------------------------------------------------------
-- The card: open and overdue debt, under RLS with BAL-01's partial rule
-- ----------------------------------------------------------------------------
create or replace function public.customer_debt_summary(p_org uuid, p_contact uuid, p_company uuid)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_out jsonb;
  v_partial boolean;
  v_today date;
begin
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;

  -- BAL-01's partial rule and scope (public.customer_ledger; keep in step): a row of the customer hidden from the caller
  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  )
  select coalesce(app.customer_money_rows(p_org, p_contact, p_company), 0) >
         (select count(*) from public.accounting_documents d
           where d.organization_id = p_org
             and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
                  or d.company_id in (select company_id from origin_companies)))
         + (select count(*) from public.payments p
             where p.organization_id = p_org
               and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals)))
    into v_partial;
  if v_partial then
    return jsonb_build_object('allowed', true, 'partial', true);
  end if;

  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = p_org;

  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  ),
  docs as (
    select d.id, d.due_date
      from public.accounting_documents d
     where d.organization_id = p_org
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.status = 'active' and d.amount_agorot > 0
       and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
            or d.company_id in (select company_id from origin_companies))
  ),
  open_docs as (
    select d.id, d.due_date, s.balance
      from docs d
      join (select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
              from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from docs),
                                                                      '{}'::uuid[]) -> 'documents') x) s on s.id = d.id
     where s.balance > 0
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', false,
    'today', v_today,
    'open_debt', coalesce(sum(o.balance), 0)::bigint,
    'open_documents', count(*),
    'overdue_debt', coalesce(sum(o.balance) filter (where o.due_date < v_today), 0)::bigint,
    'overdue_documents', count(*) filter (where o.due_date < v_today),
    'oldest_due_date', min(o.due_date) filter (where o.due_date < v_today))
    into v_out
    from open_docs o;
  return v_out;
end;
$$;
revoke all on function public.customer_debt_summary(uuid, uuid, uuid) from public, anon;
grant execute on function public.customer_debt_summary(uuid, uuid, uuid) to authenticated;
