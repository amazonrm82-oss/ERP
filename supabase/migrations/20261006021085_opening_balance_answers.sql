-- =============================================================================
-- GAP-12 follow-up: the owner's answers of 27 October 2026 (DECISIONS.md "יתרת פתיחה: החלפה וסדר זיכוי").
-- =============================================================================
-- * Answer (1) ג: an active opening balance is never replaced while it holds counted allocations. public.opening_balance_set
--   refuses (P0001, hint opening_balance:allocated) when an active opening balance of the customer has a payment allocation
--   onto it (payment_allocations, released_at and removed_at null) or a counted opening-credit offset onto it (a debt,
--   opening_credit_allocations.document_id) or from it (a credit, opening_credit_allocations.credit_document_id). The
--   allocations are released by hand first (an owner or admin undoes them, removed_at); cancelling the balance itself by hand
--   still releases them as any cancel does. The check runs under the customer's advisory lock and after the customer's active
--   opening balances are locked FOR UPDATE (in id order), so an allocation racing the replace either committed before it (and
--   is seen) or waits for the document lock and then meets a cancelled document (allocation:document_state). The import calls
--   the same function and reports the row's balance as not replaced, with this reason, without failing the chunk.
-- * Answer (2) ג: public.money_apply_credit uses the customer's credit oldest first across both sources: payments with credit
--   (by paid_on) and negative opening balances (by doc_date), ties by created_at, then id. The advances of the document's
--   order or of its order's quote still come first (in the candidates' order, as before). Everything else is unchanged: the
--   same candidates, the same inserts (so the same allocation triggers, locks and lock order), the same caught hints and the
--   same answer shape.
-- * Bodies copied from their latest definitions (opening_balance_set 021076, money_apply_credit 021077), changed only where
--   marked GAP-12 answers. Same signatures, so no drop.
-- Every statement is safe to run twice. No drops of objects, no row removal.

