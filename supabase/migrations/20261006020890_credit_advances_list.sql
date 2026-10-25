-- =============================================================================
-- PAY-03 part two: advances, and the credit column of the contacts and companies lists (owner's answers of 25 October
-- 2026, DECISIONS.md: (3) ב, (4) ב)
-- =============================================================================
-- * One rule for a payment's credit: the computed field public.payment_credit(payments) (invoker, no SET, inlined: its
--   recorded or confirmed amount less its counted allocations, never below 0). public.money_allocation_state (PAY-02),
--   public.money_customer_credit and the list columns below all read it.
-- * Advances (answer 3): payments.is_advance (the optional "מקדמה" mark) with at most one optional link,
--   advance_quote_id or advance_order_id (composite FKs, on delete set null of the column; full indexes; constraint
--   payments_advance_shape: a link only on an advance, never both). Invoker trigger payments_advance (a person's write only,
--   current_user = 'authenticated'; the server's set-null, merge and erasure pass): the quote or order must be one the person
--   reads, not a draft and not cancelled, of the same customer (PAY-02's rule: the same deal, the same contact, or a shared
--   company of the payment's contact or deal and the target's contact, deal or, for an order, its own company), hint
--   payment:advance_link; after the insert only owners and admins change the mark or the link (payment:correction) and
--   nothing changes on a cancelled payment (payment:cancelled). An advance is still credit. The links are ids: an erasure
--   has nothing to empty, and a merge moves the payment's contact as before.
-- * public.money_apply_credit offers first the advances linked to the document's order (accounting_documents.order_id,
--   ORD-06) or to the quote that order was made from, then the rest oldest first (within money_allocation_candidates' 100).
-- * The list column and filter (answer 4). Who: owners and admins (app.is_admin), with the `payments` and `documents` keys
--   (the app offers the column, its sort and the filter to nobody else; the database answers null to anyone else). They read every payment, so a total kept
--   by the server is exactly what the cards show them. Why kept: a per-row sum over a company's contacts and deals costs the
--   company's size for each of its contacts, and RLS on every payment it reads (measured on 20,000 contacts with a
--   2,000-contact company: a sort ran 127 s). Kept by triggers:
--     - public.payment_credit_companies: one row per payment and company it belongs to (its contact's company, its deal's
--       company; each once) with its credit (public.payment_credit, as the owner); a link that ends keeps its row at 0 (no
--       row is removed; the org, the payment and the company cascade). Members read a row while they read its payment;
--       public.money_customer_credit (the cards) reads its company part from here, under RLS.
--     - public.customer_credit_totals: one row per company (the sum of its rows above) and per contact (its own payments'
--       credit); owners and admins read it.
--   Both are refreshed by definer app.payment_credit_companies_sync(org, payment), called by triggers on payments (also a
--   payment leaving a contact), payment_allocations, and a contact's or a deal's company change.
--   Computed fields public.credit_balance(contacts|companies) (bigint) and public.has_credit(contacts|companies) (boolean),
--   invoker, no SET, inlined, over definer app.customer_credit_of (one indexed lookup; the caller's role checked per row,
--   which is most of its cost): a contact with a company has its company's total (PAY-02's customer), one without its own.
--   Measured on the same 20,000 contacts: sorted by credit 5.4 s (by owner 1.6 s, by completeness 3.5 s).
--   The four sync triggers are constraint triggers, DEFERRABLE INITIALLY DEFERRED: the shared rows (a company's total is
--   touched by every payment and allocation of its contacts and deals) are refreshed once at commit, after every business
--   lock of the transaction (payment, document, proforma; PAY-02's order), never between them. Two allocations of one
--   company in different transactions therefore no longer deadlock (T1: P1, D1, total, waits P2 / T2: P2, D2, waits total).
--   Each refresh recomputes from the committed-to-be state, so several rows of one customer changed in one transaction give
--   the right total (a repeated refresh is a no-op). Inside the writing transaction the rows still show the state before it.
--   Every refresh first takes a transaction-level advisory lock per business ('customer_credit:<org>'), so the commits of
--   one business refresh one after the other and never take two shared rows in opposite orders (a customer spanning two
--   companies; a contact's company change committing beside an allocation). Within one refresh the companies are touched
--   in id order, then the contact. The lock is taken only at commit, after the business locks, and the business phase
--   never touches these rows, so it adds no wait cycle.
--   A database that ran an earlier draft of this file with plain (immediate) triggers of these names is refused with a
--   clear error instead of keeping them silently.
--   Both tables carry `currency` (ILS only, TAX-06). When DEAL-12 opens other currencies the credit must be kept per
--   currency: `currency` joins payment_credit_companies_once and both unique keys of customer_credit_totals (one total per
--   customer and currency), and the refresh functions sum per currency.
-- Every statement is safe to run twice. No drops of data, no row removal.

-- ----------------------------------------------------------------------------
-- One rule for a payment's credit
-- ----------------------------------------------------------------------------
create or replace function public.payment_credit(public.payments) returns bigint
language sql stable
as $$
  select case when ($1).status in ('recorded', 'confirmed')
              then greatest(($1).amount_agorot - coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                                                         where a.organization_id = ($1).organization_id and a.payment_id = ($1).id
                                                           and a.released_at is null and a.removed_at is null), 0), 0)
              else 0 end::bigint
