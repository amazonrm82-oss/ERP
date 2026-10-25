-- =============================================================================
-- PAY-02: allocating payments to documents (owner, 21 October 2026, DECISIONS.md "שיוך תשלומים למסמכים"; the lead's calls
-- of 25 October 2026: both plan keys, a release is final, a proforma link is set once at any time, no timeline entry)
-- =============================================================================
-- * public.payment_allocations: one row per payment and document share (amount_agorot > 0, currency 'ILS'). Never deleted
--   (no delete grant or policy): an owner or admin undoes one (removed_at / removed_by, once), and the server releases one
--   (released_at) when its payment becomes failed, refunded or cancelled, or its document is cancelled (answers 5 and 6).
--   A release is final: a payment back from failed does not revive it. Only allocations neither released nor removed count.
-- * Who reads: whoever reads the document or the payment. Who allocates: whoever records payments
--   (app.can_record_payments) in a writable business with both the `payments` and `documents` flags. Changing the amount or
--   undoing: owners and admins (answer 4). Audited (app.audit_row); no timeline entry.
-- * Definer trigger app.payment_allocations_check (outsider guard first) holds the rules for every writer:
--     - only a tax invoice or a proforma takes payments (answer 1): allocation:doc_type;
--     - a payment that is recorded or confirmed (allocation:payment_state), a document that is active
--       (allocation:document_state), a proforma not yet billed by an active tax invoice (allocation:transferred);
--     - the same customer (answer 3): the same deal, the same contact, or the same company, where a row's companies are its
--       contact's company and its deal's company (app.money_same_customer): allocation:customer;
--     - never more than the payment (allocation:payment_over) or the document (allocation:document_over; a tax invoice
--       counts its proforma's allocations too) holds;
--     - locks: the payment, then the document, then a tax invoice's proforma, FOR UPDATE. The release paths lock nothing
--       beyond the row their own update holds, but that row comes first there: an owner's or admin's change of an
--       allocation (payment, then document) racing a cancel of the same document or payment (that row, then its
--       allocations) can deadlock; PostgreSQL then rolls one of them back (40P01) and the person tries again.
--   payment_id and document_id never change (allocation:fixed); a released or removed allocation is closed (allocation:closed).
-- * A proforma and its tax invoice (answer 2): accounting_documents.proforma_id on a tax invoice (composite FK, no action:
--   documents are never deleted), set once, at insert or later, by whoever records documents, to an active proforma of the
--   same customer that no other ACTIVE invoice bills (definer trigger app.accounting_documents_proforma, hint document:proforma;
--   unique index over active invoices). While its invoice is active the proforma is no debt and its allocations count toward
--   the invoice; a cancelled invoice keeps its proforma_id, the proforma is debt again and a replacement invoice may bill it.
--   An invoice smaller than what its proforma was already paid shows as paid; the excess stays allocated (not shown as
--   credit) until an owner or admin changes or undoes an allocation.
-- * public.money_allocation_state(org, documents, payments) (invoker: RLS decides) answers each document's paid amount,
--   balance and state, and each payment's allocated amount and credit balance (PAY-03): one rule for every screen.
-- * A correction of a payment's amount below what it has allocated is refused (payment:allocated).
-- * accounting_documents_check and payments_check are unchanged: no column of theirs is written here (the counts are read,
--   never stored), and proforma_id is outside their frozen lists.
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- The proforma link on a tax invoice
-- ----------------------------------------------------------------------------
alter table public.accounting_documents add column if not exists proforma_id uuid;
alter table public.accounting_documents drop constraint if exists accounting_documents_proforma_fk;
alter table public.accounting_documents add constraint accounting_documents_proforma_fk foreign key (organization_id, proforma_id)
  references public.accounting_documents (organization_id, id);
-- the FK's index, and one ACTIVE invoice per proforma (a cancelled invoice keeps its link and frees the proforma)
create index if not exists accounting_documents_proforma_idx on public.accounting_documents (organization_id, proforma_id);
create unique index if not exists accounting_documents_proforma_active_once on public.accounting_documents (organization_id, proforma_id)
  where proforma_id is not null and status = 'active';
grant insert (proforma_id), update (proforma_id) on public.accounting_documents to authenticated;

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.payment_allocations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  payment_id       uuid not null,
  document_id      uuid not null,
  amount_agorot    bigint not null check (amount_agorot between 1 and 1000000000000),
  currency         text not null default 'ILS' check (currency = 'ILS'),
  released_at      timestamptz,
  removed_at       timestamptz,
  removed_by       uuid references auth.users (id) on delete set null,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint payment_allocations_payment_fk foreign key (organization_id, payment_id)
    references public.payments (organization_id, id),
  constraint payment_allocations_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id)
);

