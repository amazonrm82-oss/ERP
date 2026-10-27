-- =============================================================================
-- ORD-02 (the rest) and ORD-04 (the rest): an order's billing status and payment status, and how much of the order, and of
-- each step of its payment schedule, is billed and paid. SPEC-ADDITIONS 6.3: "סטטוס חיוב וסטטוס תשלום מחושבים מהמסמכים
-- והתשלומים"; "המערכת עוקבת כמה מההזמנה כבר חויב וכמה שולם".
-- =============================================================================
-- Read only, computed when read, never stored. The public readers are security INVOKER: RLS decides which orders are read,
-- and a document or payment counts only when the caller reads it (its read rule equals its order's, else it is checked
-- under RLS: see app.order_money_facts). The rows counted are those linked to the order by order_id (ORD-06 part two, 020740; a
-- numbered order only, on the order's own deal or contact, so their readers are normally the order's readers).
--
-- * billed = active tax invoices + active tax invoice-receipts - active credit invoices of the order, never below 0.
--   A proforma is a payment request, not billing: it is shown apart (`requested`). A receipt bills nothing. Cancelled
--   documents count for nothing. (An opening balance never has an order.)
-- * paid = the order's payments in status recorded or confirmed (PAY-01: the totals' rule). Failed, refunded and cancelled
--   count for nothing. Lead's conservative reading, the owner's question in the report: only payments linked to the order
--   count; a PAY-02 allocation of another payment to the order's invoice, an advance marked for the order
--   (advance_order_id) and a tax invoice-receipt with no payment row do not.
-- * billing_state: not_billed (billed 0) | partly_billed (below the order's total) | billed (the total or more);
--   payment_state: unpaid | partly_paid | paid, against the order's total (total_agorot, with VAT). An order whose total is
--   0 or less is billed and paid. A draft has neither (null). A cancelled order is still worked out.
-- * partial (BAL-01's rule), per half: when the order has a document the caller does not read, billed/requested are null and
--   billing_state is 'unknown'; a payment the caller does not read does the same to paid/payment_state. Which rows to check
--   comes from app.order_money_facts (see there): only rows whose read parent is not the order's are read again under RLS.
-- * Each schedule step: its share of the total (the cumulative half-up rule of app.quote_schedule, = scheduleAmounts()),
--   and how much of it is covered by the billed and by the paid amount, filled step by step in schedule order.
-- * Set based (review of 27 October 2026): the orders are read under RLS once; their documents and payments are summed in
--   one grouped definer pass (app.order_money_facts), and only rows whose read parent is not the order's are read again
--   under RLS. Measured on the local test database (PostgreSQL 16) as a member, 2,500 numbered orders on 2,500 contacts,
--   each with an invoice and a payment: a filtered page (51 rows) 0.46-0.60 s, the same page with both filters 0.54-0.61 s,
--   order_money_state for 50 orders 0.36-0.44 s; the plain orders page without a money filter 0.41-0.46 s. Nearly all of
--   it is the orders' own read rule (one pass over the business's contacts, ~0.17 ms each), which the plain list pays too.
--   The first version (per-order functions, documents and payments read under RLS) took 4.5-5 s here.
-- * public.orders_by_money_state(org, billing, payment): the orders list's filter (PostgREST filters, orders and pages the
--   set it returns); public.order_money_state(org, orders): the order page and the list's badges (at most 100 ids).
-- No table, no grant on a table, no change to any existing function. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The facts of the orders asked, in one grouped pass (definer: amounts and ids, no text)
-- ----------------------------------------------------------------------------
-- Whether a document or payment (deal, contact, company) is read by the same rule as its order (deal, contact, company).
-- The select policies of orders, accounting_documents and payments all read: the deal, else the contact, else (orders and
-- documents) the company, else the role (owners, admins, managers); test 252 pins their text, so a change there makes this
-- function be looked at again. Same rule = the order's deal; else its contact on a row with no deal; else, for an order
-- with no parent at all, a row with none. An order read through its company never matches: its rows are always checked.
create or replace function app.order_money_same_parent(p_deal uuid, p_contact uuid, p_company uuid,
                                                       p_row_deal uuid, p_row_contact uuid, p_row_company uuid)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(case when p_deal is not null then p_row_deal = p_deal
                       when p_contact is not null then p_row_deal is null and p_row_contact = p_contact
                       when p_company is null then p_row_deal is null and p_row_contact is null and p_row_company is null
                       else false end, false)