$$;
revoke all on function public.payment_credit(public.payments) from public, anon;
grant execute on function public.payment_credit(public.payments) to authenticated;

-- PAY-02's state, its payments' credit now from public.payment_credit (the same amounts)
create or replace function public.money_allocation_state(p_org uuid, p_documents uuid[], p_payments uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with counted as (
    select a.document_id, a.payment_id, a.amount_agorot from public.payment_allocations a
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
       and (a.document_id = any (coalesce(p_documents, '{}'))
            or a.payment_id = any (coalesce(p_payments, '{}'))
            or a.document_id in (select d.proforma_id from public.accounting_documents d
                                  where d.organization_id = p_org and d.id = any (coalesce(p_documents, '{}'))
                                    and d.proforma_id is not null))
  ),
  docs as (
    select d.id, d.doc_type, d.status, d.amount_agorot,
           coalesce((select sum(c.amount_agorot) from counted c where c.document_id = d.id), 0)
             + coalesce((select sum(c.amount_agorot) from counted c
                          join public.accounting_documents p on p.organization_id = p_org and p.id = c.document_id
                         where d.doc_type = 'tax_invoice' and c.document_id = d.proforma_id and p.status = 'active'), 0) as paid,
           (select i.number from public.accounting_documents i
             where d.doc_type = 'proforma' and i.organization_id = p_org and i.proforma_id = d.id and i.status = 'active') as invoice_number
      from public.accounting_documents d
     where d.organization_id = p_org and d.id = any (coalesce(p_documents, '{}'))
  )
  select jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id,
               'paid', x.paid,
               'balance', case when x.state in ('unpaid', 'partial') then greatest(x.amount_agorot - x.paid, 0) else 0 end,
               'state', x.state,
               'invoice_number', x.invoice_number) order by x.id)
        from (select docs.*,
                     case when docs.status <> 'active' then 'none'
                          when docs.doc_type = 'tax_invoice_receipt' then 'paid_on_issue'
                          when docs.doc_type not in ('tax_invoice', 'proforma') then 'none'
                          when docs.invoice_number is not null then 'transferred'
                          when docs.paid >= docs.amount_agorot then 'paid'
                          when docs.paid > 0 then 'partial'
                          else 'unpaid' end as state
                from docs) x), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'allocated', coalesce((select sum(c.amount_agorot) from counted c where c.payment_id = p.id), 0),
               -- PAY-03: one rule for a payment's credit
               'credit', public.payment_credit(p)) order by p.id)
        from public.payments p
       where p.organization_id = p_org and p.id = any (coalesce(p_payments, '{}'))), '[]'::jsonb)
  )