create index if not exists payment_allocations_payment_idx on public.payment_allocations (organization_id, payment_id);
create index if not exists payment_allocations_document_idx on public.payment_allocations (organization_id, document_id);

alter table public.payment_allocations enable row level security;

revoke all on public.payment_allocations from anon, authenticated;
grant select on public.payment_allocations to authenticated;
grant insert (organization_id, payment_id, document_id, amount_agorot, currency) on public.payment_allocations to authenticated;
-- owners and admins change the amount or undo (the trigger stamps the time and the person)
grant update (amount_agorot, removed_at) on public.payment_allocations to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_allocations' and policyname = 'payment_allocations_select') then
    create policy payment_allocations_select on public.payment_allocations for select to authenticated
      using (exists (select 1 from public.accounting_documents d
                      where d.organization_id = payment_allocations.organization_id and d.id = payment_allocations.document_id)
             or exists (select 1 from public.payments p
                         where p.organization_id = payment_allocations.organization_id and p.id = payment_allocations.payment_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_allocations' and policyname = 'payment_allocations_insert') then
    create policy payment_allocations_insert on public.payment_allocations for insert to authenticated
      with check (app.can_record_payments(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'payments') and app.org_has_feature(organization_id, 'documents')
                  and exists (select 1 from public.payments p
                               where p.organization_id = payment_allocations.organization_id and p.id = payment_allocations.payment_id)
                  and exists (select 1 from public.accounting_documents d
                               where d.organization_id = payment_allocations.organization_id and d.id = payment_allocations.document_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_allocations' and policyname = 'payment_allocations_update') then
    create policy payment_allocations_update on public.payment_allocations for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id)
             and (exists (select 1 from public.accounting_documents d
                           where d.organization_id = payment_allocations.organization_id and d.id = payment_allocations.document_id)
                  or exists (select 1 from public.payments p
                              where p.organization_id = payment_allocations.organization_id and p.id = payment_allocations.payment_id)))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  -- no delete policy and no delete grant: an allocation is undone (removed_at), never deleted
end;
$$;

-- ----------------------------------------------------------------------------
-- The same customer (answer 3): the same deal, the same contact, or the same company (a row's contact's company or its
-- deal's company). Ids only; no grants.
-- ----------------------------------------------------------------------------
create or replace function app.money_same_customer(p_org uuid, p_deal_a uuid, p_contact_a uuid, p_deal_b uuid, p_contact_b uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (p_deal_a is not null and p_deal_a = p_deal_b)
      or (p_contact_a is not null and p_contact_a = p_contact_b)
      or exists (
           select 1
             from (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = p_contact_a
                   union all
                   select d.company_id from public.deals d where d.organization_id = p_org and d.id = p_deal_a) a
             join (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = p_contact_b
                   union all
                   select d.company_id from public.deals d where d.organization_id = p_org and d.id = p_deal_b) b
               on a.company_id = b.company_id
         )
$$;
revoke all on function app.money_same_customer(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- the counted allocations of a payment, or of a document, leaving one allocation out (an update re-checks its own row)
create or replace function app.allocated_on_payment(p_org uuid, p_payment uuid, p_skip uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(a.amount_agorot), 0)::bigint from public.payment_allocations a
   where a.organization_id = p_org and a.payment_id = p_payment and a.released_at is null and a.removed_at is null
     and a.id is distinct from p_skip
$$;
revoke all on function app.allocated_on_payment(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.allocated_on_document(p_org uuid, p_document uuid, p_skip uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(a.amount_agorot), 0)::bigint from public.payment_allocations a
   where a.organization_id = p_org and a.document_id = p_document and a.released_at is null and a.removed_at is null
     and a.id is distinct from p_skip
$$;
revoke all on function app.allocated_on_document(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rules of an allocation (every writer)
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

  if v_doc.doc_type not in ('tax_invoice', 'proforma') then
    raise exception 'only a tax invoice or a proforma takes payments' using errcode = 'P0001', hint = 'allocation:doc_type';
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
     and not app.money_same_customer(new.organization_id, v_payment.deal_id, v_payment.contact_id, v_doc.deal_id, v_doc.contact_id) then
    raise exception 'a payment is allocated to a document of the same customer' using errcode = 'P0001', hint = 'allocation:customer';
  end if;

  if app.allocated_on_payment(new.organization_id, v_payment.id, new.id) + new.amount_agorot > v_payment.amount_agorot then
    raise exception 'more than the payment holds' using errcode = 'P0001', hint = 'allocation:payment_over';
  end if;
  v_doc_total := app.allocated_on_document(new.organization_id, v_doc.id, new.id) + new.amount_agorot;
  if v_proforma.id is not null and v_proforma.status = 'active' then
    v_doc_total := v_doc_total + app.allocated_on_document(new.organization_id, v_proforma.id, null);
  end if;
  if v_doc_total > v_doc.amount_agorot then
    raise exception 'more than the document holds' using errcode = 'P0001', hint = 'allocation:document_over';
  end if;
  return new;
end;
$$;
revoke all on function app.payment_allocations_check() from public, anon, authenticated, service_role;

create or replace trigger payment_allocations_check before insert or update on public.payment_allocations
  for each row execute function app.payment_allocations_check();
create or replace trigger payment_allocations_touch before insert or update on public.payment_allocations
  for each row execute function app.touch_row();
create or replace trigger payment_allocations_audit after insert or update or delete on public.payment_allocations
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- Releases (answers 5 and 6): final, stamped by the server
-- ----------------------------------------------------------------------------
create or replace function app.payments_release_allocations() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  if new.status in ('failed', 'refunded', 'cancelled') and old.status in ('recorded', 'confirmed') then
    update public.payment_allocations a set released_at = now()
     where a.organization_id = new.organization_id and a.payment_id = new.id and a.released_at is null and a.removed_at is null;
  end if;
  return null;
end;
$$;
revoke all on function app.payments_release_allocations() from public, anon, authenticated, service_role;

-- a plain "after update": a status derived by a BEFORE trigger (PAY-04's cheque status) is not in the statement's column
-- list, so "update of status" would miss it; the function returns at once when the status did not change
create or replace trigger payments_release_allocations after update on public.payments
  for each row execute function app.payments_release_allocations();

create or replace function app.accounting_documents_release_allocations() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update public.payment_allocations a set released_at = now()
     where a.organization_id = new.organization_id and a.document_id = new.id and a.released_at is null and a.removed_at is null;
  end if;
  return null;
end;
$$;
revoke all on function app.accounting_documents_release_allocations() from public, anon, authenticated, service_role;

create or replace trigger accounting_documents_release_allocations after update on public.accounting_documents
  for each row execute function app.accounting_documents_release_allocations();

-- A correction never leaves a payment holding less than it has allocated (owners and admins correct; payments_check
-- refuses everyone else first, so the guard below needs no outsider check of its own beyond it)
create or replace function app.payments_allocated_amount() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if new.amount_agorot < old.amount_agorot
     and new.amount_agorot < app.allocated_on_payment(new.organization_id, new.id, null) then
    raise exception 'the payment has more allocated than the new amount' using errcode = 'P0001', hint = 'payment:allocated';
  end if;
  return new;
end;
$$;
revoke all on function app.payments_allocated_amount() from public, anon, authenticated, service_role;

-- after payments_check by name (a person who may not correct is refused there first)
create or replace trigger payments_zz_allocated_amount before update of amount_agorot on public.payments
  for each row execute function app.payments_allocated_amount();

-- ----------------------------------------------------------------------------
-- The proforma link (answer 2): a tax invoice names the active proforma of the same customer it bills, once
-- ----------------------------------------------------------------------------
create or replace function app.accounting_documents_proforma() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_proforma public.accounting_documents;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record documents here
  if auth.uid() is not null and not (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if new.proforma_id is not distinct from (case when tg_op = 'UPDATE' then old.proforma_id end) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.proforma_id is not null then
    raise exception 'a tax invoice keeps the proforma it bills' using errcode = 'P0001', hint = 'document:proforma';
  end if;
  if new.doc_type <> 'tax_invoice' or new.status <> 'active' then
    raise exception 'an active tax invoice bills a proforma' using errcode = 'P0001', hint = 'document:proforma';
  end if;
  -- the proforma is locked (an allocation locks a tax invoice before its proforma: the same order here, the invoice row
  -- being held by this statement)
  select * into v_proforma from public.accounting_documents d
   where d.organization_id = new.organization_id and d.id = new.proforma_id for update;
  if v_proforma.id is null or v_proforma.doc_type <> 'proforma' or v_proforma.status <> 'active'
     or not app.money_same_customer(new.organization_id, new.deal_id, new.contact_id, v_proforma.deal_id, v_proforma.contact_id)
     or exists (select 1 from public.accounting_documents i
                 where i.organization_id = new.organization_id and i.proforma_id = v_proforma.id and i.id <> new.id
                   and i.status = 'active') then
    raise exception 'pick an active proforma of the same customer that no other invoice bills' using errcode = 'P0001', hint = 'document:proforma';
  end if;
  return new;
end;
$$;
revoke all on function app.accounting_documents_proforma() from public, anon, authenticated, service_role;

create or replace trigger accounting_documents_proforma before insert or update of proforma_id on public.accounting_documents
  for each row execute function app.accounting_documents_proforma();

-- ----------------------------------------------------------------------------
-- The state the screens show (invoker: RLS decides what is read)
-- ----------------------------------------------------------------------------
-- documents: [{id, paid, balance, state, invoice_number}] with state one of unpaid | partial | paid | transferred |
-- paid_on_issue | none (a receipt or a credit invoice; a cancelled document); payments: [{id, allocated, credit}]
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
               'credit', case when p.status in ('recorded', 'confirmed')
                              then greatest(p.amount_agorot - coalesce((select sum(c.amount_agorot) from counted c where c.payment_id = p.id), 0), 0)
                              else 0 end) order by p.id)
        from public.payments p
       where p.organization_id = p_org and p.id = any (coalesce(p_payments, '{}'))), '[]'::jsonb)
  )
$$;
revoke all on function public.money_allocation_state(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.money_allocation_state(uuid, uuid[], uuid[]) to authenticated;

-- What the allocation window offers (invoker: RLS decides what is read). For a payment: the active tax invoices and
-- proformas of the same customer with a balance (a proforma billed by an active invoice is left out). For a document: the
-- payments of the same customer, recorded or confirmed, with credit; and for an active tax invoice that bills no proforma
-- yet, the active proformas of the same customer that no active invoice bills. "The same customer" is the rule of
-- app.money_same_customer (keep the two in step; test 229 holds them together). At most 100 of each.
create or replace function public.money_allocation_candidates(p_org uuid, p_payment uuid, p_document uuid)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with origin as (
    select p.deal_id, p.contact_id from public.payments p where p.organization_id = p_org and p.id = p_payment
    union all
    select d.deal_id, d.contact_id from public.accounting_documents d where d.organization_id = p_org and d.id = p_document
  ),
  origin_companies as (
    select c.company_id from origin o join public.contacts c on c.organization_id = p_org and c.id = o.contact_id where c.company_id is not null
    union
    select d.company_id from origin o join public.deals d on d.organization_id = p_org and d.id = o.deal_id where d.company_id is not null
  ),
  same_deals as (
    select o.deal_id as id from origin o where o.deal_id is not null
    union
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  ),
  same_contacts as (
    select o.contact_id as id from origin o where o.contact_id is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  open_docs as (
    select d.id, d.doc_type, d.number, d.doc_date, d.amount_agorot, d.proforma_id
      from public.accounting_documents d
     where d.organization_id = p_org and d.status = 'active' and d.doc_type in ('tax_invoice', 'proforma')
       and (d.deal_id in (select id from same_deals) or d.contact_id in (select id from same_contacts))
       and not (d.doc_type = 'proforma'
                and exists (select 1 from public.accounting_documents i
                             where i.organization_id = p_org and i.proforma_id = d.id and i.status = 'active'))
  ),
  doc_state as (
    select (public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}') from open_docs), '{}') -> 'documents') as s
  ),
  open_payments as (
    select p.id, p.paid_on, p.method, p.amount_agorot
      from public.payments p
     where p.organization_id = p_org and p.status in ('recorded', 'confirmed')
       and (p.deal_id in (select id from same_deals) or p.contact_id in (select id from same_contacts))
  ),
  pay_state as (
    select (public.money_allocation_state(p_org, '{}', (select coalesce(array_agg(id), '{}') from open_payments)) -> 'payments') as s
  )
  select jsonb_build_object(
    'documents', case when p_payment is null then '[]'::jsonb else coalesce((
      select jsonb_agg(to_jsonb(t) order by t.doc_date, t.number)
        from (select d.id, d.doc_type, d.number, d.doc_date, d.amount_agorot as amount, (x ->> 'balance')::bigint as balance
                from open_docs d
                join lateral jsonb_array_elements((select s from doc_state)) x on (x ->> 'id')::uuid = d.id
               where (x ->> 'balance')::bigint > 0
               order by d.doc_date, d.number
               limit 100) t), '[]'::jsonb) end,
    'payments', case when p_document is null then '[]'::jsonb else coalesce((
      select jsonb_agg(to_jsonb(t) order by t.paid_on, t.id)
        from (select p.id, p.paid_on, p.method, p.amount_agorot as amount, (x ->> 'credit')::bigint as credit
                from open_payments p
                join lateral jsonb_array_elements((select s from pay_state)) x on (x ->> 'id')::uuid = p.id
               where (x ->> 'credit')::bigint > 0
               order by p.paid_on, p.id
               limit 100) t), '[]'::jsonb) end,
    'proformas', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.doc_date, t.number)
        from (select d.id, d.number, d.doc_date, d.amount_agorot as amount
                from open_docs d
               where d.doc_type = 'proforma'
                 and exists (select 1 from public.accounting_documents v
                              where v.organization_id = p_org and v.id = p_document and v.doc_type = 'tax_invoice'
                                and v.status = 'active' and v.proforma_id is null)
                 and not exists (select 1 from public.accounting_documents i
                                  where i.organization_id = p_org and i.proforma_id = d.id and i.status = 'active')
               order by d.doc_date, d.number
               limit 100) t), '[]'::jsonb)
  )
$$;
revoke all on function public.money_allocation_candidates(uuid, uuid, uuid) from public, anon;
grant execute on function public.money_allocation_candidates(uuid, uuid, uuid) to authenticated;
