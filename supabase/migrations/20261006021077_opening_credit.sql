-- =============================================================================
-- GAP-12 (continued), owner's answer (2) א of 26 October 2026: a negative opening balance is customer credit, offset against
-- invoices like a payment's credit (PAY-03).
-- =============================================================================
-- * public.opening_credit_allocations: one row per share of a negative opening balance (credit_document_id: an ACTIVE
--   opening_balance with amount < 0) offset against a document that takes payments (document_id: an active tax invoice or
--   proforma not billed by an active invoice, or a positive opening balance) of the same customer. Shaped like PAY-02's
--   payment_allocations, with the same rules for every writer (definer trigger app.opening_credit_allocations_check, outsider
--   guard first):
--     - who: whoever records payments (app.can_record_payments) in a writable business with the `payments` and `documents`
--       keys; changing the amount or undoing (removed_at): owners and admins; never deleted (no delete grant or policy);
--     - never more than the credit holds (credit_allocation:over) or the document's balance (allocation:document_over: the
--       document's payment allocations, its credit allocations and, for a tax invoice, its proforma's, together);
--     - the same customer (allocation:customer): app.money_same_customer_doc, PAY-02's rule over a document's deal,
--       contact and company on both sides (each side's companies: its company, its contact's company, its deal's company);
--     - a release is final and the server's: cancelling the credit or the document releases its rows (released_at);
--     - locks: the credit, then the document, then a tax invoice's proforma, FOR UPDATE (as PAY-02: payment, document,
--       proforma). Read: whoever reads either document. Audited.
-- * Every reader of a document's balance counts these rows: public.money_allocation_state (paid; and `credit`, what a
--   negative opening balance still holds), app.payment_allocations_check (a payment never over the rest), the ledger's
--   credit_balance. public.money_customer_credit adds the opening credits (`documents`, and in `total`);
--   public.money_apply_credit offsets them after the payments (the payments' order is unchanged: advances of the document's
--   order first). The server-kept totals of the credit column (customer_credit_totals) add a company's and its contacts'
--   opening credits to the company and a contact's own to the contact, refreshed at commit by deferred constraint
--   triggers on accounting_documents, opening_credit_allocations and a contact's company change, under the same business
--   lock as PAY-03 (app.opening_credit_doc_sync; the company each balance's total sat on is kept in
--   app.opening_credit_companies, so a purge or a merge that deletes the contact still refreshes the company it left).
-- * Bodies copied from their latest definitions, changed only where marked GAP-12 credit: app.payment_allocations_check,
--   public.money_allocation_state, public.customer_ledger (021076), public.money_customer_credit, public.money_apply_credit,
--   app.customer_credit_company_refresh, app.customer_credit_contact_refresh, app.payment_credit_companies_on_customer (020890).
-- Every statement is safe to run twice. No drops of objects, no row removal.

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.opening_credit_allocations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  credit_document_id uuid not null,
  document_id        uuid not null,
  amount_agorot      bigint not null check (amount_agorot between 1 and 1000000000000),
  currency           text not null default 'ILS' check (currency = 'ILS'),
  released_at        timestamptz,
  removed_at         timestamptz,
  removed_by         uuid references auth.users (id) on delete set null,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint opening_credit_allocations_credit_fk foreign key (organization_id, credit_document_id)
    references public.accounting_documents (organization_id, id),
  constraint opening_credit_allocations_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id),
  constraint opening_credit_allocations_two check (credit_document_id <> document_id)
);
create index if not exists opening_credit_allocations_credit_idx on public.opening_credit_allocations (organization_id, credit_document_id);
create index if not exists opening_credit_allocations_document_idx on public.opening_credit_allocations (organization_id, document_id);

alter table public.opening_credit_allocations enable row level security;
revoke all on public.opening_credit_allocations from anon, authenticated;
grant select on public.opening_credit_allocations to authenticated;
grant insert (organization_id, credit_document_id, document_id, amount_agorot, currency) on public.opening_credit_allocations to authenticated;
grant update (amount_agorot, removed_at) on public.opening_credit_allocations to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'opening_credit_allocations' and policyname = 'opening_credit_allocations_select') then
    create policy opening_credit_allocations_select on public.opening_credit_allocations for select to authenticated
      using (exists (select 1 from public.accounting_documents d
                      where d.organization_id = opening_credit_allocations.organization_id and d.id = opening_credit_allocations.document_id)
             or exists (select 1 from public.accounting_documents c
                         where c.organization_id = opening_credit_allocations.organization_id and c.id = opening_credit_allocations.credit_document_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'opening_credit_allocations' and policyname = 'opening_credit_allocations_insert') then
    create policy opening_credit_allocations_insert on public.opening_credit_allocations for insert to authenticated
      with check (app.can_record_payments(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'payments') and app.org_has_feature(organization_id, 'documents')
                  and exists (select 1 from public.accounting_documents c
                               where c.organization_id = opening_credit_allocations.organization_id and c.id = opening_credit_allocations.credit_document_id)
                  and exists (select 1 from public.accounting_documents d
                               where d.organization_id = opening_credit_allocations.organization_id and d.id = opening_credit_allocations.document_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'opening_credit_allocations' and policyname = 'opening_credit_allocations_update') then
    create policy opening_credit_allocations_update on public.opening_credit_allocations for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id)
             and (exists (select 1 from public.accounting_documents d
                           where d.organization_id = opening_credit_allocations.organization_id and d.id = opening_credit_allocations.document_id)
                  or exists (select 1 from public.accounting_documents c
                              where c.organization_id = opening_credit_allocations.organization_id and c.id = opening_credit_allocations.credit_document_id)))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  -- no delete policy and no delete grant: an offset is undone (removed_at), never deleted