$$;
revoke all on function public.money_allocation_state(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.money_allocation_state(uuid, uuid[], uuid[]) to authenticated;


-- ----------------------------------------------------------------------------
-- Advances
-- ----------------------------------------------------------------------------
alter table public.payments add column if not exists is_advance boolean not null default false;
alter table public.payments add column if not exists advance_quote_id uuid;
alter table public.payments add column if not exists advance_order_id uuid;
alter table public.payments drop constraint if exists payments_advance_quote_fk;
alter table public.payments add constraint payments_advance_quote_fk foreign key (organization_id, advance_quote_id)
  references public.quotes (organization_id, id) on delete set null (advance_quote_id);
alter table public.payments drop constraint if exists payments_advance_order_fk;
alter table public.payments add constraint payments_advance_order_fk foreign key (organization_id, advance_order_id)
  references public.orders (organization_id, id) on delete set null (advance_order_id);
alter table public.payments drop constraint if exists payments_advance_shape;
alter table public.payments add constraint payments_advance_shape check (
  (is_advance or (advance_quote_id is null and advance_order_id is null))
  and (advance_quote_id is null or advance_order_id is null)
);
create index if not exists payments_advance_quote_idx on public.payments (organization_id, advance_quote_id);
create index if not exists payments_advance_order_idx on public.payments (organization_id, advance_order_id);
grant insert (is_advance, advance_quote_id, advance_order_id), update (is_advance, advance_quote_id, advance_order_id)
  on public.payments to authenticated;

-- a person's mark and link (invoker: the quote or order is read with the person's rights)
create or replace function app.payments_advance() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_deal uuid;
  v_contact uuid;
  v_company uuid;
  v_status text;
  v_found boolean := false;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if row(new.is_advance, new.advance_quote_id, new.advance_order_id)
       is not distinct from row(old.is_advance, old.advance_quote_id, old.advance_order_id) then
      return new;
    end if;
    if old.status = 'cancelled' then
      raise exception 'a cancelled payment does not change' using errcode = 'P0001', hint = 'payment:cancelled';
    end if;
    if not app.is_admin(new.organization_id) then
      raise exception 'only owners and admins correct a payment' using errcode = 'P0001', hint = 'payment:correction';
    end if;
    if new.advance_quote_id is not distinct from old.advance_quote_id
       and new.advance_order_id is not distinct from old.advance_order_id then
      return new;
    end if;
  end if;
  if new.advance_quote_id is not null then
    select q.deal_id, q.contact_id, null::uuid, q.status, true into v_deal, v_contact, v_company, v_status, v_found
      from public.quotes q where q.organization_id = new.organization_id and q.id = new.advance_quote_id;
  elsif new.advance_order_id is not null then
    select o.deal_id, o.contact_id, o.company_id, o.status, true into v_deal, v_contact, v_company, v_status, v_found
      from public.orders o where o.organization_id = new.organization_id and o.id = new.advance_order_id;
  else
    return new;
  end if;
  if not coalesce(v_found, false) or v_status in ('draft', 'cancelled')
     or not ((v_deal is not null and v_deal = new.deal_id)
             or (v_contact is not null and v_contact = new.contact_id)
             or exists (
                  select 1
                    from (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id
                          union all
                          select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id) a
                    join (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = v_contact
                          union all
                          select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = v_deal
                          union all
                          select v_company) b on a.company_id = b.company_id)) then
    raise exception 'an advance links a sent quote or a numbered order of the same customer' using errcode = 'P0001', hint = 'payment:advance_link';
  end if;
  return new;
end;
$$;
revoke all on function app.payments_advance() from public, anon, authenticated, service_role;

create or replace trigger payments_advance before insert or update on public.payments
  for each row execute function app.payments_advance();

-- ----------------------------------------------------------------------------
-- A company's credit, kept by the server for the lists
-- ----------------------------------------------------------------------------
create table if not exists public.payment_credit_companies (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  payment_id      uuid not null,
  company_id      uuid not null,
  credit_agorot   bigint not null default 0 check (credit_agorot >= 0),
  currency        text not null default 'ILS' check (currency = 'ILS'),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  -- one row per payment and company; also the index of the payment's foreign key
  constraint payment_credit_companies_once unique (organization_id, payment_id, company_id),
  constraint payment_credit_companies_payment_fk foreign key (organization_id, payment_id)
    references public.payments (organization_id, id) on delete cascade,
  constraint payment_credit_companies_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade
);
create index if not exists payment_credit_companies_payment_idx on public.payment_credit_companies (organization_id, payment_id);
create index if not exists payment_credit_companies_company_idx on public.payment_credit_companies (organization_id, company_id);

