-- =============================================================================
-- ORD-02 (the rest) and ORD-04 (the rest): an order's billing status and payment status, and how much of the order, and of
-- each step of its payment schedule, is billed and paid. SPEC-ADDITIONS 6.3: "סטטוס חיוב וסטטוס תשלום מחושבים מהמסמכים
-- והתשלומים"; "המערכת עוקבת כמה מההזמנה כבר חויב וכמה שולם".
-- =============================================================================
-- Read only, computed when read, never stored. Every reader is security INVOKER: RLS decides which documents and payments
-- count, like the reports. The rows counted are those linked to the order by order_id (ORD-06 part two, 020740; a
-- numbered order only, on the order's own deal or contact, so their readers are normally the order's readers).
--
-- * billed = active tax invoices + active tax invoice-receipts - active credit invoices of the order, never below 0.
--   A proforma is a payment request, not billing: it is shown apart (`requested`). A receipt bills nothing. Cancelled
--   documents count for nothing. (An opening balance never has an order.)
-- * paid = the order's payments in status recorded or confirmed (PAY-01: the totals' rule). Failed, refunded and cancelled
--   count for nothing. Lead's conservative reading, the owner's question in the report: only payments linked to the order
--   count; a PAY-02 allocation of another payment to the order's invoice, and a tax invoice-receipt with no payment row,
--   do not.
-- * billing_state: not_billed (billed 0) | partly_billed (below the order's total) | billed (the total or more);
--   payment_state: unpaid | partly_paid | paid, against the order's total (total_agorot, with VAT). A draft has neither
--   (null). A cancelled order is still worked out (documents and payments may hang on it).
-- * partial (BAL-01's rule): when the order has a document or payment the caller does not read, nothing is worked out
--   (amounts null, states 'unknown'), so no wrong status is shown. The full count comes from app.order_money_rows
--   (definer, a count only, members only, no data).
-- * Each schedule step: its share of the total (the cumulative half-up rule of app.quote_schedule, = scheduleAmounts()),
--   and how much of it is covered by the billed and by the paid amount, filled step by step in schedule order.
-- * public.billing_state(orders) and public.payment_state(orders): computed fields for the orders list filter
--   (`billing_state=eq.partly_billed`). public.order_money_state(org, orders): the order page and the list's badges.
-- No table, no grant on a table, no change to any existing function. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The full count (definer: ids and a number only)
-- ----------------------------------------------------------------------------
create or replace function app.order_money_rows(p_org uuid, p_order uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then
    (select count(*) from public.accounting_documents d where d.organization_id = p_org and d.order_id = p_order)
    + (select count(*) from public.payments p where p.organization_id = p_org and p.order_id = p_order)
  end
$$;
revoke all on function app.order_money_rows(uuid, uuid) from public, anon, authenticated, service_role;
-- the invoker readers below run it as the caller
grant execute on function app.order_money_rows(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The sums the caller sees (invoker: RLS decides)
-- ----------------------------------------------------------------------------
create or replace function app.order_money_sums(p_org uuid, p_order uuid)
returns table (billed bigint, paid bigint, requested bigint, partial boolean)
language sql stable security invoker
set search_path = ''
as $$
  with docs as (
    select d.doc_type, d.status, d.amount_agorot from public.accounting_documents d
     where d.organization_id = p_org and d.order_id = p_order
  ),
  pays as (
    select p.status, p.amount_agorot from public.payments p
     where p.organization_id = p_org and p.order_id = p_order
  )
  select greatest(coalesce((select sum(case when x.doc_type in ('tax_invoice', 'tax_invoice_receipt') then x.amount_agorot
                                            when x.doc_type = 'credit_invoice' then -x.amount_agorot
                                            else 0 end)
                              from docs x where x.status = 'active'), 0), 0)::bigint,
         coalesce((select sum(y.amount_agorot) from pays y where y.status in ('recorded', 'confirmed')), 0)::bigint,
         coalesce((select sum(x.amount_agorot) from docs x where x.status = 'active' and x.doc_type = 'proforma'), 0)::bigint,
         coalesce(app.order_money_rows(p_org, p_order), 0) > (select count(*) from docs) + (select count(*) from pays)
$$;
revoke all on function app.order_money_sums(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.order_money_sums(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The two rules (pure)
-- ----------------------------------------------------------------------------
create or replace function app.order_billing_rule(p_total bigint, p_billed bigint) returns text
language sql immutable
set search_path = ''
as $$
  select case when coalesce(p_billed, 0) <= 0 then 'not_billed'
              when p_billed < p_total then 'partly_billed'
              else 'billed' end
$$;
revoke all on function app.order_billing_rule(bigint, bigint) from public, anon, authenticated, service_role;
grant execute on function app.order_billing_rule(bigint, bigint) to authenticated;

create or replace function app.order_payment_rule(p_total bigint, p_paid bigint) returns text
language sql immutable
set search_path = ''
as $$
  select case when coalesce(p_paid, 0) <= 0 then 'unpaid'
              when p_paid < p_total then 'partly_paid'
              else 'paid' end
$$;
revoke all on function app.order_payment_rule(bigint, bigint) from public, anon, authenticated, service_role;
grant execute on function app.order_payment_rule(bigint, bigint) to authenticated;

-- ----------------------------------------------------------------------------
-- Computed fields for the list filter (null for a draft; 'unknown' when partial)
-- ----------------------------------------------------------------------------
create or replace function public.billing_state(public.orders) returns text
language sql stable security invoker
set search_path = ''
as $$
  select case when $1.status = 'draft' then null
              when s.partial then 'unknown'
              else app.order_billing_rule($1.total_agorot, s.billed) end
    from app.order_money_sums($1.organization_id, $1.id) s
$$;
revoke all on function public.billing_state(public.orders) from public, anon;
grant execute on function public.billing_state(public.orders) to authenticated;

create or replace function public.payment_state(public.orders) returns text
language sql stable security invoker
set search_path = ''
as $$
  select case when $1.status = 'draft' then null
              when s.partial then 'unknown'
              else app.order_payment_rule($1.total_agorot, s.paid) end
    from app.order_money_sums($1.organization_id, $1.id) s
$$;
revoke all on function public.payment_state(public.orders) from public, anon;
grant execute on function public.payment_state(public.orders) to authenticated;

-- ----------------------------------------------------------------------------
-- The order page and the list's badges: per order the amounts, the two states and the schedule's coverage
-- ----------------------------------------------------------------------------
create or replace function public.order_money_state(p_org uuid, p_orders uuid[]) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_orders), 0) > 500 then
    raise exception 'too many orders in one call' using errcode = '22023', hint = 'order_money:too_many';
  end if;
  return (
    select jsonb_build_object('orders', coalesce(jsonb_agg(jsonb_build_object(
             'id', o.id,
             'status', o.status,
             'total', o.total_agorot,
             'partial', s.partial,
             'billed', case when s.partial then null else s.billed end,
             'paid', case when s.partial then null else s.paid end,
             'requested', case when s.partial then null else s.requested end,
             'billing_state', case when o.status = 'draft' then null when s.partial then 'unknown'
                                   else app.order_billing_rule(o.total_agorot, s.billed) end,
             'payment_state', case when o.status = 'draft' then null when s.partial then 'unknown'
                                   else app.order_payment_rule(o.total_agorot, s.paid) end,
             'steps', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', r.id,
                        'amount', r.upto - r.before,
                        'billed', case when s.partial then null else least(r.upto - r.before, greatest(s.billed - r.before, 0)) end,
                        'paid', case when s.partial then null else least(r.upto - r.before, greatest(s.paid - r.before, 0)) end)
                      order by r.position, r.id)
                 from (select st.id, st.position,
                              round(o.total_agorot::numeric * st.cum / 10000)::bigint as upto,
                              round(o.total_agorot::numeric * (st.cum - st.percent_bp) / 10000)::bigint as before
                         from (select ps.id, ps.position, ps.percent_bp,
                                      sum(ps.percent_bp) over (order by ps.position, ps.id) as cum
                                 from public.order_payment_steps ps
                                where ps.organization_id = p_org and ps.order_id = o.id) st) r), '[]'::jsonb))
           order by o.id), '[]'::jsonb))
      from public.orders o
      cross join lateral app.order_money_sums(o.organization_id, o.id) s
     where o.organization_id = p_org and o.id = any (coalesce(p_orders, '{}'))
  );
end;
$$;
revoke all on function public.order_money_state(uuid, uuid[]) from public, anon;
grant execute on function public.order_money_state(uuid, uuid[]) to authenticated;