end;
$$;

-- ----------------------------------------------------------------------------
-- Helpers (ids and numbers only; no grants)
-- ----------------------------------------------------------------------------
-- PAY-02's "same customer" over a document's deal, contact and company on both sides
create or replace function app.money_same_customer_doc(p_org uuid, p_deal_a uuid, p_contact_a uuid, p_company_a uuid,
                                                       p_deal_b uuid, p_contact_b uuid, p_company_b uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p_deal_a is not null and p_deal_a = p_deal_b, false)
      or coalesce(p_contact_a is not null and p_contact_a = p_contact_b, false)
      or exists (
           select 1
             from (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = p_contact_a
                   union all
                   select d.company_id from public.deals d where d.organization_id = p_org and d.id = p_deal_a
                   union all
                   select p_company_a) a
             join (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = p_contact_b
                   union all
                   select d.company_id from public.deals d where d.organization_id = p_org and d.id = p_deal_b
                   union all
                   select p_company_b) b
               on a.company_id = b.company_id
         )
$$;
revoke all on function app.money_same_customer_doc(uuid, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
-- public.money_apply_credit is invoker: the caller runs it, on the documents it reads (a yes or no over ids only)
grant execute on function app.money_same_customer_doc(uuid, uuid, uuid, uuid, uuid, uuid, uuid) to authenticated;

-- the counted offsets TO a document, or FROM a credit, leaving one row out (an update re-checks its own row)
create or replace function app.credited_on_document(p_org uuid, p_document uuid, p_skip uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(a.amount_agorot), 0)::bigint from public.opening_credit_allocations a
   where a.organization_id = p_org and a.document_id = p_document and a.released_at is null and a.removed_at is null
     and a.id is distinct from p_skip
$$;
revoke all on function app.credited_on_document(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.credit_used(p_org uuid, p_credit uuid, p_skip uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(a.amount_agorot), 0)::bigint from public.opening_credit_allocations a
   where a.organization_id = p_org and a.credit_document_id = p_credit and a.released_at is null and a.removed_at is null
     and a.id is distinct from p_skip
$$;
revoke all on function app.credit_used(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- what an active negative opening balance still holds (0 for anything else)
create or replace function app.opening_credit_left(p_org uuid, p_credit uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select greatest(-d.amount_agorot - app.credit_used(p_org, d.id, null), 0)
                     from public.accounting_documents d
                    where d.organization_id = p_org and d.id = p_credit and d.doc_type = 'opening_balance'
                      and d.status = 'active' and d.amount_agorot < 0), 0)::bigint
$$;
revoke all on function app.opening_credit_left(uuid, uuid) from public, anon, authenticated, service_role;
-- money_allocation_state, money_customer_credit and the ledger are invoker: the caller runs these two
grant execute on function app.credit_used(uuid, uuid, uuid) to authenticated;
grant execute on function app.opening_credit_left(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The rules of an offset (every writer)
-- ----------------------------------------------------------------------------
create or replace function app.opening_credit_allocations_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_credit public.accounting_documents;
  v_doc public.accounting_documents;
  v_proforma public.accounting_documents;
  v_doc_total bigint;
begin
  -- outsider guard: RLS refuses (42501) a person who may not allocate here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if row(new.organization_id, new.credit_document_id, new.document_id, new.created_by, new.created_at)
       is distinct from row(old.organization_id, old.credit_document_id, old.document_id, old.created_by, old.created_at) then
      raise exception 'an offset stays on its credit and document' using errcode = 'P0001', hint = 'allocation:fixed';
    end if;
    -- the server's release (one level down, from a cancel): the time only, once
    if new.released_at is distinct from old.released_at then
      if old.released_at is not null or new.released_at is null or pg_trigger_depth() < 2
         or row(new.amount_agorot, new.removed_at, new.removed_by) is distinct from row(old.amount_agorot, old.removed_at, old.removed_by) then
        raise exception 'only the server releases an offset' using errcode = 'P0001', hint = 'allocation:closed';
      end if;
      return new;
    end if;
    if old.released_at is not null or old.removed_at is not null then
      raise exception 'a released or undone offset does not change' using errcode = 'P0001', hint = 'allocation:closed';
    end if;
    if auth.uid() is not null and not app.is_admin(new.organization_id) then
      raise exception 'only owners and admins change an offset' using errcode = 'P0001', hint = 'allocation:admin';
    end if;
    if new.removed_at is not null then
      if new.amount_agorot is distinct from old.amount_agorot then
        raise exception 'undo an offset without changing its amount' using errcode = 'P0001', hint = 'allocation:closed';
      end if;
      new.removed_at := now();
      new.removed_by := auth.uid();
      return new;
    end if;
    new.removed_by := old.removed_by;
    if new.amount_agorot = old.amount_agorot then
      return new;
    end if;
  else
    new.released_at := null;
    new.removed_at := null;
    new.removed_by := null;
    new.created_by := coalesce(auth.uid(), new.created_by);
    if not app.org_has_feature(new.organization_id, 'payments') then
      raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
    end if;
    if not app.org_has_feature(new.organization_id, 'documents') then
      raise exception 'documents are not in the plan' using errcode = 'P0001', hint = 'feature:documents';
    end if;
  end if;

  -- the lock order: the credit, then the document, then a tax invoice's proforma
  select * into v_credit from public.accounting_documents d
   where d.organization_id = new.organization_id and d.id = new.credit_document_id for update;
  select * into v_doc from public.accounting_documents d
   where d.organization_id = new.organization_id and d.id = new.document_id for update;
  if v_credit.id is null or v_doc.id is null then
    raise exception 'the credit and the document are of this business' using errcode = 'P0001', hint = 'allocation:customer';
  end if;
  if v_doc.doc_type = 'tax_invoice' and v_doc.proforma_id is not null then
    select * into v_proforma from public.accounting_documents d
     where d.organization_id = new.organization_id and d.id = v_doc.proforma_id for update;
  end if;

  if v_credit.doc_type <> 'opening_balance' or v_credit.amount_agorot >= 0 or v_credit.status <> 'active' then
    raise exception 'only an active opening credit is offset' using errcode = 'P0001', hint = 'credit_allocation:credit';
  end if;
  if v_doc.doc_type not in ('tax_invoice', 'proforma')
     and not (v_doc.doc_type = 'opening_balance' and v_doc.amount_agorot > 0) then
    raise exception 'only a tax invoice, a proforma or an opening debt takes an offset' using errcode = 'P0001', hint = 'allocation:doc_type';
  end if;
  if v_doc.status <> 'active' then
    raise exception 'a cancelled document takes no offset' using errcode = 'P0001', hint = 'allocation:document_state';
  end if;
  if v_doc.doc_type = 'proforma'
     and exists (select 1 from public.accounting_documents i
                  where i.organization_id = new.organization_id and i.proforma_id = v_doc.id and i.status = 'active') then
    raise exception 'this proforma is billed by a tax invoice; offset against the invoice' using errcode = 'P0001', hint = 'allocation:transferred';
  end if;
  if tg_op = 'INSERT'
     and not app.money_same_customer_doc(new.organization_id, v_credit.deal_id, v_credit.contact_id, v_credit.company_id,
                                         v_doc.deal_id, v_doc.contact_id, v_doc.company_id) then
    raise exception 'a credit is offset against a document of the same customer' using errcode = 'P0001', hint = 'allocation:customer';
  end if;

  if app.credit_used(new.organization_id, v_credit.id, new.id) + new.amount_agorot > -v_credit.amount_agorot then
    raise exception 'more than the credit holds' using errcode = 'P0001', hint = 'credit_allocation:over';
  end if;
  v_doc_total := app.allocated_on_document(new.organization_id, v_doc.id, null)
                 + app.credited_on_document(new.organization_id, v_doc.id, new.id) + new.amount_agorot;
  if v_proforma.id is not null and v_proforma.status = 'active' then
    v_doc_total := v_doc_total + app.allocated_on_document(new.organization_id, v_proforma.id, null)
                   + app.credited_on_document(new.organization_id, v_proforma.id, null);
  end if;
  if v_doc_total > v_doc.amount_agorot then
    raise exception 'more than the document holds' using errcode = 'P0001', hint = 'allocation:document_over';
  end if;
  return new;
end;
$$;
revoke all on function app.opening_credit_allocations_check() from public, anon, authenticated, service_role;

create or replace trigger opening_credit_allocations_check before insert or update on public.opening_credit_allocations
  for each row execute function app.opening_credit_allocations_check();
create or replace trigger opening_credit_allocations_touch before insert or update on public.opening_credit_allocations
  for each row execute function app.touch_row();
create or replace trigger opening_credit_allocations_audit after insert or update or delete on public.opening_credit_allocations
  for each row execute function app.audit_row();

-- releases: cancelling the credit or the document (final, stamped by the server)
create or replace function app.accounting_documents_release_credits() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update public.opening_credit_allocations a set released_at = now()
     where a.organization_id = new.organization_id and (a.document_id = new.id or a.credit_document_id = new.id)
       and a.released_at is null and a.removed_at is null;
  end if;
  return null;
end;
$$;
revoke all on function app.accounting_documents_release_credits() from public, anon, authenticated, service_role;

create or replace trigger accounting_documents_release_credits after update on public.accounting_documents
  for each row execute function app.accounting_documents_release_credits();


-- ----------------------------------------------------------------------------
-- PAY-02: a payment's share never passes what the document still owes after its offsets
-- ----------------------------------------------------------------------------
create or replace function app.payment_allocations_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_doc public.accounting_documents;
  v_proforma public.accounting_documents;
  v_doc_total bigint;
begin
  -- outsider guard: RLS refuses (42501) a person who may not allocate here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- (the currency is held to 'ILS' by its check until DEAL-12; then it joins this list)
    if row(new.organization_id, new.payment_id, new.document_id, new.created_by, new.created_at)
       is distinct from row(old.organization_id, old.payment_id, old.document_id, old.created_by, old.created_at) then
      raise exception 'an allocation stays on its payment and document' using errcode = 'P0001', hint = 'allocation:fixed';
    end if;
    -- the server's release (the release triggers below, one level down; a person has no grant on the column): the time
    -- only, once; it locks nothing (the payment or the document is already held by the statement that released it)
    if new.released_at is distinct from old.released_at then
      if old.released_at is not null or new.released_at is null or pg_trigger_depth() < 2
         or row(new.amount_agorot, new.removed_at, new.removed_by) is distinct from row(old.amount_agorot, old.removed_at, old.removed_by) then
        raise exception 'only the server releases an allocation' using errcode = 'P0001', hint = 'allocation:closed';
      end if;
      return new;
    end if;
    if old.released_at is not null or old.removed_at is not null then
      raise exception 'a released or undone allocation does not change' using errcode = 'P0001', hint = 'allocation:closed';
    end if;
    if auth.uid() is not null and not app.is_admin(new.organization_id) then
      raise exception 'only owners and admins change an allocation' using errcode = 'P0001', hint = 'allocation:admin';
    end if;
    if new.removed_at is not null then
      -- undoing: the time and the person are the server's; the amount stays as it was
      if new.amount_agorot is distinct from old.amount_agorot then
        raise exception 'undo an allocation without changing its amount' using errcode = 'P0001', hint = 'allocation:closed';
      end if;
      new.removed_at := now();
      new.removed_by := auth.uid();
      return new;
    end if;
    new.removed_by := old.removed_by;
    if new.amount_agorot = old.amount_agorot then
      return new;
    end if;
  else
    new.released_at := null;
    new.removed_at := null;
    new.removed_by := null;
    new.created_by := coalesce(auth.uid(), new.created_by);
    if not app.org_has_feature(new.organization_id, 'payments') then
      raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
    end if;
    if not app.org_has_feature(new.organization_id, 'documents') then
      raise exception 'documents are not in the plan' using errcode = 'P0001', hint = 'feature:documents';
    end if;
  end if;

  -- the lock order: the payment, then the document, then a tax invoice's proforma (a cancel locks its own row first: see the header)
  select * into v_payment from public.payments p
   where p.organization_id = new.organization_id and p.id = new.payment_id for update;
  select * into v_doc from public.accounting_documents d
   where d.organization_id = new.organization_id and d.id = new.document_id for update;
  if v_payment.id is null or v_doc.id is null then
    -- the composite foreign keys answer too
    raise exception 'the payment and the document are of this business' using errcode = 'P0001', hint = 'allocation:customer';
  end if;
  if v_doc.doc_type = 'tax_invoice' and v_doc.proforma_id is not null then
    select * into v_proforma from public.accounting_documents d
     where d.organization_id = new.organization_id and d.id = v_doc.proforma_id for update;
  end if;

  -- GAP-12: and a positive opening balance (a debt); a negative one is a credit and takes none
  if v_doc.doc_type not in ('tax_invoice', 'proforma')
     and not (v_doc.doc_type = 'opening_balance' and v_doc.amount_agorot > 0) then
    raise exception 'only a tax invoice, a proforma or an opening debt takes payments' using errcode = 'P0001', hint = 'allocation:doc_type';
  end if;
  if v_payment.status not in ('recorded', 'confirmed') then
    raise exception 'only a recorded or confirmed payment is allocated' using errcode = 'P0001', hint = 'allocation:payment_state';
  end if;
  if v_doc.status <> 'active' then
    raise exception 'a cancelled document takes no payments' using errcode = 'P0001', hint = 'allocation:document_state';
  end if;
  if v_doc.doc_type = 'proforma'
     and exists (select 1 from public.accounting_documents i
                  where i.organization_id = new.organization_id and i.proforma_id = v_doc.id and i.status = 'active') then
    raise exception 'this proforma is billed by a tax invoice; allocate to the invoice' using errcode = 'P0001', hint = 'allocation:transferred';
  end if;
  if tg_op = 'INSERT'
     -- GAP-12: coalesce: money_same_customer answers null (not false) when one side has no deal or no contact, which let a
     -- payment through to a document with no shared record
     and not coalesce(app.money_same_customer(new.organization_id, v_payment.deal_id, v_payment.contact_id, v_doc.deal_id, v_doc.contact_id), false)
     -- GAP-12: a company's opening balance takes the payments of that company's contacts and deals
     and not coalesce(app.money_in_company(new.organization_id, v_payment.deal_id, v_payment.contact_id, v_doc.company_id), false) then
    raise exception 'a payment is allocated to a document of the same customer' using errcode = 'P0001', hint = 'allocation:customer';
  end if;

  if app.allocated_on_payment(new.organization_id, v_payment.id, new.id) + new.amount_agorot > v_payment.amount_agorot then
    raise exception 'more than the payment holds' using errcode = 'P0001', hint = 'allocation:payment_over';
  end if;
  -- GAP-12 credit: the document's opening-credit offsets count too (its own and its proforma's)
  v_doc_total := app.allocated_on_document(new.organization_id, v_doc.id, new.id) + new.amount_agorot
                 + app.credited_on_document(new.organization_id, v_doc.id, null);
  if v_proforma.id is not null and v_proforma.status = 'active' then
    v_doc_total := v_doc_total + app.allocated_on_document(new.organization_id, v_proforma.id, null)
                   + app.credited_on_document(new.organization_id, v_proforma.id, null);
  end if;
  if v_doc_total > v_doc.amount_agorot then
    raise exception 'more than the document holds' using errcode = 'P0001', hint = 'allocation:document_over';
  end if;
  return new;
end;
$$;
revoke all on function app.payment_allocations_check() from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- PAY-02 state: offsets are paid; a negative opening balance's credit left
-- ----------------------------------------------------------------------------
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
    -- GAP-12 credit: a negative opening balance's offsets count as paid on the document they went to
    union all
    select o.document_id, null::uuid, o.amount_agorot from public.opening_credit_allocations o
     where o.organization_id = p_org and o.released_at is null and o.removed_at is null
       and (o.document_id = any (coalesce(p_documents, '{}'))
            or o.document_id in (select d.proforma_id from public.accounting_documents d
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
               'invoice_number', x.invoice_number,
               -- GAP-12 credit: what a negative opening balance still holds
               'credit', app.opening_credit_left(p_org, x.id)) order by x.id)
        from (select docs.*,
                     case when docs.status <> 'active' then 'none'
                          when docs.doc_type = 'tax_invoice_receipt' then 'paid_on_issue'
                          -- GAP-12: a negative opening balance is a credit, like a credit invoice; a positive one is a debt
                          when docs.doc_type = 'opening_balance' and docs.amount_agorot <= 0 then 'none'
                          when docs.doc_type not in ('tax_invoice', 'proforma', 'opening_balance') then 'none'
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
-- BAL-01: the ledger's credit balance adds the opening credit left
-- ----------------------------------------------------------------------------
create or replace function public.customer_ledger(p_org uuid, p_contact uuid, p_company uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_out jsonb;
  v_partial boolean;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'a ledger needs a period' using errcode = '22023', hint = 'ledger:period';
  end if;
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;

  -- partial when the customer has a row the caller does not read (answer 3 ב): compare the full count with what RLS shows
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
    lines as (
      -- each line's own effect only (no balance), by the rule of the full view below; RLS decides which invoice or proforma
      -- the caller reads (an unread proforma is never netted out of an invoice, so its amount is never shown)
      select 'document'::text as kind, d.id, d.doc_date as on_date, d.created_at, d.doc_type as type, d.number as label,
             d.status, case when i.doc_date <= p_to then i.number end as invoice_number, f.number as proforma_number,
             case when d.status <> 'active' then 0
                  when d.doc_type = 'tax_invoice' then greatest(d.amount_agorot - coalesce(f.amount_agorot, 0), 0)
                  when d.doc_type = 'tax_invoice_receipt' then d.amount_agorot
                  -- GAP-12: an opening balance is a debit when positive, a credit when negative
                  when d.doc_type = 'opening_balance' then greatest(d.amount_agorot, 0)
                  -- billed by an invoice of this ledger dated before it: billed from its own date
                  when d.doc_type = 'proforma' then case when i.in_ledger and i.doc_date < d.doc_date then 0 else d.amount_agorot end
                  else 0 end::bigint as debit,
             case when d.status <> 'active' then 0
                  when d.doc_type in ('tax_invoice_receipt', 'credit_invoice') then d.amount_agorot
                  when d.doc_type = 'opening_balance' then greatest(-d.amount_agorot, 0)
                  when d.doc_type = 'tax_invoice' then greatest(coalesce(f.amount_agorot, 0) - d.amount_agorot, 0)
                  else 0 end::bigint as credit,
             d.amount_agorot as amount
        from public.accounting_documents d
        left join lateral (
          select v.number, v.doc_date,
                 (v.contact_id in (select id from same_contacts) or v.deal_id in (select id from same_deals)) is true as in_ledger
            from public.accounting_documents v
           where v.organization_id = p_org and v.proforma_id = d.id and v.status = 'active' and v.doc_type = 'tax_invoice'
             and d.doc_type = 'proforma' and d.status = 'active'
           order by v.doc_date, v.id limit 1) i on true
        left join lateral (
          -- only a proforma that is itself a line of this ledger, dated on or before the invoice
          select v.number, v.amount_agorot from public.accounting_documents v
           where v.organization_id = p_org and v.id = d.proforma_id and v.status = 'active' and v.doc_type = 'proforma'
             and v.doc_date <= d.doc_date
             and (v.contact_id in (select id from same_contacts) or v.deal_id in (select id from same_deals))
             and d.doc_type = 'tax_invoice' and d.status = 'active') f on true
       where d.organization_id = p_org
         and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
             or d.company_id in (select company_id from origin_companies))
      union all
      select 'payment'::text, p.id, p.paid_on, p.created_at, p.method, p.reference, p.status, null::text, null::text,
             0::bigint,
             case when p.status in ('recorded', 'confirmed') then p.amount_agorot else 0 end::bigint,
             p.amount_agorot
        from public.payments p
       where p.organization_id = p_org
         and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals))
    ),
    period as (
      select l.*, row_number() over (order by l.on_date desc, l.created_at desc, l.id desc) as from_end
        from lines l
       where l.on_date between p_from and p_to
    )
    select jsonb_build_object(
      'allowed', true,
      'partial', true,
      'from', p_from,
      'to', p_to,
      'truncated', exists (select 1 from period where from_end > 500),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'kind', s.kind, 'id', s.id, 'date', s.on_date, 'type', s.type, 'label', s.label, 'status', s.status,
                 'invoice_number', s.invoice_number, 'proforma_number', s.proforma_number, 'amount', s.amount, 'debit', s.debit, 'credit', s.credit)
                 order by s.on_date, s.created_at, s.id)
          from period s where s.from_end <= 500), '[]'::jsonb)
    ) into v_out;
    return v_out;
  end if;

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
    select d.id, d.doc_type, d.number, d.doc_date, d.created_at, d.amount_agorot, d.status, d.proforma_id
      from public.accounting_documents d
     where d.organization_id = p_org
       and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
             or d.company_id in (select company_id from origin_companies))
  ),
  doc_state as (
    select (x ->> 'id')::uuid as id, x ->> 'state' as state, x ->> 'invoice_number' as invoice_number,
           coalesce((x ->> 'balance')::bigint, 0) as balance,
           -- GAP-12 credit: a negative opening balance's credit left
           coalesce((x ->> 'credit')::bigint, 0) as credit
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}') from docs), '{}')
                                 -> 'documents') x
  ),
  pays as (
    select p.id, p.method, p.reference, p.paid_on, p.created_at, p.amount_agorot, p.status, public.payment_credit(p) as credit
      from public.payments p
     where p.organization_id = p_org
       and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals))
  ),
  lines as (
    -- a proforma is a debit on its own date; the active tax invoice that bills it takes over from the invoice's date: the
    -- invoice's line carries only the difference (BAL-01, lead's decision of 26 October 2026), so a period that ends before
    -- the invoice shows the debt as it stood then, and a later one the invoice's amount once
    select 'document'::text as kind, d.id, d.doc_date as on_date, d.created_at, d.doc_type as type, d.number as label,
           d.status, case when i.doc_date <= p_to then i.number end as invoice_number, f.number as proforma_number,
           case when d.status <> 'active' then 0
                when d.doc_type = 'tax_invoice' then greatest(d.amount_agorot - coalesce(f.amount_agorot, 0), 0)
                when d.doc_type = 'tax_invoice_receipt' then d.amount_agorot
                -- GAP-12: an opening balance is a debit when positive, a credit when negative
                when d.doc_type = 'opening_balance' then greatest(d.amount_agorot, 0)
                -- billed by an invoice of this ledger dated before it: billed from its own date
                when d.doc_type = 'proforma' then case when i.in_ledger and i.doc_date < d.doc_date then 0 else d.amount_agorot end
                else 0 end::bigint as debit,
           case when d.status <> 'active' then 0
                when d.doc_type in ('tax_invoice_receipt', 'credit_invoice') then d.amount_agorot
                when d.doc_type = 'opening_balance' then greatest(-d.amount_agorot, 0)
                when d.doc_type = 'tax_invoice' then greatest(coalesce(f.amount_agorot, 0) - d.amount_agorot, 0)
                else 0 end::bigint as credit,
           d.amount_agorot as amount
      from docs d
      left join lateral (
        select v.number, v.doc_date, v.id in (select x.id from docs x) as in_ledger
          from public.accounting_documents v
         where v.organization_id = p_org and v.proforma_id = d.id and v.status = 'active' and v.doc_type = 'tax_invoice'
           and d.doc_type = 'proforma' and d.status = 'active'
         order by v.doc_date, v.id limit 1) i on true
      left join lateral (
        -- only a proforma that is itself a line of this ledger, dated on or before the invoice
        select v.number, v.amount_agorot from docs v
         where v.id = d.proforma_id and v.status = 'active' and v.doc_type = 'proforma' and v.doc_date <= d.doc_date
           and d.doc_type = 'tax_invoice' and d.status = 'active') f on true
    union all
    select 'payment'::text, p.id, p.paid_on, p.created_at, p.method, p.reference, p.status, null::text, null::text,
           0::bigint,
           case when p.status in ('recorded', 'confirmed') then p.amount_agorot else 0 end::bigint,
           p.amount_agorot
      from pays p
  ),
  opening as (
    select coalesce(sum(l.debit - l.credit), 0)::bigint as v from lines l where l.on_date < p_from
  ),
  period as (
    select l.*,
           (select v from opening) + sum(l.debit - l.credit) over (order by l.on_date, l.created_at, l.id
                                                               rows between unbounded preceding and current row) as balance,
           row_number() over (order by l.on_date desc, l.created_at desc, l.id desc) as from_end
      from lines l
     where l.on_date between p_from and p_to
  ),
  shown as (
    select * from period where from_end <= 500
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', false,
    'from', p_from,
    'to', p_to,
    'opening', (select v from opening),
    'shown_opening', coalesce((select s.balance - (s.debit - s.credit) from shown s order by s.from_end desc limit 1),
                              (select v from opening)),
    'truncated', exists (select 1 from period where from_end > 500),
    'debit', coalesce((select sum(debit) from period), 0)::bigint,
    'credit', coalesce((select sum(credit) from period), 0)::bigint,
    'closing', (select v from opening) + coalesce((select sum(debit - credit) from period), 0)::bigint,
    'open_debt', coalesce((select sum(s.balance) from doc_state s), 0)::bigint,
    'credit_balance', (coalesce((select sum(p.credit) from pays p), 0) + coalesce((select sum(s.credit) from doc_state s), 0))::bigint,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', s.kind, 'id', s.id, 'date', s.on_date, 'type', s.type, 'label', s.label, 'status', s.status,
               'invoice_number', s.invoice_number, 'proforma_number', s.proforma_number, 'amount', s.amount, 'debit', s.debit, 'credit', s.credit,
               'balance', s.balance) order by s.on_date, s.created_at, s.id)
        from shown s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.customer_ledger(uuid, uuid, uuid, date, date) from public, anon;