alter table public.payment_credit_companies enable row level security;
revoke all on public.payment_credit_companies from anon, authenticated;
grant select on public.payment_credit_companies to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_credit_companies'
                  and policyname = 'payment_credit_companies_select') then
    -- whoever reads the payment (its deal's or contact's rules, through the payments policy) reads its rows
    create policy payment_credit_companies_select on public.payment_credit_companies for select to authenticated
      using (app.is_member(organization_id)
             and exists (select 1 from public.payments p
                          where p.organization_id = payment_credit_companies.organization_id
                            and p.id = payment_credit_companies.payment_id));
  end if;
end;
$$;

create or replace trigger payment_credit_companies_touch before update on public.payment_credit_companies
  for each row execute function app.touch_row();

-- the totals the list column reads: one row per company and per contact (owners and admins read them)
create table if not exists public.customer_credit_totals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id      uuid,
  contact_id      uuid,
  credit_agorot   bigint not null default 0 check (credit_agorot >= 0),
  currency        text not null default 'ILS' check (currency = 'ILS'),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint customer_credit_totals_one check ((company_id is null) <> (contact_id is null)),
  constraint customer_credit_totals_company unique (organization_id, company_id),
  constraint customer_credit_totals_contact unique (organization_id, contact_id),
  constraint customer_credit_totals_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade,
  constraint customer_credit_totals_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade
);

alter table public.customer_credit_totals enable row level security;
revoke all on public.customer_credit_totals from anon, authenticated;
grant select on public.customer_credit_totals to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_credit_totals'
                  and policyname = 'customer_credit_totals_select') then
    -- the totals count every payment of the customer: owners and admins, who read them all
    create policy customer_credit_totals_select on public.customer_credit_totals for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

create or replace trigger customer_credit_totals_touch before update on public.customer_credit_totals
  for each row execute function app.touch_row();

-- a company's total: its rows in payment_credit_companies (each payment once)
create or replace function app.customer_credit_company_refresh(p_org uuid, p_company uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_company is null or not exists (select 1 from public.companies c where c.organization_id = p_org and c.id = p_company) then
    return;
  end if;
  insert into public.customer_credit_totals as t (organization_id, company_id, credit_agorot)
  values (p_org, p_company, coalesce((select sum(x.credit_agorot) from public.payment_credit_companies x
                                       where x.organization_id = p_org and x.company_id = p_company), 0))
  on conflict (organization_id, company_id)
    do update set credit_agorot = excluded.credit_agorot where t.credit_agorot is distinct from excluded.credit_agorot;
end;
$$;
revoke all on function app.customer_credit_company_refresh(uuid, uuid) from public, anon, authenticated, service_role;

-- a contact's own total: its recorded and confirmed payments' credit (public.payment_credit)
create or replace function app.customer_credit_contact_refresh(p_org uuid, p_contact uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_contact is null or not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact) then
    return;
  end if;
  insert into public.customer_credit_totals as t (organization_id, contact_id, credit_agorot)
  values (p_org, p_contact, coalesce((select sum(public.payment_credit(p)) from public.payments p
                                       where p.organization_id = p_org and p.contact_id = p_contact
                                         and p.status in ('recorded', 'confirmed')), 0))
  on conflict (organization_id, contact_id)
    do update set credit_agorot = excluded.credit_agorot where t.credit_agorot is distinct from excluded.credit_agorot;
end;
$$;
revoke all on function app.customer_credit_contact_refresh(uuid, uuid) from public, anon, authenticated, service_role;

-- one payment's rows: its credit (public.payment_credit, as the owner: every allocation counts) on each company it belongs
-- to; then the totals of those companies (the ones it left too) and of its contact
create or replace function app.payment_credit_companies_sync(p_org uuid, p_payment uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_credit bigint;
  v_contact uuid;
  v_companies uuid[];
  v_before uuid[];
  v_company uuid;
begin
  -- one business's refreshes run one at a time (held to the end of the transaction): two commits never take the shared
  -- total rows in opposite orders
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || p_org::text, 0));
  select public.payment_credit(p), p.contact_id,
         array(select distinct x from unnest(array[
                 (select c.company_id from public.contacts c where c.organization_id = p.organization_id and c.id = p.contact_id),
                 (select d.company_id from public.deals d where d.organization_id = p.organization_id and d.id = p.deal_id)]) x
               where x is not null)
    into v_credit, v_contact, v_companies
    from public.payments p
   where p.organization_id = p_org and p.id = p_payment;
  if not found then
    return;
  end if;
  v_before := array(select t.company_id from public.payment_credit_companies t
                     where t.organization_id = p_org and t.payment_id = p_payment and t.credit_agorot > 0);
  update public.payment_credit_companies t set credit_agorot = 0
   where t.organization_id = p_org and t.payment_id = p_payment and t.credit_agorot <> 0
     and (v_credit = 0 or not (t.company_id = any (v_companies)));
  if v_credit > 0 and cardinality(v_companies) > 0 then
    insert into public.payment_credit_companies as t (organization_id, payment_id, company_id, credit_agorot)
    select p_org, p_payment, x, v_credit from unnest(v_companies) x
    on conflict (organization_id, payment_id, company_id)
      do update set credit_agorot = excluded.credit_agorot where t.credit_agorot is distinct from excluded.credit_agorot;
  end if;
  for v_company in select distinct x from unnest(v_before || v_companies) x order by x loop
    perform app.customer_credit_company_refresh(p_org, v_company);
  end loop;
  perform app.customer_credit_contact_refresh(p_org, v_contact);
