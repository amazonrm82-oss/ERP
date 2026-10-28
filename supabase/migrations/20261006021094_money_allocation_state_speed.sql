-- =============================================================================
-- public.money_allocation_state: one grouped pass, no JIT (shared ground; follow-up of the 27 October 2026 review)
-- =============================================================================
-- Same signature, same security invoker mode (RLS decides what counts), same grants, same answer, row for row
-- (test 260 compares it with the body of 021077 on a varied fixture, as several roles). Rules kept from 021077:
-- counted = not released and not removed; a document's paid = its own counted payment allocations and opening-credit
-- offsets, plus, for a tax invoice, those of the proforma it bills while that proforma is active (and readable); a
-- proforma billed by an active invoice is 'transferred' and names its number; a payment's allocated = its counted
-- allocations; its credit = PAY-03's rule (public.payment_credit: recorded/confirmed, amount less counted allocations,
-- never below 0); a negative opening balance's credit left = app.opening_credit_left.
--
-- Measured (scripts/perf/money-allocation-state.sql + -measure.sql, local PostgreSQL 16, one business: 200 contacts,
-- 500 open invoices/proformas, 50 opening balances, 5,000 payments, 6,000 allocations of which 5,000 counted, the
-- owner's session):
--                               before (021077)        after (this file), three runs each
--   (a) every document id        7.9 - 8.5 s            0.10 - 0.16 s
--   (b) one document             7.7 - 7.9 s            0.08 - 0.10 s
--   (c) every payment id         9.6 - 10.1 s           0.15 - 0.18 s
--   (d) both                    10.2 - 10.9 s           0.18 s
--   The answer's md5 is the same before and after, as the owner and as the superuser.
-- Cause 1 (almost all of it): JIT. Under RLS every reference to accounting_documents, payments and the allocation
--   tables carries the read policies (app.can_read_record over the readable deals, contacts and companies), so the
--   planner's cost estimate passes jit_above_cost / jit_optimize_above_cost / jit_inline_above_cost even for one
--   document, and every call compiled about 1,400 expressions with LLVM: 7.9 s of the 7.9 s for one document went to
--   JIT (optimization 4.5 s, emission 3.3 s). With jit off the old body took 0.06 s (b), 0.64 s (a), 2.3 s (c),
--   3.0 s (d). The function now carries `set jit = off`; a caller's own statement decides JIT for itself.
-- Cause 2: correlated subqueries. 021077 computed `paid` with two correlated subqueries per document over the counted
--   rows, and its outer query referenced `paid` six times through an inlined CTE, so every subquery (and its RLS
--   check of the proforma) ran up to six times per document; a payment's credit called public.payment_credit, a
--   correlated read of payment_allocations under RLS for every payment. Now each table is read once, set-based: the
--   documents asked for, the active proformas they bill, the active invoices that bill the proformas asked for, and
--   the counted allocations and offsets, summed once per document and once per payment.
-- Cause 3: the join of the payments asked for with their sums. Under RLS the planner expects a handful of readable
--   payments and picked a nested loop over the 5,000 sums (12.5 million comparisons, 1.3 s for (c)). The function now
--   also carries `set enable_nestloop = off`: its joins hash, whatever the estimate; the RLS checks inside the policies
--   are subqueries, not joins, and are not affected.
--
-- Every statement is safe to run twice. No object or row is removed or changed but this function.

create or replace function public.money_allocation_state(p_org uuid, p_documents uuid[], p_payments uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
set jit = off
set enable_nestloop = off
as $$
  with docs as materialized (
    -- the documents asked for that the caller reads
    select d.id, d.doc_type, d.status, d.amount_agorot, d.proforma_id
      from public.accounting_documents d
     where d.organization_id = p_org and d.id = any (coalesce(p_documents, '{}'))
  ),
  counted as materialized (
    -- counted allocations: onto a document asked for (or the proforma it bills), or of a payment asked for
    select a.document_id, a.payment_id, a.amount_agorot from public.payment_allocations a
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
       and (a.document_id = any (coalesce(p_documents, '{}'))
            or a.payment_id = any (coalesce(p_payments, '{}'))
            or a.document_id in (select x.proforma_id from docs x where x.proforma_id is not null))
    -- GAP-12 credit: a negative opening balance's offsets count as paid on the document they went to
    union all
    select o.document_id, null::uuid, o.amount_agorot from public.opening_credit_allocations o
     where o.organization_id = p_org and o.released_at is null and o.removed_at is null
       and (o.document_id = any (coalesce(p_documents, '{}'))
            or o.document_id in (select x.proforma_id from docs x where x.proforma_id is not null))
  ),
  per_document as (
    select c.document_id, sum(c.amount_agorot) as amount from counted c group by c.document_id
  ),
  per_payment as (
    select c.payment_id, sum(c.amount_agorot) as amount from counted c where c.payment_id is not null group by c.payment_id
  ),
  billed_proformas as (
    -- the active proformas (that the caller reads) billed by a tax invoice asked for
    select p.id from public.accounting_documents p
     where p.organization_id = p_org and p.status = 'active'
       and p.id in (select x.proforma_id from docs x where x.doc_type = 'tax_invoice' and x.proforma_id is not null)
  ),
  billing_invoices as (
    -- the active document (that the caller reads) billing a proforma asked for; at most one per proforma
    -- (accounting_documents_proforma_active_once)
    select i.proforma_id, i.number from public.accounting_documents i
     where i.organization_id = p_org and i.status = 'active'
       and i.proforma_id in (select x.id from docs x where x.doc_type = 'proforma')
  ),
  paid as (
    select d.id, d.doc_type, d.status, d.amount_agorot,
           coalesce(own.amount, 0)
             + coalesce(case when d.doc_type = 'tax_invoice' and bp.id is not null then pro.amount end, 0) as paid,
           case when d.doc_type = 'proforma' then bi.number end as invoice_number
      from docs d
      left join per_document own on own.document_id = d.id
      left join billed_proformas bp on bp.id = d.proforma_id
      left join per_document pro on pro.document_id = d.proforma_id
      left join billing_invoices bi on bi.proforma_id = d.id
  )
  select jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id,
               'paid', x.paid,
               'balance', case when x.state in ('unpaid', 'partial') then greatest(x.amount_agorot - x.paid, 0) else 0 end,
               'state', x.state,
               'invoice_number', x.invoice_number,
               -- GAP-12 credit: what a negative opening balance still holds
               'credit', app.opening_credit_left(p_org, x.id)) order by x.id)
        from (select paid.*,
                     case when paid.status <> 'active' then 'none'
                          when paid.doc_type = 'tax_invoice_receipt' then 'paid_on_issue'
                          -- GAP-12: a negative opening balance is a credit, like a credit invoice; a positive one is a debt
                          when paid.doc_type = 'opening_balance' and paid.amount_agorot <= 0 then 'none'
                          when paid.doc_type not in ('tax_invoice', 'proforma', 'opening_balance') then 'none'
                          when paid.invoice_number is not null then 'transferred'
                          when paid.paid >= paid.amount_agorot then 'paid'
                          when paid.paid > 0 then 'partial'
                          else 'unpaid' end as state
                from paid) x), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'allocated', coalesce(pp.amount, 0),
               -- PAY-03: public.payment_credit's rule, from the same counted rows (every counted allocation of a payment
               -- asked for is in `counted`, read under the same RLS); test 260 compares the two
               'credit', (case when p.status in ('recorded', 'confirmed')
                               then greatest(p.amount_agorot - coalesce(pp.amount, 0), 0)
                               else 0 end)::bigint) order by p.id)
        from public.payments p
        left join per_payment pp on pp.payment_id = p.id
       where p.organization_id = p_org and p.id = any (coalesce(p_payments, '{}'))), '[]'::jsonb)
  )
$$;
revoke all on function public.money_allocation_state(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.money_allocation_state(uuid, uuid[], uuid[]) to authenticated;