grant execute on function public.customer_ledger(uuid, uuid, uuid, date, date) to authenticated;


-- ----------------------------------------------------------------------------
-- PAY-03: the customer's credit adds the opening credits
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
  -- GAP-12 credit: the customer's active negative opening balances (a contact's, its company's, its company's contacts')
  opening as (
    select d.id, d.doc_date, app.opening_credit_left(p_org, d.id) as credit
      from public.accounting_documents d
     where d.organization_id = p_org and d.doc_type = 'opening_balance' and d.status = 'active' and d.amount_agorot < 0
       and (d.contact_id = p_contact
            or d.company_id in (select company_id from origin_companies)
            or d.contact_id in (select c.id from public.contacts c
                                 where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)))
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
    'total', (coalesce((select sum(c.credit) from credits c where c.credit > 0), 0)
              + coalesce((select sum(o.credit) from opening o where o.credit > 0), 0))::bigint,
    'count', (select count(*) from credits c where c.credit > 0),
    'payments', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.paid_on, t.id)
        from (select c.id, c.paid_on, c.method, c.amount, c.credit, c.is_advance, c.advance_quote_id, c.advance_order_id
                from credits c where c.credit > 0 order by c.paid_on, c.id limit 200) t), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.doc_date, t.id)
        from (select o.id, o.doc_date, o.credit from opening o where o.credit > 0 order by o.doc_date, o.id limit 200) t), '[]'::jsonb)
  )
