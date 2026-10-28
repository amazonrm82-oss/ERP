-- =============================================================================
-- DOC-03: the documents list filtered by payment state and by customer, its summary line (spec 6.5: "סינון לפי סוג, סטטוס
-- (פתוח, שולם חלקית, שולם, באיחור, בוטל), לקוח ותאריך; שורת סיכום; ייצוא")
-- =============================================================================
-- * app.document_pay_state(status, state, due_date, today): the one rule for a document's payment state on the list, from
--   public.money_allocation_state's `state` (PAY-02, read under the caller's RLS) and the document's due date. Mirrored by
--   documentPayState() in src/features/documents/pay-state.ts (test 270 compares them):
--     cancelled   the document is cancelled
--     paid        state paid, or paid_on_issue (a tax invoice-receipt)
--     overdue     unpaid or partial, and a due date before the business's today (BAL-02's overdue)
--     partial     partial, not overdue
--     open        unpaid, not overdue
--     transferred a proforma billed by an active tax invoice (its balance moved to the invoice)
--     none        an active document with no balance of its own (a receipt, a credit invoice, an opening credit)
--   The spec's five (open, partly paid, paid, overdue, cancelled) are the list's filter choices; transferred and none are only
--   shown.
-- * app.document_pay_rows(org, ids, money) (invoker, internal): each given document the caller reads with its pay state and
--   open balance, in ONE pass: money_allocation_state is asked only about the documents that can carry a balance (active tax
--   invoices and proformas, positive opening balances), and only when `money`; a tax invoice-receipt is paid on issue and
--   every other active type has no balance, without asking.
-- * public.documents_by_pay_state(org, states, contact, company) (invoker, setof accounting_documents): the documents the
--   caller reads (RLS) of one customer when asked, whose pay state is one of `states` (null = any). PostgREST filters, orders
--   and pages the set like the table, as ORD-02's orders_by_money_state does. No money call when no state is asked, or when
--   only `cancelled` is.
--   Customer scope (the lead's call): a contact = documents on that contact, or on a deal whose contact it is; a company =
--   documents on the company (an opening balance), on one of its contacts, or on one of its deals (PAY-02's "same customer").
-- * public.documents_pay_summary(org, states, contact, company, type, status, from, to, ids) (invoker, jsonb): the summary line
--   in one call, over the documents IN FORCE the same filters find (`ids`, when not null, narrows to the rows the list's
--   advanced filter found): their count, and per type (an opening balance split into debt and credit) count and amount; with
--   the `payments` key also the open balance and the part of it past its due date. COL-01's partial rule: a caller who is not
--   an owner or admin and who does not read every document and payment of the business (app.business_money_rows, a count
--   only; null for one who may not record payments) gets `partial: true` and no balance totals (open/overdue null).
-- * public.documents_pay_rows(org, ids) (invoker, jsonb, at most 2,000 ids, hint documents_pay:too_many): the page's and the
--   export's rows with their pay state and balance.
-- * Gating is the app's (as LST-09): the payment states are offered only with the `payments` key; reading documents follows
--   the table's RLS whatever the plan.
-- Every statement is safe to run twice. No object or row is removed.

create or replace function app.document_pay_state(p_status text, p_state text, p_due date, p_today date) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_status = 'cancelled' then 'cancelled'
    when p_state in ('paid', 'paid_on_issue') then 'paid'
    when p_state in ('unpaid', 'partial') and p_due is not null and p_due < p_today then 'overdue'
    when p_state = 'partial' then 'partial'
    when p_state = 'unpaid' then 'open'
    when p_state = 'transferred' then 'transferred'
    else 'none'
  end
$$;
revoke all on function app.document_pay_state(text, text, date, date) from public, anon;
grant execute on function app.document_pay_state(text, text, date, date) to authenticated;

create or replace function app.document_pay_rows(p_org uuid, p_ids uuid[], p_money boolean)
returns table (id uuid, doc_type text, status text, amount_agorot bigint, pay_state text, balance bigint)
language sql stable security invoker
set search_path = ''
as $$
  with d as materialized (
    select d.id, d.doc_type, d.status, d.amount_agorot, d.due_date
      from public.accounting_documents d
     where d.organization_id = p_org and d.id = any (coalesce(p_ids, '{}'))
  ),
  owed as materialized (
    -- the documents that can carry a balance (PAY-02, BAL-02): only these are asked about
    select x.id from d x
     where p_money and x.status = 'active'
       and (x.doc_type in ('tax_invoice', 'proforma') or (x.doc_type = 'opening_balance' and x.amount_agorot > 0))
  ),
  s as (
    select x.id, x.state, x.balance
      from jsonb_to_recordset(
             case when exists (select 1 from owed)
                  then public.money_allocation_state(p_org, array(select o.id from owed o), '{}'::uuid[]) -> 'documents'
                  else '[]'::jsonb end) as x(id uuid, state text, balance bigint)
  ),
  today as (
    select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as day from public.organizations o where o.id = p_org
  )
  select d.id, d.doc_type, d.status, d.amount_agorot,
         app.document_pay_state(d.status,
                                case when d.status <> 'active' then 'none'
                                     when d.doc_type = 'tax_invoice_receipt' then 'paid_on_issue'
                                     else s.state end,
                                d.due_date, (select t.day from today t)),
         case when d.status = 'active' and s.state in ('unpaid', 'partial') then s.balance end
    from d left join s on s.id = d.id
$$;
revoke all on function app.document_pay_rows(uuid, uuid[], boolean) from public, anon;
grant execute on function app.document_pay_rows(uuid, uuid[], boolean) to authenticated;

create or replace function public.documents_by_pay_state(p_org uuid, p_states text[], p_contact uuid, p_company uuid)
returns setof public.accounting_documents
language sql stable security invoker
set search_path = ''
as $$
  with d as materialized (
    select d.* from public.accounting_documents d
     where d.organization_id = p_org
       and (p_contact is null
            or d.contact_id = p_contact
            or d.deal_id in (select x.id from public.deals x where x.organization_id = p_org and x.contact_id = p_contact))
       and (p_company is null
            or d.company_id = p_company
            or d.contact_id in (select c.id from public.contacts c where c.organization_id = p_org and c.company_id = p_company)
            or d.deal_id in (select x.id from public.deals x where x.organization_id = p_org and x.company_id = p_company))
       -- only cancelled asked: nothing else to judge
       and (p_states is null or not (p_states <@ array['cancelled']) or d.status = 'cancelled')
  ),
  judged as (
    select r.id, r.pay_state
      from app.document_pay_rows(p_org, array(select d2.id from d d2 where p_states is not null), not (coalesce(p_states, '{}') <@ array['cancelled'])) r
  )
  select d.* from d
   where p_states is null
      or d.id in (select j.id from judged j where j.pay_state = any (p_states))
$$;
revoke all on function public.documents_by_pay_state(uuid, text[], uuid, uuid) from public, anon;
grant execute on function public.documents_by_pay_state(uuid, text[], uuid, uuid) to authenticated;

create or replace function public.documents_pay_summary(
  p_org uuid, p_states text[], p_contact uuid, p_company uuid, p_type text, p_status text, p_from date, p_to date, p_ids uuid[]
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
as $$
declare
  -- a non-member learns nothing about the business's plan (RLS already hides its rows)
  v_money boolean := coalesce(app.is_member(p_org), false) and coalesce(app.org_has_feature(p_org, 'payments'), false);
  v_partial boolean := false;
  v_out jsonb;
begin
  if p_ids is not null and cardinality(p_ids) > 20000 then
    raise exception 'too many documents in one call' using errcode = '22023', hint = 'documents_pay:too_many';
  end if;
  -- COL-01's partial rule (public.collection_documents; keep in step): owners and admins read every money row; anyone else
  -- gets balance totals only when they read every document and payment of the business
  if v_money and not coalesce(app.is_admin(p_org), false) then
    v_partial := coalesce(app.business_money_rows(p_org) >
                          (select count(*) from public.accounting_documents d where d.organization_id = p_org)
                          + (select count(*) from public.payments p where p.organization_id = p_org), true);
  end if;

  with d as materialized (
    select d.id from public.accounting_documents d
     where d.organization_id = p_org and d.status = 'active'
       and (p_ids is null or d.id = any (p_ids))
       and (p_type is null or d.doc_type = p_type)
       and (p_status is null or d.status = p_status)
       and (p_from is null or d.doc_date >= p_from)
       and (p_to is null or d.doc_date <= p_to)
       and (p_contact is null
            or d.contact_id = p_contact
            or d.deal_id in (select x.id from public.deals x where x.organization_id = p_org and x.contact_id = p_contact))
       and (p_company is null
            or d.company_id = p_company
            or d.contact_id in (select c.id from public.contacts c where c.organization_id = p_org and c.company_id = p_company)
            or d.deal_id in (select x.id from public.deals x where x.organization_id = p_org and x.company_id = p_company))
  ),
  r as materialized (
    select * from app.document_pay_rows(p_org, array(select d2.id from d d2), v_money or p_states is not null)
  ),
  f as (
    select r.* from r where p_states is null or r.pay_state = any (p_states)
  ),
  per_type as (
    select case when f.doc_type = 'opening_balance' then case when f.amount_agorot < 0 then 'opening_credit' else 'opening_debt' end
                else f.doc_type end as key,
           count(*) as n, sum(abs(f.amount_agorot)) as agorot
      from f group by 1
  )
  select jsonb_build_object(
    'count', (select count(*) from f),
    'by_type', coalesce((select jsonb_object_agg(p.key, jsonb_build_object('count', p.n, 'agorot', p.agorot)) from per_type p), '{}'::jsonb),
    'partial', v_partial,
    'open', case when v_money and not v_partial then (select coalesce(sum(f.balance), 0) from f) end,
    'overdue', case when v_money and not v_partial then (select coalesce(sum(f.balance) filter (where f.pay_state = 'overdue'), 0) from f) end)
    into v_out;
  return v_out;
end;
$$;
revoke all on function public.documents_pay_summary(uuid, text[], uuid, uuid, text, text, date, date, uuid[]) from public, anon;
grant execute on function public.documents_pay_summary(uuid, text[], uuid, uuid, text, text, date, date, uuid[]) to authenticated;

create or replace function public.documents_pay_rows(p_org uuid, p_ids uuid[])
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_ids), 0) > 2000 then
    raise exception 'too many documents in one call' using errcode = '22023', hint = 'documents_pay:too_many';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'pay_state', r.pay_state, 'balance', r.balance) order by r.id)
      from app.document_pay_rows(p_org, p_ids, coalesce(app.org_has_feature(p_org, 'payments'), false)) r), '[]'::jsonb);
end;
$$;
revoke all on function public.documents_pay_rows(uuid, uuid[]) from public, anon;
grant execute on function public.documents_pay_rows(uuid, uuid[]) to authenticated;