$$;
revoke all on function app.order_money_same_parent(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Reading every document and payment under RLS costs one pass over the business's contacts (and deals) per table, since
-- their read rule asks whether the caller reads the row's deal, else its contact (measured: ~0.45 s per table at 2,500
-- contacts). A document or payment of an order hangs on the order's own deal, else its own contact (020740), so it has
-- the order's read rule: a deal is read through the deal, a contact through the contact, and a row with neither through
-- the role (owners, admins, managers), for orders, documents and payments alike. This function therefore names, per order,
-- only the rows whose read parent is NOT the order's (left so by a purge: e.g. a document that hung on a purged deal alone);
-- the invoker readers check exactly those rows under RLS. A caller who reads the order reads every other row of it.
-- Members only; called only by the invoker functions below with the ids of orders the caller has just read under RLS
-- (schema app is not in the API).
create or replace function app.order_money_facts(p_org uuid, p_orders uuid[])
returns table (order_id uuid, status text, total bigint, billed bigint, paid bigint, requested bigint, has_money boolean,
               other_documents uuid[], other_payments uuid[])
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- members only, checked once (never per row)
  if not coalesce(app.is_member(p_org), false) then
    return;
  end if;
  return query
  with o as (
    select o.id, o.status, o.total_agorot, o.deal_id, o.contact_id, o.company_id from public.orders o
     where o.organization_id = p_org and o.id = any (p_orders)
  ),
  d as (
    select d.order_id,
           sum(case when d.status <> 'active' then 0
                    when d.doc_type in ('tax_invoice', 'tax_invoice_receipt') then d.amount_agorot
                    when d.doc_type = 'credit_invoice' then -d.amount_agorot
                    else 0 end)::bigint as billed,
           sum(case when d.status = 'active' and d.doc_type = 'proforma' then d.amount_agorot else 0 end)::bigint as requested,
           array_agg(d.id) filter (where not app.order_money_same_parent(o.deal_id, o.contact_id, o.company_id, d.deal_id, d.contact_id, d.company_id)) as other
      from public.accounting_documents d
      join o on o.id = d.order_id
     where d.organization_id = p_org
     group by d.order_id
  ),
  p as (
    select p.order_id,
           sum(case when p.status in ('recorded', 'confirmed') then p.amount_agorot else 0 end)::bigint as paid,
           array_agg(p.id) filter (where not app.order_money_same_parent(o.deal_id, o.contact_id, o.company_id, p.deal_id, p.contact_id, null)) as other
      from public.payments p
      join o on o.id = p.order_id
     where p.organization_id = p_org
     group by p.order_id
  )
  select o.id, o.status, o.total_agorot, greatest(coalesce(d.billed, 0), 0), coalesce(p.paid, 0), coalesce(d.requested, 0),
         d.order_id is not null or p.order_id is not null, d.other, p.other
    from o
    left join d on d.order_id = o.id
    left join p on p.order_id = o.id;