$$;
revoke all on function public.money_customer_credit(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.money_customer_credit(uuid, uuid, uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- PAY-03: applying credit: the payments as before, then the opening credits
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
  v_credit record;
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
  -- GAP-12 credit: then the customer's negative opening balances, oldest first (read with the caller's rights)
  for v_credit in
    select o.id, app.opening_credit_left(p_org, o.id) as credit
      from public.accounting_documents o
      join public.accounting_documents t on t.organization_id = p_org and t.id = p_document
     where o.organization_id = p_org and o.doc_type = 'opening_balance' and o.status = 'active' and o.amount_agorot < 0
       and app.money_same_customer_doc(p_org, o.deal_id, o.contact_id, o.company_id, t.deal_id, t.contact_id, t.company_id)
     order by o.doc_date, o.created_at, o.id
  loop
    exit when v_left <= 0;
    v_take := least(v_credit.credit, v_left);
    continue when v_take <= 0;
    begin
      insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot)
      values (p_org, v_credit.id, p_document, v_take);
      v_total := v_total + v_take;
      v_left := v_left - v_take;
      v_docs := v_docs || jsonb_build_array(jsonb_build_object('document_id', v_credit.id, 'amount', v_take));
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
  end loop;
  return jsonb_build_object('allocated', v_total, 'payments', v_done, 'documents', v_docs);