-- ----------------------------------------------------------------------------
-- Answer (1) ג: no replace while allocated
-- ----------------------------------------------------------------------------
create or replace function public.opening_balance_set(p_org uuid, p_contact uuid, p_company uuid, p_amount bigint, p_date date,
                                                      p_due date default null, p_job uuid default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_id uuid;
begin
  if not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners and admins record an opening balance' using errcode = '42501', hint = 'document:opening_admin';
  end if;
  if not app.org_has_feature(p_org, 'documents') then
    raise exception 'documents are not in the plan' using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if (p_contact is null) = (p_company is null) then
    raise exception 'an opening balance is a contact''s or a company''s' using errcode = '22023', hint = 'document:parent';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000000000 or p_date is null then
    raise exception 'an opening balance is a debt or a credit, on a day' using errcode = '22023', hint = 'document:opening_amount';
  end if;
  if (p_contact is not null and not exists (select 1 from public.contacts c
                                             where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null))
     or (p_company is not null and not exists (select 1 from public.companies co
                                                where co.organization_id = p_org and co.id = p_company and co.deleted_at is null)) then
    raise exception 'the customer is not in this business' using errcode = 'P0001', hint = 'document:parent';
  end if;
  if p_job is not null and not exists (
       select 1 from public.import_jobs j
        where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'running'
          and j.entity_type = case when p_contact is not null then 'contact' else 'company' end) then
    raise exception 'not your running import of this kind' using errcode = 'P0001', hint = 'document:opening_job';
  end if;
  v_reason := case when p_job is not null then 'הוחלפה בייבוא' else 'הוחלפה ביתרה חדשה' end;

  perform pg_advisory_xact_lock(hashtextextended('opening_balance:' || p_org::text || ':' || coalesce(p_contact, p_company)::text, 0));
  -- GAP-12 answers (1) ג: lock the customer's active opening balances (the documents an allocation locks too), then refuse
  -- while any of them holds a counted payment allocation or opening-credit offset (onto a debt, or from a credit)
  perform 1
     from public.accounting_documents a
    where a.organization_id = p_org and a.doc_type = 'opening_balance' and a.status = 'active'
      and ((p_contact is not null and a.contact_id = p_contact) or (p_company is not null and a.company_id = p_company))
    order by a.id
      for update;
  if exists (
       select 1
         from public.accounting_documents a
        where a.organization_id = p_org and a.doc_type = 'opening_balance' and a.status = 'active'
          and ((p_contact is not null and a.contact_id = p_contact) or (p_company is not null and a.company_id = p_company))
          and (exists (select 1 from public.payment_allocations pa
                        where pa.organization_id = p_org and pa.document_id = a.id
                          and pa.released_at is null and pa.removed_at is null)
               or exists (select 1 from public.opening_credit_allocations oc
                           where oc.organization_id = p_org and (oc.document_id = a.id or oc.credit_document_id = a.id)
                             and oc.released_at is null and oc.removed_at is null))) then
    raise exception 'the opening balance has allocations; release them first'
      using errcode = 'P0001', hint = 'opening_balance:allocated';
  end if;
  update public.accounting_documents a
     set status = 'cancelled', cancel_reason = v_reason
   where a.organization_id = p_org and a.doc_type = 'opening_balance' and a.status = 'active'
     and ((p_contact is not null and a.contact_id = p_contact) or (p_company is not null and a.company_id = p_company));
  insert into public.accounting_documents (organization_id, contact_id, company_id, doc_type, number, doc_date, amount_agorot, due_date,
                                           import_job_id)
  values (p_org, p_contact, p_company, 'opening_balance', null, p_date, p_amount, p_due, p_job)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.opening_balance_set(uuid, uuid, uuid, bigint, date, date, uuid) from public, anon;
grant execute on function public.opening_balance_set(uuid, uuid, uuid, bigint, date, date, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Answer (2) ג: the customer's credit oldest first, payments and opening credits together (advances of the order first)
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
  v_hint text;
  v_order uuid;
  v_order_quote uuid;
  v_total bigint := 0;
  v_done jsonb := '[]'::jsonb;
  v_source record;
  v_docs jsonb := '[]'::jsonb;
begin
  if p_max is not null and p_max <= 0 then
    raise exception 'the cap is a positive amount' using errcode = '22023', hint = 'credit:max';
  end if;
  select (x ->> 'balance')::bigint into v_balance
    from jsonb_array_elements(public.money_allocation_state(p_org, array[p_document], '{}') -> 'documents') x;
  v_left := least(coalesce(v_balance, 0), coalesce(p_max, coalesce(v_balance, 0)));
  if v_left <= 0 then
    return jsonb_build_object('allocated', 0, 'payments', '[]'::jsonb, 'documents', '[]'::jsonb);
  end if;
  -- the document's order, and the quote it was made from (read with the caller's rights)
  select d.order_id into v_order from public.accounting_documents d where d.organization_id = p_org and d.id = p_document;
  if v_order is not null then
    select o.quote_id into v_order_quote from public.orders o where o.organization_id = p_org and o.id = v_order;
  end if;

  -- GAP-12 answers (2) ג: one list of credit sources. The advances of the document's order (or of its order's quote) first,
  -- in the candidates' order as before; then every other payment with credit and the customer's negative opening balances
  -- (read with the caller's rights), oldest first by paid_on / doc_date, then created_at, then id
  for v_source in
    with pays as (
      select 'payment'::text as kind, (c.x ->> 'id')::uuid as id, (c.x ->> 'credit')::bigint as credit,
             ((p.is_advance and ((v_order is not null and p.advance_order_id = v_order)
                                 or (v_order_quote is not null and p.advance_quote_id = v_order_quote))) is true) as advance,
             c.i as advance_rank,
             coalesce(p.paid_on, (c.x ->> 'paid_on')::date) as on_date, p.created_at
        from jsonb_array_elements(public.money_allocation_candidates(p_org, null, p_document) -> 'payments') with ordinality as c(x, i)
        left join public.payments p on p.organization_id = p_org and p.id = (c.x ->> 'id')::uuid
    ),
    openings as (
      select 'opening'::text as kind, o.id, app.opening_credit_left(p_org, o.id) as credit, false as advance,
             null::bigint as advance_rank, o.doc_date as on_date, o.created_at
        from public.accounting_documents o
        join public.accounting_documents t on t.organization_id = p_org and t.id = p_document
       where o.organization_id = p_org and o.doc_type = 'opening_balance' and o.status = 'active' and o.amount_agorot < 0
         and app.money_same_customer_doc(p_org, o.deal_id, o.contact_id, o.company_id, t.deal_id, t.contact_id, t.company_id)
    )
    select s.kind, s.id, s.credit
      from (select * from pays union all select * from openings) s
     order by s.advance desc,
              case when s.advance then s.advance_rank end,
              s.on_date, s.created_at, s.id
  loop
    exit when v_left <= 0;
    v_take := least(v_source.credit, v_left);
    continue when v_take <= 0;
    if v_source.kind = 'payment' then
      begin
        insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
        values (p_org, v_source.id, p_document, v_take);
        v_total := v_total + v_take;
        v_left := v_left - v_take;
        v_done := v_done || jsonb_build_array(jsonb_build_object('payment_id', v_source.id::text, 'amount', v_take));
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
    else
      begin
        insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot)
        values (p_org, v_source.id, p_document, v_take);
        v_total := v_total + v_take;
        v_left := v_left - v_take;
        v_docs := v_docs || jsonb_build_array(jsonb_build_object('document_id', v_source.id, 'amount', v_take));
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if v_hint in ('credit_allocation:over', 'credit_allocation:credit') then
          null;
        elsif v_hint = 'allocation:document_over' then
          select (x ->> 'balance')::bigint into v_balance
            from jsonb_array_elements(public.money_allocation_state(p_org, array[p_document], '{}') -> 'documents') x;
          v_left := least(coalesce(v_balance, 0), coalesce(p_max - v_total, coalesce(v_balance, 0)));
        else
          raise;
        end if;
      end;
    end if;
  end loop;
  return jsonb_build_object('allocated', v_total, 'payments', v_done, 'documents', v_docs);
end;
$$;
revoke all on function public.money_apply_credit(uuid, uuid, bigint) from public, anon;
grant execute on function public.money_apply_credit(uuid, uuid, bigint) to authenticated;