end;
$$;
revoke all on function app.payment_credit_companies_sync(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.payment_credit_companies_on_payment() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || new.organization_id::text, 0));
  perform app.payment_credit_companies_sync(new.organization_id, new.id);
  -- a payment that left a contact (a merge, the contact's purge): that contact's own total again
  if tg_op = 'UPDATE' and old.contact_id is distinct from new.contact_id then
    perform app.customer_credit_contact_refresh(old.organization_id, old.contact_id);
  end if;
  return null;
end;
$$;
revoke all on function app.payment_credit_companies_on_payment() from public, anon, authenticated, service_role;

create or replace function app.payment_credit_companies_on_allocation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.payment_credit_companies_sync(new.organization_id, new.payment_id);
  return null;
end;
$$;
revoke all on function app.payment_credit_companies_on_allocation() from public, anon, authenticated, service_role;

-- a contact's or a deal's company changed (a person, a merge, the companies FK's set-null): its payments again
create or replace function app.payment_credit_companies_on_customer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payment uuid;
begin
  if new.company_id is not distinct from old.company_id then
    return null;
  end if;
  for v_payment in
    select p.id from public.payments p
     where p.organization_id = new.organization_id
       and ((tg_table_name = 'contacts' and p.contact_id = new.id) or (tg_table_name = 'deals' and p.deal_id = new.id))
  loop
    perform app.payment_credit_companies_sync(new.organization_id, v_payment);
  end loop;
  return null;
end;
$$;
revoke all on function app.payment_credit_companies_on_customer() from public, anon, authenticated, service_role;

-- Constraint triggers, deferred to commit (see the header). CREATE OR REPLACE is not available for constraint triggers:
-- each is created only when missing.
do $$
declare
  v_plain text;
begin
  -- a trigger of one of these names that is not a deferrable, initially deferred constraint trigger: an earlier draft
  select string_agg(t.tgname, ', ') into v_plain
    from pg_trigger t
   where not t.tgisinternal
     and (t.tgrelid, t.tgname) in (('public.payments'::regclass, 'payments_credit_companies'),
                                   ('public.payment_allocations'::regclass, 'payment_allocations_credit_companies'),
                                   ('public.contacts'::regclass, 'contacts_credit_companies'),
                                   ('public.deals'::regclass, 'deals_credit_companies'))
     and not (t.tgconstraint <> 0 and t.tgdeferrable and t.tginitdeferred);
  if v_plain is not null then
    raise exception 'PAY-03: % exist as plain triggers from an earlier draft; they must be deferred constraint triggers (replace them by hand, then run this migration again)', v_plain
      using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.payments'::regclass
                  and tgname = 'payments_credit_companies' and not tgisinternal) then
    create constraint trigger payments_credit_companies
      after insert or update on public.payments
      deferrable initially deferred
      for each row execute function app.payment_credit_companies_on_payment();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.payment_allocations'::regclass
                  and tgname = 'payment_allocations_credit_companies' and not tgisinternal) then
    create constraint trigger payment_allocations_credit_companies
      after insert or update on public.payment_allocations
      deferrable initially deferred
      for each row execute function app.payment_credit_companies_on_allocation();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.contacts'::regclass
                  and tgname = 'contacts_credit_companies' and not tgisinternal) then
    create constraint trigger contacts_credit_companies
      after update of company_id on public.contacts
      deferrable initially deferred
      for each row execute function app.payment_credit_companies_on_customer();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.deals'::regclass
                  and tgname = 'deals_credit_companies' and not tgisinternal) then
    create constraint trigger deals_credit_companies
      after update of company_id on public.deals
      deferrable initially deferred
      for each row execute function app.payment_credit_companies_on_customer();
  end if;