end;
$$;
revoke all on function public.money_apply_credit(uuid, uuid, bigint) from public, anon;
grant execute on function public.money_apply_credit(uuid, uuid, bigint) to authenticated;


-- ----------------------------------------------------------------------------
-- PAY-03: the credit column's totals add the opening credits
-- ----------------------------------------------------------------------------
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
                                       where x.organization_id = p_org and x.company_id = p_company), 0)
                            -- GAP-12 credit: the company's and its contacts' opening credits
                            + coalesce((select sum(app.opening_credit_left(p_org, d.id)) from public.accounting_documents d
                                         where d.organization_id = p_org and d.doc_type = 'opening_balance' and d.status = 'active'
                                           and d.amount_agorot < 0
                                           and (d.company_id = p_company
                                                or d.contact_id in (select c.id from public.contacts c
                                                                     where c.organization_id = p_org and c.company_id = p_company))), 0))
  on conflict (organization_id, company_id)
    do update set credit_agorot = excluded.credit_agorot where t.credit_agorot is distinct from excluded.credit_agorot;
end;
$$;
revoke all on function app.customer_credit_company_refresh(uuid, uuid) from public, anon, authenticated, service_role;


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
                                         and p.status in ('recorded', 'confirmed')), 0)
                            -- GAP-12 credit: the contact's own opening credits
                            + coalesce((select sum(app.opening_credit_left(p_org, d.id)) from public.accounting_documents d
                                         where d.organization_id = p_org and d.doc_type = 'opening_balance' and d.status = 'active'
                                           and d.amount_agorot < 0 and d.contact_id = p_contact), 0))
  on conflict (organization_id, contact_id)
    do update set credit_agorot = excluded.credit_agorot where t.credit_agorot is distinct from excluded.credit_agorot;