end;
$$;
revoke all on function app.order_money_facts(uuid, uuid[]) from public, anon, authenticated, service_role;
-- the invoker readers below run it as the caller
grant execute on function app.order_money_facts(uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- The two rules (pure)
-- ----------------------------------------------------------------------------
create or replace function app.order_billing_rule(p_total bigint, p_billed bigint) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_total <= 0 then 'billed'
              when coalesce(p_billed, 0) <= 0 then 'not_billed'
              when p_billed < p_total then 'partly_billed'
              else 'billed' end
$$;
revoke all on function app.order_billing_rule(bigint, bigint) from public, anon, authenticated, service_role;
grant execute on function app.order_billing_rule(bigint, bigint) to authenticated;

create or replace function app.order_payment_rule(p_total bigint, p_paid bigint) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_total <= 0 then 'paid'
              when coalesce(p_paid, 0) <= 0 then 'unpaid'
              when p_paid < p_total then 'partly_paid'
              else 'paid' end
$$;
revoke all on function app.order_payment_rule(bigint, bigint) from public, anon, authenticated, service_role;
grant execute on function app.order_payment_rule(bigint, bigint) to authenticated;

-- ----------------------------------------------------------------------------
-- The money of orders the caller has read (invoker): the rows named by app.order_money_facts are checked under RLS here,
-- so a half with a row the caller does not read is partial. p_orders must be ids the caller read from public.orders.
-- ----------------------------------------------------------------------------
create or replace function app.order_money_rows(p_org uuid, p_orders uuid[])
returns table (id uuid, status text, total bigint, billing_partial boolean, payment_partial boolean, has_money boolean,
               billed bigint, paid bigint, requested bigint, billing_state text, payment_state text)
language plpgsql stable security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
begin
  for r in select f.* from app.order_money_facts(p_org, p_orders) f loop
    -- only an order with rows of another read parent (rare: after a purge) is checked under RLS, row by row of those
    billing_partial := false;
    payment_partial := false;
    if r.other_documents is not null then
      select count(*) < cardinality(r.other_documents) into billing_partial
        from public.accounting_documents x where x.organization_id = p_org and x.id = any (r.other_documents);
    end if;
    if r.other_payments is not null then
      select count(*) < cardinality(r.other_payments) into payment_partial
        from public.payments x where x.organization_id = p_org and x.id = any (r.other_payments);
    end if;
    id := r.order_id;
    status := r.status;
    total := r.total;
    has_money := r.has_money;
    billed := case when billing_partial then null else r.billed end;
    paid := case when payment_partial then null else r.paid end;
    requested := case when billing_partial then null else r.requested end;
    billing_state := case when r.status = 'draft' then null when billing_partial then 'unknown'
                          else app.order_billing_rule(r.total, r.billed) end;
    payment_state := case when r.status = 'draft' then null when payment_partial then 'unknown'
                          else app.order_payment_rule(r.total, r.paid) end;
    return next;
  end loop;
end;
$$;
revoke all on function app.order_money_rows(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function app.order_money_rows(uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- The orders list's filter: the numbered orders the caller reads whose states match (null = any). PostgREST then filters,
-- orders and pages this set (`rpc/orders_by_money_state?status=eq.new&order=created_at.desc&limit=51`).
-- An order seen only partly is 'unknown' and matches no state. The orders are read under RLS once.
-- ----------------------------------------------------------------------------
create or replace function public.orders_by_money_state(p_org uuid, p_billing text, p_payment text)
returns setof public.orders
language sql stable security invoker
set search_path = ''
as $$
  with o as materialized (
    select o.* from public.orders o where o.organization_id = p_org and o.status <> 'draft'
  )
  select o.* from o
    join app.order_money_rows(p_org, array(select o2.id from o o2)) m on m.id = o.id
   where (p_billing is null or m.billing_state = p_billing)
     and (p_payment is null or m.payment_state = p_payment)
$$;
revoke all on function public.orders_by_money_state(uuid, text, text) from public, anon;
grant execute on function public.orders_by_money_state(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The order page and the list's badges: per order the amounts, the two states and the schedule's coverage
-- ----------------------------------------------------------------------------
create or replace function public.order_money_state(p_org uuid, p_orders uuid[]) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_orders), 0) > 100 then
    raise exception 'too many orders in one call' using errcode = '22023', hint = 'order_money:too_many';
  end if;
  return (
    select jsonb_build_object('orders', coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'status', m.status,
             'total', m.total,
             'partial', m.billing_partial or m.payment_partial,
             'billing_partial', m.billing_partial,
             'payment_partial', m.payment_partial,
             'has_money', m.has_money,
             'billed', m.billed,
             'paid', m.paid,
             'requested', m.requested,
             'billing_state', m.billing_state,
             'payment_state', m.payment_state,
             'steps', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', r.id,
                        'amount', r.upto - r.before,
                        'billed', case when m.billed is null then null else least(r.upto - r.before, greatest(m.billed - r.before, 0)) end,
                        'paid', case when m.paid is null then null else least(r.upto - r.before, greatest(m.paid - r.before, 0)) end)
                      order by r.position, r.id)
                 from (select st.id, st.position,
                              round(m.total::numeric * st.cum / 10000)::bigint as upto,
                              round(m.total::numeric * (st.cum - st.percent_bp) / 10000)::bigint as before
                         from (select ps.id, ps.position, ps.percent_bp,
                                      sum(ps.percent_bp) over (order by ps.position, ps.id) as cum
                                 from public.order_payment_steps ps
                                where ps.organization_id = p_org and ps.order_id = m.id) st) r), '[]'::jsonb))
           order by m.id), '[]'::jsonb))
      -- only the orders the caller reads (RLS), then their money
      from app.order_money_rows(p_org, array(select o.id from public.orders o
                                               where o.organization_id = p_org and o.id = any (coalesce(p_orders, '{}')))) m
  );
end;
$$;
revoke all on function public.order_money_state(uuid, uuid[]) from public, anon;
grant execute on function public.order_money_state(uuid, uuid[]) to authenticated;