end;
$$;

-- the payments recorded so far
select app.payment_credit_companies_sync(p.organization_id, p.id)
  from public.payments p where p.status in ('recorded', 'confirmed');

-- ----------------------------------------------------------------------------
-- The customer's credit (the cards), now over public.payment_credit
-- ----------------------------------------------------------------------------
create or replace function public.money_customer_credit(p_org uuid, p_deal uuid, p_contact uuid, p_company uuid)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
    union
    select d.company_id from public.deals d
     where d.organization_id = p_org and d.id = p_deal and d.company_id is not null
  ),
  credits as (
    select p.id, p.paid_on, p.method, p.amount_agorot as amount, public.payment_credit(p) as credit, p.is_advance,
           p.advance_quote_id, p.advance_order_id
      from public.payments p
     where p.organization_id = p_org and p.status in ('recorded', 'confirmed')
       and (p.deal_id = p_deal or p.contact_id = p_contact
            -- the company part from the server's list (the list column reads the same rows)
            or p.id in (select t.payment_id from public.payment_credit_companies t
                         where t.organization_id = p_org and t.credit_agorot > 0
                           and t.company_id in (select company_id from origin_companies)))
  )
  select jsonb_build_object(
    'total', coalesce((select sum(c.credit) from credits c where c.credit > 0), 0)::bigint,
    'count', (select count(*) from credits c where c.credit > 0),
    'payments', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.paid_on, t.id)
        from (select c.id, c.paid_on, c.method, c.amount, c.credit, c.is_advance, c.advance_quote_id, c.advance_order_id
                from credits c where c.credit > 0 order by c.paid_on, c.id limit 200) t), '[]'::jsonb)
  )