end;
$$;
revoke all on function app.customer_credit_contact_refresh(uuid, uuid) from public, anon, authenticated, service_role;


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
  -- GAP-12 credit: a contact's opening balances move with it from one company's total to the other
  if tg_table_name = 'contacts' then
    perform app.opening_credit_doc_sync(new.organization_id, d.id, null)
       from public.accounting_documents d
      where d.organization_id = new.organization_id and d.contact_id = new.id and d.doc_type = 'opening_balance'
      order by d.id;
  end if;
  return null;
end;
$$;
revoke all on function app.payment_credit_companies_on_customer() from public, anon, authenticated, service_role;


-- The company whose kept total holds each opening balance, as of its last refresh (server only; no grants, RLS without
-- policies like every app table). Needed because a refresh at commit cannot find the company through a contact that a purge
-- or a merge has already deleted: the company it left is read from here instead.
create table if not exists app.opening_credit_companies (
  document_id     uuid primary key,
  organization_id uuid not null,
  company_id      uuid,
  constraint opening_credit_companies_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete cascade
);
create index if not exists opening_credit_companies_document_idx on app.opening_credit_companies (organization_id, document_id);
alter table app.opening_credit_companies enable row level security;
revoke all on app.opening_credit_companies from public, anon, authenticated;

-- one opening balance's customer, under PAY-03's business lock: the company its total sat on before (stored), the company it
-- sits on now (its own, else its contact's), its contact, and the contact it left (a merge)
create or replace function app.opening_credit_doc_sync(p_org uuid, p_document uuid, p_old_contact uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_contact uuid;
  v_now uuid;
  v_before uuid;
  v_company uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || p_org::text, 0));
  select d.contact_id,
         coalesce(d.company_id, (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = d.contact_id))
    into v_contact, v_now
    from public.accounting_documents d
   where d.organization_id = p_org and d.id = p_document and d.doc_type = 'opening_balance';
  if not found then
    return;
  end if;
  select o.company_id into v_before from app.opening_credit_companies o where o.document_id = p_document;
  for v_company in
    select distinct x from unnest(array[v_before, v_now]) x where x is not null order by x
  loop
    perform app.customer_credit_company_refresh(p_org, v_company);
  end loop;
  perform app.customer_credit_contact_refresh(p_org, v_contact);
  if p_old_contact is not null and p_old_contact is distinct from v_contact then
    perform app.customer_credit_contact_refresh(p_org, p_old_contact);
  end if;
  insert into app.opening_credit_companies as o (document_id, organization_id, company_id)
  values (p_document, p_org, v_now)
  on conflict (document_id) do update set company_id = excluded.company_id where o.company_id is distinct from excluded.company_id;
