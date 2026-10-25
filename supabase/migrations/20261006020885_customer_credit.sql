-- =============================================================================
-- PAY-03: the customer's credit balance (spec 7.1: a payment with no document, an advance, is kept as the customer's credit
-- and allocated to a document when one is issued; 7.6: an overpayment's remainder stays as the customer's credit). The
-- lead's choices of 25 October 2026, recorded in DECISIONS.md and asked of the owner: (1) the document form offers
-- "לקזז מהיתרה", ticked; (2) the customer is PAY-02's rule; (3) no advance marker: any unallocated part of a recorded or
-- confirmed payment is credit; (4) the total shows on the payments card of the contact, the deal and the company. No plan
-- key of its own: the `payments` and `documents` flags, as PAY-02.
-- =============================================================================
-- * public.money_customer_credit(org, deal, contact, company) (invoker: RLS decides which payments are counted) answers the
--   credit a document recorded there could use: {total, count, payments: [{id, paid_on, method, amount, credit}]}, the
--   payments oldest first (at most 200 listed; total and count over all of them). "The same customer" is PAY-02's
--   (app.money_same_customer, as public.money_allocation_candidates reads it: the deal, the contact, and every deal and
--   contact of their companies, or of the company passed). Each payment's credit is public.money_allocation_state's.
-- * public.money_apply_credit(org, document, max) (invoker) allocates that credit to an active tax invoice or proforma,
--   oldest payment first (money_allocation_candidates' list, at most 100), up to the document's balance and the optional
--   cap. Every allocation is an ordinary insert into public.payment_allocations, so its trigger and RLS judge it (rights,
--   flags, the same customer, the limits). Only the refusals a race can cause are caught, each in its own block:
--   allocation:payment_over and allocation:payment_state skip that payment; allocation:document_over re-reads the
--   document's balance. Anything else is raised. Answers {allocated, payments: [{payment_id, amount}]}.
-- Every statement is safe to run twice. No table, no drops, no row removal.

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
  same_deals as (
    select p_deal as id where p_deal is not null
    union
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  open_payments as (
    select p.id, p.paid_on, p.method, p.amount_agorot
      from public.payments p
     where p.organization_id = p_org and p.status in ('recorded', 'confirmed')
       and (p.deal_id in (select id from same_deals) or p.contact_id in (select id from same_contacts))
  ),
  pay_state as (
    select x from jsonb_array_elements(
      public.money_allocation_state(p_org, '{}', (select coalesce(array_agg(id), '{}') from open_payments)) -> 'payments') x
  ),
  credits as (
    select p.id, p.paid_on, p.method, p.amount_agorot as amount, (s.x ->> 'credit')::bigint as credit
      from open_payments p
      join pay_state s on (s.x ->> 'id')::uuid = p.id
     where (s.x ->> 'credit')::bigint > 0
  )
  select jsonb_build_object(
    'total', coalesce((select sum(c.credit) from credits c), 0)::bigint,
    'count', (select count(*) from credits),
    'payments', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.paid_on, t.id)
        from (select c.id, c.paid_on, c.method, c.amount, c.credit from credits c order by c.paid_on, c.id limit 200) t), '[]'::jsonb)
  )
$$;
revoke all on function public.money_customer_credit(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.money_customer_credit(uuid, uuid, uuid, uuid) to authenticated;

-- allocates the customer's credit to a document (a document the caller does not read, or one with no balance, takes nothing)
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

  for v_pay in
    select x from jsonb_array_elements(public.money_allocation_candidates(p_org, null, p_document) -> 'payments') x
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