$$;
revoke all on function public.money_customer_credit(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.money_customer_credit(uuid, uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Applying credit: the advances of the document's order first
-- ----------------------------------------------------------------------------
create or replace function public.money_apply_credit(p_org uuid, p_document uuid, p_max bigint default null)
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_balance bigint;
  v_left bigint;
  v_take bigint;
  v_pay jsonb;
  v_hint text;
  v_order uuid;
  v_order_quote uuid;
  v_total bigint := 0;
  v_done jsonb := '[]'::jsonb;
begin
  if p_max is not null and p_max <= 0 then
    raise exception 'the cap is a positive amount' using errcode = '22023', hint = 'credit:max';
  end if;
  select (x ->> 'balance')::bigint into v_balance
    from jsonb_array_elements(public.money_allocation_state(p_org, array[p_document], '{}') -> 'documents') x;
  v_left := least(coalesce(v_balance, 0), coalesce(p_max, coalesce(v_balance, 0)));
  if v_left <= 0 then
    return jsonb_build_object('allocated', 0, 'payments', '[]'::jsonb);
  end if;
  -- the document's order, and the quote it was made from (read with the caller's rights)
  select d.order_id into v_order from public.accounting_documents d where d.organization_id = p_org and d.id = p_document;
  if v_order is not null then
    select o.quote_id into v_order_quote from public.orders o where o.organization_id = p_org and o.id = v_order;
  end if;

  for v_pay in
    select c.x
      from jsonb_array_elements(public.money_allocation_candidates(p_org, null, p_document) -> 'payments') with ordinality as c(x, i)
      left join public.payments p on p.organization_id = p_org and p.id = (c.x ->> 'id')::uuid
     order by (p.is_advance and ((v_order is not null and p.advance_order_id = v_order)
                                 or (v_order_quote is not null and p.advance_quote_id = v_order_quote))) is true desc,
              c.i
  loop
    exit when v_left <= 0;
    v_take := least((v_pay ->> 'credit')::bigint, v_left);
    continue when v_take <= 0;
    begin
      insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
      values (p_org, (v_pay ->> 'id')::uuid, p_document, v_take);
      v_total := v_total + v_take;
      v_left := v_left - v_take;
      v_done := v_done || jsonb_build_array(jsonb_build_object('payment_id', v_pay ->> 'id', 'amount', v_take));
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint in ('allocation:payment_over', 'allocation:payment_state') then
        -- the payment was used or left "recorded/confirmed" meanwhile: the next one
        null;
      elsif v_hint = 'allocation:document_over' then
        -- the document was paid meanwhile: what is left of it now
        select (x ->> 'balance')::bigint into v_balance
          from jsonb_array_elements(public.money_allocation_state(p_org, array[p_document], '{}') -> 'documents') x;
        v_left := least(coalesce(v_balance, 0), coalesce(p_max - v_total, coalesce(v_balance, 0)));
      else
        raise;
      end if;
    end;
  end loop;
  return jsonb_build_object('allocated', v_total, 'payments', v_done);
end;
$$;
revoke all on function public.money_apply_credit(uuid, uuid, bigint) from public, anon;
grant execute on function public.money_apply_credit(uuid, uuid, bigint) to authenticated;

-- ----------------------------------------------------------------------------
-- The list column and filter
-- ----------------------------------------------------------------------------
-- the list column's value: owners and admins only (the totals count every payment of the customer); a contact with a company
-- has its company's total, one without its own
create or replace function app.customer_credit_of(p_org uuid, p_company uuid, p_contact uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select case when not app.is_admin(p_org) then null
              when p_company is not null
                then coalesce((select t.credit_agorot from public.customer_credit_totals t
                                where t.organization_id = p_org and t.company_id = p_company), 0)
              else coalesce((select t.credit_agorot from public.customer_credit_totals t
                              where t.organization_id = p_org and t.contact_id = p_contact), 0) end
$$;
revoke all on function app.customer_credit_of(uuid, uuid, uuid) from public, anon;
grant execute on function app.customer_credit_of(uuid, uuid, uuid) to authenticated;

create or replace function public.credit_balance(public.contacts) returns bigint
language sql stable
as $$
  select app.customer_credit_of(($1).organization_id, ($1).company_id, ($1).id)
$$;
revoke all on function public.credit_balance(public.contacts) from public, anon;
grant execute on function public.credit_balance(public.contacts) to authenticated;

create or replace function public.credit_balance(public.companies) returns bigint
language sql stable
as $$
  select app.customer_credit_of(($1).organization_id, ($1).id, null)
$$;
revoke all on function public.credit_balance(public.companies) from public, anon;
grant execute on function public.credit_balance(public.companies) to authenticated;

create or replace function public.has_credit(public.contacts) returns boolean
language sql stable
as $$
  select coalesce(public.credit_balance($1) > 0, false)
$$;
revoke all on function public.has_credit(public.contacts) from public, anon;
grant execute on function public.has_credit(public.contacts) to authenticated;

create or replace function public.has_credit(public.companies) returns boolean
language sql stable
as $$
  select coalesce(public.credit_balance($1) > 0, false)
$$;
revoke all on function public.has_credit(public.companies) from public, anon;
grant execute on function public.has_credit(public.companies) to authenticated;