end;
$$;
revoke all on function app.opening_credit_doc_sync(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.opening_credit_on_document() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.doc_type <> 'opening_balance' then
    return null;
  end if;
  perform app.opening_credit_doc_sync(new.organization_id, new.id, case when tg_op = 'UPDATE' then old.contact_id end);
  return null;
end;
$$;
revoke all on function app.opening_credit_on_document() from public, anon, authenticated, service_role;

create or replace function app.opening_credit_on_allocation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.opening_credit_doc_sync(new.organization_id, new.credit_document_id, null);
  return null;
end;
$$;
revoke all on function app.opening_credit_on_allocation() from public, anon, authenticated, service_role;

-- deferred to commit, like PAY-03's (created only when missing: no CREATE OR REPLACE for constraint triggers)
do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.accounting_documents'::regclass
                  and tgname = 'accounting_documents_credit_totals' and not tgisinternal) then
    create constraint trigger accounting_documents_credit_totals
      after insert or update on public.accounting_documents
      deferrable initially deferred
      for each row execute function app.opening_credit_on_document();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.opening_credit_allocations'::regclass
                  and tgname = 'opening_credit_allocations_credit_totals' and not tgisinternal) then
    create constraint trigger opening_credit_allocations_credit_totals
      after insert or update on public.opening_credit_allocations
      deferrable initially deferred
      for each row execute function app.opening_credit_on_allocation();
  end if;
end;
$$;
