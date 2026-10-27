-- =============================================================================
-- Money waiting: quotes, overdue debts and renewals, all with VAT (MNY-01, the groups whose modules exist)
-- =============================================================================
-- public.report_money_waiting(org, owner) keeps its signature, its security invoker mode (RLS decides what
-- counts) and the shape of every key it answered (today, to_close, stuck, overdue, deals, estimate, leads). Four
-- keys are added: vat, and one per group of additions spec 18.6 whose module is built.
--
-- * vat (owner, 27 October 2026, answer (2) ג: every group and the main number include VAT): {mode, rate_bp}
--   from app.org_document_vat_rate(org, the business's today) (invoker, reads public tables only). mode
--   'included' (rate > 0): every before-VAT amount (deal amounts, the recurring amount, the average won deal) is
--   converted by app.money_with_vat, half up in agorot per amount (as app.document_totals rounds); 'none' (the
--   business does not charge VAT, rate 0): amounts as they are; 'unknown' (VAT status not set, rate null):
--   before-VAT amounts as they are and the screen says so (lead's decisions). So the old keys' AMOUNTS change
--   (stuck, overdue, to_close, deals[].amount_agorot, estimate.average/amount): same shape, now with VAT.
-- * quotes (part "to_close"; plan flag `quotes`, else null): quotes sent and not answered. Status sent or
--   viewed, not past `valid_until` in the business's time zone, the customer not erased, the quote's deal (or,
--   without a deal, its contact) not in the bin, and the deal not lost (a quote on a won deal, such as an
--   addendum, stays; lead's decision). One per chain, through its newest sent version: a quote with a sent newer
--   version (previous_id) is left out, the rule of public.report_quotes' "open now" (and of
--   app.quote_shown_version). Value: total_agorot (with VAT, stored on the quote); net_total_agorot (before VAT)
--   while the VAT mode is 'unknown'. Rows carry both.
--   Each deal once (18.6): a deal with such an open quote is counted in quotes only, and leaves stuck, overdue
--   and renewals, but only in a view where that quote is counted: with p_owner, a quote of someone else does not
--   hide the deal from its owner's stuck and overdue (lead's decision, review of 27 October 2026).
-- * stuck / overdue: the cleanup's deals (public.report_pipeline_cleanup, MNY-05) less the deals counted in
--   quotes. The amounts are summed per deal with VAT, so they are read from the shared stuck rule
--   app.deal_attention_rows (the rule report_pipeline_cleanup keeps in step, test 93) plus the cleanup's overdue
--   rule (expected close date before today, not postponed, not stuck); keep both in step with
--   report_pipeline_cleanup. The listed deals are the cleanup's rows (at most 300) with amount_agorot converted.
-- * debts (part "owed"; plan flags `documents` and `payments` AND app.can_record_payments(org): owners, admins,
--   managers or the record_payments permission (owner, answer (4) ב); else null): active tax invoices,
--   proformas and positive opening balances whose due_date is before the business's today and that still have a
--   balance. The balance is public.money_allocation_state's (the one rule, invoker): a proforma billed by an
--   active tax invoice is 'transferred' with balance 0, and the invoice carries what is left, so nothing is
--   counted twice. Before money_allocation_state (whose cost grows with documents x allocations) the candidates
--   are narrowed: a document whose own counted allocations (payments and opening credits onto it, through their
--   (organization_id, document_id) indexes) already reach its amount, and a proforma billed by an active
--   invoice, can have no balance, so they are left out first; money_allocation_state still decides the rest.
--   Value: the balance (documents are with VAT already). With p_owner: the owner of the document's deal, else its
--   contact, else its company (an opening balance). Rows carry deal_contact_id (the deal's contact) for a
--   WhatsApp reminder when the document names no contact.
--   Accepted (as BAL-01): the balance is read under RLS, so a person who cannot read an allocation or a payment
--   on the document sees a balance higher than it is.
-- * renewals (part "to_close"; core, DEAL-07 has no plan key): open or won recurring deals (billing_kind set)
--   whose renewal_date falls from the business's today through 30 days ahead (owner, answer (1) א), not in the
--   bin, with no live follow-up deal (deals.previous_deal_id: DEAL-08's renewal deal or DEAL-11's follow-up works
--   it as its own deal). Value: one period of the recurring amount (answer (3) א), with VAT. A deal counted in
--   quotes, stuck or overdue is left out here (each deal once).
--
-- `to_close` keeps its meaning: the deals to close (stuck + overdue, after the quote rule above); the screen
-- adds the parts (src/features/money-waiting/groups.ts). Each group lists at most 300 rows; its count and
-- amount are over all of them. Every lookup goes through uuid columns (organization_id + id / FK columns);
-- nothing reads metadata. Safe to run twice: create or replace only.

-- A before-VAT amount with VAT at a rate in basis points, half up in agorot (as app.document_totals rounds).
-- null or 0 rate: the amount as it is. Pure.
create or replace function app.money_with_vat(p_amount bigint, p_rate_bp integer)
returns bigint
language sql immutable
set search_path = ''
as $$
  select case when p_amount is null then null
              when p_rate_bp is null or p_rate_bp = 0 then p_amount
              else p_amount + round(p_amount::numeric * p_rate_bp / 10000)::bigint end
$$;
revoke all on function app.money_with_vat(bigint, integer) from public, anon;
grant execute on function app.money_with_vat(bigint, integer) to authenticated;

create or replace function public.report_money_waiting(p_org uuid, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with cleanup as (
    select public.report_pipeline_cleanup(p_org, p_owner) as c
  ), cur as (
    select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today
      from public.organizations o
     where o.id = p_org
  ), flags as (
    select app.org_has_feature(p_org, 'quotes') as quotes,
           (app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments')
            and app.can_record_payments(p_org)) as debts
  ), vat as (
    select v.rate,
           case when v.rate is null then 'unknown' when v.rate = 0 then 'none' else 'included' end as mode
      from (select app.org_document_vat_rate(p_org, (select today from cur)) as rate where exists (select 1 from cur)) v
  ), won as (
    select count(*) as deals, avg(w.amount_agorot) as average
      from public.deals w
     where w.organization_id = p_org and w.deleted_at is null and w.status = 'won'
       and w.closed_at >= now() - interval '90 days'
  ), l as (
    select l.id, l.full_name, l.company_name, l.phone, l.phone_e164, l.email, l.owner_id, l.created_at
      from public.leads l
      join public.lead_statuses st on st.organization_id = l.organization_id and st.id = l.status_id
     where l.organization_id = p_org and l.deleted_at is null and l.converted_at is null
       and l.import_job_id is null and st.kind = 'open'
       and (p_owner is null or l.owner_id = p_owner)
       and not exists (
         select 1 from public.activities a
          where a.organization_id = l.organization_id and a.lead_id = l.id
            and a.created_by is not null and a.type = any (app.contact_types())
            and not a.is_private)
       and (l.taken_at is null
            or l.owner_id = (select auth.uid())
            or app.membership_role(p_org) in ('owner', 'admin')
            or (app.membership_role(p_org) = 'manager' and l.team_id is not null and app.manages_team(l.team_id)))
  ), avg_value as (
    select case when won.deals >= 5 then app.money_with_vat(round(won.average)::bigint, (select rate from vat)) end as average,
           won.deals
      from won
  ),
  -- quotes sent and not answered; q_rows narrows to p_owner
  q_all as (
    select q.id, q.number_display, q.title, q.status, q.sent_at, q.valid_until, q.net_total_agorot, q.total_agorot,
           q.deal_id, q.contact_id, q.owner_id, q.customer_name,
           case when (select mode from vat) = 'unknown' then q.net_total_agorot else q.total_agorot end as value
      from public.quotes q
     where q.organization_id = p_org
       and (select f.quotes from flags f)
       and q.status in ('sent', 'viewed')
       and q.sent_at is not null
       and q.customer_deleted_at is null
       and (q.valid_until is null or q.valid_until >= (select today from cur))
       and not exists (select 1 from public.quotes n
                        where n.organization_id = q.organization_id and n.previous_id = q.id and n.sent_at is not null)
       and (case when q.deal_id is not null then
              exists (select 1 from public.deals d
                       where d.organization_id = q.organization_id and d.id = q.deal_id and d.deleted_at is null
                         and d.status <> 'lost')
            else
              exists (select 1 from public.contacts k
                       where k.organization_id = q.organization_id and k.id = q.contact_id and k.deleted_at is null)
            end)
  ), q_rows as (
    select * from q_all where p_owner is null or owner_id = p_owner
  ), q_deals as (
    -- only the quotes this view counts hide their deals
    select distinct deal_id from q_rows where deal_id is not null
  ),
  -- the cleanup's stuck and overdue deals, each with its amount, less the deals counted in quotes
  att as (
    select a.id, app.money_with_vat(a.amount_agorot, (select rate from vat)) as amount, a.stuck,
           (not a.stuck and d.expected_close_date is not null and d.expected_close_date < (select today from cur)
            and (d.snoozed_until is null or d.snoozed_until <= (select today from cur))) as overdue
      from app.deal_attention_rows(p_org, null, p_owner, 14, null) a
      join public.deals d on d.organization_id = p_org and d.id = a.id
     where a.id not in (select deal_id from q_deals)
  ),
  -- recurring deals renewing in the next 30 days
  r_rows as (
    select d.id, d.name, d.owner_id, d.status, d.billing_kind,
           app.money_with_vat(d.recurring_amount_agorot, (select rate from vat)) as amount, d.renewal_date, d.contact_id
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status in ('open', 'won')
       and d.billing_kind is not null and d.renewal_date is not null
       and d.renewal_date >= (select today from cur) and d.renewal_date <= (select today from cur) + 30
       and (p_owner is null or d.owner_id = p_owner)
       and not exists (select 1 from public.deals f
                        where f.organization_id = d.organization_id and f.previous_deal_id = d.id and f.deleted_at is null)
       and d.id not in (select deal_id from q_deals)
       and d.id not in (select id from att where stuck or overdue)
  ),
  -- overdue debts
  debt_docs as (
    select d.id, d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, d.deal_id, d.contact_id, d.company_id,
           d.order_id, dl.contact_id as deal_contact_id, coalesce(ct.full_name, co.name, dl.name) as customer_name,
           coalesce(dl.owner_id, ct.owner_id, co.owner_id) as owner_id
      from public.accounting_documents d
      left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
      left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
      left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
     where d.organization_id = p_org
       and (select f.debts from flags f)
       and d.status = 'active'
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
       and d.amount_agorot > 0
       and d.due_date is not null and d.due_date < (select today from cur)
       and (p_owner is null or coalesce(dl.owner_id, ct.owner_id, co.owner_id) = p_owner)
       -- candidates only: a proforma billed by an active invoice, or a document whose own counted allocations reach
       -- its amount, has no balance (money_allocation_state's rule; proforma payments only lower an invoice further)
       and not (d.doc_type = 'proforma'
                and exists (select 1 from public.accounting_documents i
                             where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
       and coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                      where a.organization_id = d.organization_id and a.document_id = d.id
                        and a.released_at is null and a.removed_at is null), 0)
           + coalesce((select sum(o.amount_agorot) from public.opening_credit_allocations o
                        where o.organization_id = d.organization_id and o.document_id = d.id
                          and o.released_at is null and o.removed_at is null), 0)
           < d.amount_agorot
  ), debt_state as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(
             public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from debt_docs), '{}'::uuid[])
               -> 'documents') x
  ), debts as (
    select d.*, s.balance, ((select today from cur) - d.due_date) as days_overdue
      from debt_docs d join debt_state s on s.id = d.id
     where s.balance > 0
  )
  select jsonb_build_object(
    'today', c -> 'today',
    'vat', (select jsonb_build_object('mode', v.mode, 'rate_bp', v.rate) from vat v),
    'to_close', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(amount), 0)) from att where stuck or overdue),
    'stuck', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(amount), 0)) from att where stuck),
    'overdue', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(amount), 0)) from att where overdue),
    'deals', coalesce((
      select jsonb_agg(jsonb_set(e, '{amount_agorot}',
                                 coalesce(to_jsonb(app.money_with_vat((e ->> 'amount_agorot')::bigint, (select rate from vat))), 'null'::jsonb))
                       order by o)
        from jsonb_array_elements(c -> 'deals') with ordinality t(e, o)
       where (e ->> 'id')::uuid not in (select deal_id from q_deals)), '[]'::jsonb),
    'estimate', (
      select jsonb_build_object(
               'leads', (select count(*) from l),
               'won_deals', av.deals,
               'average', av.average,
               'amount', av.average * (select count(*) from l),
               'days', 90,
               'min_deals', 5)
        from avg_value av),
    'leads', coalesce((
      select jsonb_agg(z order by z.created_at desc, z.id)
        from (select * from l order by l.created_at desc, l.id limit 100) z), '[]'::jsonb),
    'quotes', case when (select f.quotes from flags f) then jsonb_build_object(
      'count', (select count(*) from q_rows),
      'amount', (select coalesce(sum(value), 0) from q_rows),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', z.id, 'number', z.number_display, 'title', z.title, 'status', z.status, 'sent_at', z.sent_at,
                 'valid_until', z.valid_until, 'amount_agorot', z.value, 'net_agorot', z.net_total_agorot,
                 'total_agorot', z.total_agorot, 'deal_id', z.deal_id, 'contact_id', z.contact_id, 'owner_id', z.owner_id,
                 'customer_name', z.customer_name)
                 order by z.sent_at, z.id)
          from (select * from q_rows order by sent_at, id limit 300) z), '[]'::jsonb)) end,
    'debts', case when (select f.debts from flags f) then jsonb_build_object(
      'count', (select count(*) from debts),
      'amount', (select coalesce(sum(balance), 0) from debts),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', z.id, 'doc_type', z.doc_type, 'number', z.number, 'doc_date', z.doc_date, 'due_date', z.due_date,
                 'days_overdue', z.days_overdue, 'amount_agorot', z.amount_agorot, 'balance', z.balance,
                 'deal_id', z.deal_id, 'contact_id', z.contact_id, 'company_id', z.company_id, 'order_id', z.order_id,
                 'deal_contact_id', z.deal_contact_id, 'owner_id', z.owner_id, 'customer_name', z.customer_name)
                 order by z.due_date, z.id)
          from (select * from debts order by due_date, id limit 300) z), '[]'::jsonb)) end,
    'renewals', jsonb_build_object(
      'count', (select count(*) from r_rows),
      'amount', (select coalesce(sum(amount), 0) from r_rows),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', z.id, 'name', z.name, 'owner_id', z.owner_id, 'status', z.status, 'billing_kind', z.billing_kind,
                 'amount_agorot', z.amount, 'renewal_date', z.renewal_date, 'contact_id', z.contact_id)
                 order by z.renewal_date, z.id)
          from (select * from r_rows order by renewal_date, id limit 300) z), '[]'::jsonb)))
    from cleanup
   where c is not null;
$$;

revoke all on function public.report_money_waiting(uuid, uuid) from public, anon;
grant execute on function public.report_money_waiting(uuid, uuid) to authenticated;
