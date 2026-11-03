-- =============================================================================
-- PAY-08: refunds (owner's answer (71) ב, 3 November 2026; part of the plan key `payments`, no new key)
-- =============================================================================
-- * public.payment_refunds: a refund is its own record, linked to the payment it returns money from: amount in agorot
--   (1..1e12, ILS), the day it was refunded (not before the payment's day), the method it went back by (the payments'
--   closed list), reference (up to 100) and note (up to 1,000), and optionally an existing recorded credit invoice of the
--   same customer (DOC-14, the provider's credit document, waits for the provider; until then a recorded credit_invoice
--   may be named, nothing more). Partial refunds are allowed; the active refunds of a payment never sum to more than its
--   amount (the payment is locked FOR UPDATE, as PAY-02's allocations do). The original payment row's facts never change.
-- * Who: owners and admins (a refund is a correction, PAY-06's payment:correction rule), of a writable business with the
--   `payments` key, on a payment they read that is recorded or confirmed. Reading follows the payment. A refund is never
--   deleted (no delete grant or policy): it is cancelled with a reason (1..500), then frozen. Every insert and change is
--   audited.
-- * The counted amount of a payment is its amount less its active refunds: public.payment_refunded(payments) (the sum) and
--   public.payment_counted(payments) (0 unless recorded or confirmed), invoker SQL with no SET clause (the advisor's
--   function_search_path_mutable on them is expected, as on payment_credit), for the app and the triggers. A function with a
--   subquery is never inlined, and a SQL function called from another SQL function is planned again on every call, so every
--   set-based reader writes the same subquery out (the active refunds of the row's payment, keep in step): payment_credit
--   and money_allocation_state (PAY-03, keep in step), the allocation
--   cap in app.payment_allocations_check, customer_ledger's payment lines, app.order_money_facts' free amount (ORD-02/04),
--   report_collection (COL-06), report_goal_progress (GOL-01 collection), statement_public and statement_staff_view
--   (BAL-04, keep in step; both leave out a payment whose counted amount is 0). A refund reduces the payment where it
--   is counted (its own day), never a later month.
-- * A refund that brings the active refunds to the full amount sets the payment's status to 'refunded' (הוחזר = refunded
--   in full) through the server path (app.payment_server = 'refund'); every status reader, PAY-02's release of all its
--   allocations, DOC-04's 'תשלום הוחזר' entry, PAY-03's credit, CON-11's purchase facts and AUT-06 follow that status as they
--   already do. Cancelling a refund that leaves less than the full amount puts the status back (a cheque payment's status
--   from its cheque, else the status the payment had when the full refund was made); released allocations stay released.
-- * A partial refund releases the payment's counted allocations above what remains, newest first (whole allocations, like a
--   cancel), and writes a DOC-04 timeline entry without an amount (kind payment_refunded, metadata partial).
-- * While a payment has an active refund: its status moves only between recorded and confirmed (a cancel, a failure, a
--   bounced cheque or a direct 'refunded' are refused, hint payment:has_refunds: cancel the refunds first), and a
--   correction never takes its amount down to its refunds or below (payment:refunded_amount) or below refunds +
--   allocations (payment:allocated); a payment refunded in full by its refunds takes no amount change (payment:has_refunds).
--   A legacy 'refunded' status set by hand (no refund record) keeps its old meaning.
-- * Merge: a refund follows its payment, which a merge moves; nothing to add. Sample data and import undo: the payment is
--   already work. Privacy erasure: when app.audit_erase_core empties a payment (app.payment_server = 'erase'), its refunds'
--   reference and note are emptied, a cancel reason becomes the neutral text, their audit entries are erased, and the
--   reason leaves their timeline entries (trigger payments_zz_refunds_erase; app.audit_erase_core unchanged).
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.payment_refunds (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  payment_id            uuid not null,
  amount_agorot         bigint not null check (amount_agorot between 1 and 1000000000000),
  currency              text not null default 'ILS' check (currency = 'ILS'),
  refunded_on           date not null default current_date,
  method                text not null check (method in ('credit', 'transfer', 'cash', 'cheque', 'bit_paybox', 'standing_order', 'other')),
  reference             text check (reference is null or (char_length(reference) between 1 and 100 and reference = btrim(reference))),
  note                  text check (note is null or (char_length(note) between 1 and 1000 and note = btrim(note))),
  credit_document_id    uuid,
  status                text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason         text check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500),
  cancelled_at          timestamptz,
  cancelled_by          uuid references auth.users (id) on delete set null,
  -- server only: the payment's status when this refund was recorded (to put back when cancelling a full refund)
  payment_status_before text check (payment_status_before is null or payment_status_before in ('recorded', 'confirmed')),
  created_by            uuid references auth.users (id) on delete set null,
  updated_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, id),
  constraint payment_refunds_payment_fk foreign key (organization_id, payment_id)
    references public.payments (organization_id, id) on delete cascade,
  constraint payment_refunds_document_fk foreign key (organization_id, credit_document_id)
    references public.accounting_documents (organization_id, id) on delete set null (credit_document_id),
  constraint payment_refunds_cancel_shape check (
    (status = 'active' and cancel_reason is null and cancelled_at is null)
    or (status = 'cancelled' and cancel_reason is not null and cancelled_at is not null))
);

create index if not exists payment_refunds_payment_idx on public.payment_refunds (organization_id, payment_id);
create index if not exists payment_refunds_document_idx on public.payment_refunds (organization_id, credit_document_id);

alter table public.payment_refunds enable row level security;

revoke all on public.payment_refunds from anon, authenticated;
grant select on public.payment_refunds to authenticated;
grant insert (organization_id, payment_id, amount_agorot, currency, refunded_on, method, reference, note, credit_document_id)
  on public.payment_refunds to authenticated;
grant update (status, cancel_reason) on public.payment_refunds to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_refunds' and policyname = 'payment_refunds_select') then
    create policy payment_refunds_select on public.payment_refunds for select to authenticated
      using (exists (select 1 from public.payments p
                      where p.organization_id = payment_refunds.organization_id and p.id = payment_refunds.payment_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_refunds' and policyname = 'payment_refunds_insert') then
    create policy payment_refunds_insert on public.payment_refunds for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'payments')
                  and exists (select 1 from public.payments p
                               where p.organization_id = payment_refunds.organization_id and p.id = payment_refunds.payment_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_refunds' and policyname = 'payment_refunds_update') then
    create policy payment_refunds_update on public.payment_refunds for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id)
             and exists (select 1 from public.payments p
                          where p.organization_id = payment_refunds.organization_id and p.id = payment_refunds.payment_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  -- no delete policy and no delete grant: a refund is cancelled, never deleted
end;
$$;

-- ----------------------------------------------------------------------------
-- The counted amount of a payment (inlined: no SET clause)
-- ----------------------------------------------------------------------------
create or replace function public.payment_refunded(public.payments) returns bigint
language sql stable
as $$
  select coalesce((select sum(r.amount_agorot) from public.payment_refunds r
                    where r.organization_id = ($1).organization_id and r.payment_id = ($1).id and r.status = 'active'), 0)::bigint
$$;
revoke all on function public.payment_refunded(public.payments) from public, anon;
grant execute on function public.payment_refunded(public.payments) to authenticated, service_role;

create or replace function public.payment_counted(public.payments) returns bigint
language sql stable
as $$
  select case when ($1).status in ('recorded', 'confirmed')
              then greatest(($1).amount_agorot
                            - coalesce((select sum(r.amount_agorot) from public.payment_refunds r
                                         where r.organization_id = ($1).organization_id and r.payment_id = ($1).id
                                           and r.status = 'active'), 0), 0)
              else 0 end::bigint
$$;
revoke all on function public.payment_counted(public.payments) from public, anon;
grant execute on function public.payment_counted(public.payments) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rules of a refund (every writer)
-- ----------------------------------------------------------------------------
create or replace function app.payment_refunds_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_doc public.accounting_documents;
  v_refunded bigint;
begin
  -- outsider guard: RLS refuses (42501) a person who may not refund here, before anything is revealed
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- the currency is held to 'ILS' by its check until DEAL-12 (as payment_allocations): a change of it is the check's to refuse
    if new.currency is distinct from old.currency then
      return new;
    end if;
    -- the FK's own set-null of the credit document (a nested trigger): only that passes
    if pg_trigger_depth() > 1 and new.credit_document_id is null
       and row(new.organization_id, new.payment_id, new.amount_agorot, new.currency, new.refunded_on, new.method, new.reference,
               new.note, new.status, new.cancel_reason, new.cancelled_at, new.cancelled_by, new.payment_status_before,
               new.created_by, new.created_at)
           is not distinct from
           row(old.organization_id, old.payment_id, old.amount_agorot, old.currency, old.refunded_on, old.method, old.reference,
               old.note, old.status, old.cancel_reason, old.cancelled_at, old.cancelled_by, old.payment_status_before,
               old.created_by, old.created_at) then
      return new;
    end if;
    -- a privacy erasure (payments_zz_refunds_erase sets app.payment_server = 'erase'): reference and note emptied, a cancel
    -- reason replaced by the neutral text; nothing else
    if current_setting('app.payment_server', true) = 'erase'
       and new.reference is null and new.note is null
       and (new.cancel_reason is not distinct from old.cancel_reason
            or (old.status = 'cancelled' and new.cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'))
       and row(new.organization_id, new.payment_id, new.amount_agorot, new.currency, new.refunded_on, new.method,
               new.credit_document_id, new.status, new.cancelled_at, new.cancelled_by, new.payment_status_before,
               new.created_by, new.created_at)
           is not distinct from
           row(old.organization_id, old.payment_id, old.amount_agorot, old.currency, old.refunded_on, old.method,
               old.credit_document_id, old.status, old.cancelled_at, old.cancelled_by, old.payment_status_before,
               old.created_by, old.created_at) then
      return new;
    end if;
    if old.status = 'cancelled' then
      raise exception 'a cancelled refund stays cancelled' using errcode = 'P0001', hint = 'refund:cancelled';
    end if;
    if row(new.organization_id, new.payment_id, new.amount_agorot, new.currency, new.refunded_on, new.method, new.reference,
           new.note, new.credit_document_id, new.payment_status_before, new.created_by, new.created_at)
       is distinct from
       row(old.organization_id, old.payment_id, old.amount_agorot, old.currency, old.refunded_on, old.method, old.reference,
           old.note, old.credit_document_id, old.payment_status_before, old.created_by, old.created_at)
       or new.status <> 'cancelled' then
      raise exception 'a refund is cancelled, never changed' using errcode = 'P0001', hint = 'refund:frozen';
    end if;
    new.cancel_reason := nullif(btrim(coalesce(new.cancel_reason, '')), '');
    if new.cancel_reason is null or char_length(new.cancel_reason) > 500 then
      raise exception 'cancelling a refund needs a reason' using errcode = 'P0001', hint = 'refund:cancel_reason';
    end if;
    -- the payment first (the lock order of an insert)
    perform 1 from public.payments p where p.organization_id = new.organization_id and p.id = new.payment_id for update;
    new.cancelled_at := now();
    new.cancelled_by := auth.uid();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
    return new;
  end if;

  -- INSERT
  new.reference := nullif(btrim(coalesce(new.reference, '')), '');
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  new.status := 'active';
  new.cancel_reason := null;
  new.cancelled_at := null;
  new.cancelled_by := null;
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.updated_by := new.created_by;
  if not app.org_has_feature(new.organization_id, 'payments') then
    raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
  end if;
  select * into v_payment from public.payments p
   where p.organization_id = new.organization_id and p.id = new.payment_id for update;
  if v_payment.id is null then
    raise exception 'the payment is of this business' using errcode = 'P0001', hint = 'refund:payment_state';
  end if;
  if v_payment.status not in ('recorded', 'confirmed') then
    raise exception 'only a recorded or confirmed payment is refunded' using errcode = 'P0001', hint = 'refund:payment_state';
  end if;
  if new.refunded_on < v_payment.paid_on then
    raise exception 'a refund is not dated before its payment' using errcode = 'P0001', hint = 'refund:date';
  end if;
  select coalesce(sum(r.amount_agorot), 0) into v_refunded from public.payment_refunds r
   where r.organization_id = new.organization_id and r.payment_id = new.payment_id and r.status = 'active';
  if v_refunded + new.amount_agorot > v_payment.amount_agorot then
    raise exception 'more than the payment holds' using errcode = 'P0001', hint = 'refund:over';
  end if;
  if new.credit_document_id is not null then
    select * into v_doc from public.accounting_documents d
     where d.organization_id = new.organization_id and d.id = new.credit_document_id;
    if v_doc.id is null or v_doc.doc_type <> 'credit_invoice' or v_doc.status <> 'active'
       or not coalesce(app.money_same_customer(new.organization_id, v_payment.deal_id, v_payment.contact_id,
                                               v_doc.deal_id, v_doc.contact_id), false) then
      raise exception 'only an active credit invoice of the same customer' using errcode = 'P0001', hint = 'refund:credit_document';
    end if;
  end if;
  new.payment_status_before := v_payment.status;
  return new;
end;
$$;
revoke all on function app.payment_refunds_check() from public, anon, authenticated;

create or replace trigger payment_refunds_check before insert or update on public.payment_refunds
  for each row execute function app.payment_refunds_check();
create or replace trigger payment_refunds_touch before insert or update on public.payment_refunds
  for each row execute function app.touch_row();
create or replace trigger payment_refunds_audit after insert or update or delete on public.payment_refunds
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- What a refund does to its payment: the status in full, the allocations above what remains, the timeline
-- ----------------------------------------------------------------------------
create or replace function app.payment_refunds_apply() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_refunded bigint;
  v_allocated bigint;
  v_alloc record;
  v_server text;
  v_back text;
begin
  if tg_op = 'UPDATE' and (new.status is not distinct from old.status or new.status <> 'cancelled') then
    return null;
  end if;
  select * into v_payment from public.payments p where p.organization_id = new.organization_id and p.id = new.payment_id;
  if v_payment.id is null then
    return null;
  end if;
  select coalesce(sum(r.amount_agorot), 0) into v_refunded from public.payment_refunds r
   where r.organization_id = new.organization_id and r.payment_id = new.payment_id and r.status = 'active';
  v_server := current_setting('app.payment_server', true);

  if tg_op = 'INSERT' then
    if v_refunded >= v_payment.amount_agorot then
      -- refunded in full: the payment's status (PAY-02 releases all its allocations, DOC-04 writes the entry)
      perform set_config('app.payment_server', 'refund', true);
      update public.payments p set status = 'refunded'
       where p.organization_id = new.organization_id and p.id = new.payment_id and p.status in ('recorded', 'confirmed');
      perform set_config('app.payment_server', coalesce(v_server, ''), true);
      return null;
    end if;
    -- partly: release the counted allocations above what remains, newest first (whole allocations, like a cancel)
    select coalesce(sum(a.amount_agorot), 0) into v_allocated from public.payment_allocations a
     where a.organization_id = new.organization_id and a.payment_id = new.payment_id
       and a.released_at is null and a.removed_at is null;
    for v_alloc in
      select a.id, a.amount_agorot from public.payment_allocations a
       where a.organization_id = new.organization_id and a.payment_id = new.payment_id
         and a.released_at is null and a.removed_at is null
       order by a.created_at desc, a.id desc
    loop
      exit when v_allocated <= v_payment.amount_agorot - v_refunded;
      update public.payment_allocations a set released_at = now()
       where a.organization_id = new.organization_id and a.id = v_alloc.id;
      v_allocated := v_allocated - v_alloc.amount_agorot;
    end loop;
    if v_payment.deal_id is not null or v_payment.contact_id is not null then
      insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
      values (new.organization_id, 'system', v_payment.deal_id, v_payment.contact_id,
              'הוחזר חלק מתשלום · ' || app.payment_method_label(v_payment.method),
              jsonb_build_object('kind', 'payment_refunded', 'payment_id', v_payment.id, 'refund_id', new.id,
                                 'method', v_payment.method, 'partial', true));
    end if;
    return null;
  end if;

  -- cancelled: a payment refunded in full by its refunds gets its status back once they no longer cover it
  if v_payment.status = 'refunded' and v_refunded < v_payment.amount_agorot then
    v_back := case when v_payment.method = 'cheque' and v_payment.cheque_status is not null
                   then app.cheque_payment_status(v_payment.cheque_status)
                   else coalesce((select r.payment_status_before from public.payment_refunds r
                                   where r.organization_id = new.organization_id and r.payment_id = new.payment_id
                                   order by r.created_at desc, r.id desc limit 1), 'recorded') end;
    perform set_config('app.payment_server', 'refund', true);
    update public.payments p set status = v_back
     where p.organization_id = new.organization_id and p.id = new.payment_id;
    perform set_config('app.payment_server', coalesce(v_server, ''), true);
  end if;
  if v_payment.deal_id is not null or v_payment.contact_id is not null then
    insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
    values (new.organization_id, 'system', v_payment.deal_id, v_payment.contact_id,
            'בוטל החזר לתשלום · ' || app.payment_method_label(v_payment.method) || coalesce(' · סיבה: ' || new.cancel_reason, ''),
            jsonb_build_object('kind', 'payment_refunded', 'payment_id', v_payment.id, 'refund_id', new.id,
                               'method', v_payment.method, 'refund_cancelled', true));
  end if;
  return null;
end;
$$;
revoke all on function app.payment_refunds_apply() from public, anon, authenticated, service_role;

create or replace trigger payment_refunds_apply after insert or update of status on public.payment_refunds
  for each row execute function app.payment_refunds_apply();

-- PAY-03: the payment's credit changed; its kept totals again at commit, under the business's lock (as payments do)
create or replace function app.payment_refunds_credit_sync() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || new.organization_id::text, 0));
  perform app.payment_credit_companies_sync(new.organization_id, new.payment_id);
  return null;
end;
$$;
revoke all on function app.payment_refunds_credit_sync() from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.payment_refunds'::regclass
                  and tgname = 'payment_refunds_credit_companies' and not tgisinternal) then
    create constraint trigger payment_refunds_credit_companies
      after insert or update on public.payment_refunds
      deferrable initially deferred
      for each row execute function app.payment_refunds_credit_sync();
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The payment while it has active refunds
-- ----------------------------------------------------------------------------
create or replace function app.payments_refund_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_refunded bigint;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record payments here
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if coalesce(current_setting('app.payment_server', true), '') = 'refund' then
    return new;
  end if;
  select coalesce(sum(r.amount_agorot), 0) into v_refunded from public.payment_refunds r
   where r.organization_id = new.organization_id and r.payment_id = new.id and r.status = 'active';
  if v_refunded = 0 then
    return new;
  end if;
  if new.status is distinct from old.status
     and not (new.status in ('recorded', 'confirmed') and old.status in ('recorded', 'confirmed')) then
    raise exception 'the payment has refunds; cancel them first' using errcode = 'P0001', hint = 'payment:has_refunds';
  end if;
  if new.amount_agorot is distinct from old.amount_agorot then
    -- refunded in full: a correction would leave a surplus nobody counts; cancel the refunds first
    if old.status = 'refunded' then
      raise exception 'the payment has refunds; cancel them first' using errcode = 'P0001', hint = 'payment:has_refunds';
    end if;
    -- a recorded or confirmed payment keeps something counted: never down to its refunds or below
    if new.amount_agorot <= v_refunded then
      raise exception 'the payment has more refunded than the new amount' using errcode = 'P0001', hint = 'payment:refunded_amount';
    end if;
    if new.amount_agorot - v_refunded < app.allocated_on_payment(new.organization_id, new.id, null) then
      raise exception 'the payment has more allocated than the new amount' using errcode = 'P0001', hint = 'payment:allocated';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.payments_refund_guard() from public, anon, authenticated;

create or replace trigger payments_zz_refunds before update on public.payments
  for each row execute function app.payments_refund_guard();

-- ----------------------------------------------------------------------------
-- Privacy erasure: when app.audit_erase_core empties a payment, its refunds go with it
-- ----------------------------------------------------------------------------
create or replace function app.payments_refunds_erase() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.payment_server', true), '') <> 'erase' then
    return null;
  end if;
  update public.payment_refunds r
     set reference = null, note = null,
         cancel_reason = case when r.status = 'cancelled' then 'הסיבה נמחקה (מחיקת פרטיות)' end
   where r.organization_id = new.organization_id and r.payment_id = new.id;
  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = new.organization_id and a.entity_type = 'payment_refunds' and a.action <> 'erase'
     and a.entity_id in (select r.id from public.payment_refunds r
                          where r.organization_id = new.organization_id and r.payment_id = new.id)
     and a.changes is distinct from '{"erased": true}'::jsonb;
  update public.activities ac
     set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
   where ac.organization_id = new.organization_id and ac.metadata ->> 'kind' = 'payment_refunded'
     and ac.metadata ->> 'payment_id' = new.id::text and ac.body like '% · סיבה: %';
  return null;
end;
$$;
revoke all on function app.payments_refunds_erase() from public, anon, authenticated, service_role;

create or replace trigger payments_zz_refunds_erase after update on public.payments
  for each row execute function app.payments_refunds_erase();

-- ----------------------------------------------------------------------------
-- The readers of a payment's counted amount (each the latest body, with the refunds taken off)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.payment_credit(public.payments)
 RETURNS bigint
 LANGUAGE sql
 STABLE
AS $function$
  select case when ($1).status in ('recorded', 'confirmed')
              -- PAY-08: less its active refunds (written out, not through public.payment_refunded: a nested SQL function call is
              -- planned again on every call)
              then greatest(($1).amount_agorot
                            - coalesce((select sum(r.amount_agorot) from public.payment_refunds r
                                         where r.organization_id = ($1).organization_id and r.payment_id = ($1).id
                                           and r.status = 'active'), 0)
                            - coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                                                         where a.organization_id = ($1).organization_id and a.payment_id = ($1).id
                                                           and a.released_at is null and a.removed_at is null), 0), 0)
              else 0 end::bigint
$function$;

CREATE OR REPLACE FUNCTION public.money_allocation_state(p_org uuid, p_documents uuid[], p_payments uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET jit TO 'off'
 SET enable_nestloop TO 'off'
AS $function$
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
               -- PAY-03: public.payment_credit's rule (PAY-08: less the payment's active refunds), from the same counted rows (every counted allocation of a payment
               -- asked for is in `counted`, read under the same RLS); test 260 compares the two
               'credit', (case when p.status in ('recorded', 'confirmed')
                               then greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0) - coalesce(pp.amount, 0), 0)
                               else 0 end)::bigint) order by p.id)
        from public.payments p
        left join per_payment pp on pp.payment_id = p.id
       where p.organization_id = p_org and p.id = any (coalesce(p_payments, '{}'))), '[]'::jsonb)
  )
$function$;

CREATE OR REPLACE FUNCTION app.payment_allocations_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if app.allocated_on_payment(new.organization_id, v_payment.id, new.id) + new.amount_agorot
     -- PAY-08: what the payment holds is its amount less its active refunds
     > v_payment.amount_agorot - public.payment_refunded(v_payment) then
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
$function$;

CREATE OR REPLACE FUNCTION public.customer_ledger(p_org uuid, p_contact uuid, p_company uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
             -- PAY-08: a partly refunded payment counts its amount less its active refunds
             case when p.status in ('recorded', 'confirmed') then greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0) else 0 end::bigint,
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
    select p.id, p.method, p.reference, p.paid_on, p.created_at, p.amount_agorot, p.status, public.payment_credit(p) as credit,
           case when p.status in ('recorded', 'confirmed') then greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0) else 0 end::bigint as counted
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
           -- PAY-08: a partly refunded payment counts its amount less its active refunds
           p.counted,
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
$function$;

CREATE OR REPLACE FUNCTION app.order_money_facts(p_org uuid, p_orders uuid[])
 RETURNS TABLE(order_id uuid, status text, total bigint, billed bigint, paid bigint, requested bigint, has_money boolean, other_documents uuid[], other_payments uuid[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  docs as (
    select x.id, x.order_id, x.doc_type, x.status, x.amount_agorot, x.deal_id, x.contact_id, x.company_id
      from public.accounting_documents x
      join o on o.id = x.order_id
     where x.organization_id = p_org
  ),
  d as (
    select x.order_id,
           sum(case when x.status <> 'active' then 0
                    when x.doc_type in ('tax_invoice', 'tax_invoice_receipt') then x.amount_agorot
                    when x.doc_type = 'credit_invoice' then -x.amount_agorot
                    else 0 end)::bigint as billed,
           sum(case when x.status = 'active' and x.doc_type = 'proforma' then x.amount_agorot else 0 end)::bigint as requested,
           sum(case when x.status = 'active' and x.doc_type = 'tax_invoice_receipt' then x.amount_agorot else 0 end)::bigint as receipts,
           array_agg(x.id) filter (where not app.order_money_same_parent(o.deal_id, o.contact_id, o.company_id,
                                                                          x.deal_id, x.contact_id, x.company_id)) as other
      from docs x
      join o on o.id = x.order_id
     group by x.order_id
  ),
  -- counted allocations onto the order's documents, per payment (A)
  al as (
    select x.order_id, a.payment_id, sum(a.amount_agorot)::bigint as amount
      from public.payment_allocations a
      join docs x on x.id = a.document_id
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
     group by x.order_id, a.payment_id
  ),
  -- counted opening credits onto the order's documents (C)
  oc as (
    select x.order_id, sum(c.amount_agorot)::bigint as amount
      from public.opening_credit_allocations c
      join docs x on x.id = c.document_id
     where c.organization_id = p_org and c.released_at is null and c.removed_at is null
     group by x.order_id
  ),
  -- every payment of each order, once, and whether it is linked (order_id or advance)
  pk as (
    select k.order_id, k.payment_id, bool_or(k.linked) as linked
      from (select o.id as order_id, y.id as payment_id, true as linked
              from o join public.payments y on y.organization_id = p_org and y.order_id = o.id
            union all
            select o.id, y.id, true
              from o join public.payments y on y.organization_id = p_org and y.advance_order_id = o.id and y.is_advance
            union all
            select al.order_id, al.payment_id, false from al) k
     group by k.order_id, k.payment_id
  ),
  pa as (
    select pk.order_id, pk.payment_id, pk.linked, y.deal_id, y.contact_id,
           y.status in ('recorded', 'confirmed') as counted,
           coalesce(al.amount, 0) as here,
           -- F: a linked payment's amount less its active refunds (PAY-08) and all its counted allocations, never below 0
           case when pk.linked
                then greatest(y.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = y.organization_id and r.payment_id = y.id and r.status = 'active'), 0) - coalesce((select sum(a2.amount_agorot) from public.payment_allocations a2
                                                           where a2.organization_id = p_org and a2.payment_id = y.id
                                                             and a2.released_at is null and a2.removed_at is null), 0), 0)
                else 0 end as free
      from pk
      join public.payments y on y.organization_id = p_org and y.id = pk.payment_id
      left join al on al.order_id = pk.order_id and al.payment_id = pk.payment_id
  ),
  p as (
    select pa.order_id,
           sum(case when pa.counted then pa.here else 0 end)::bigint as allocated,
           sum(case when pa.counted then pa.free else 0 end)::bigint as free,
           array_agg(pa.payment_id) filter (where not app.order_money_same_parent(o.deal_id, o.contact_id, o.company_id,
                                                                                   pa.deal_id, pa.contact_id, null)) as other
      from pa
      join o on o.id = pa.order_id
     group by pa.order_id
  )
  select o.id, o.status, o.total_agorot, greatest(coalesce(d.billed, 0), 0),
         coalesce(p.allocated, 0) + coalesce(oc.amount, 0) + greatest(coalesce(p.free, 0), coalesce(d.receipts, 0)),
         coalesce(d.requested, 0),
         d.order_id is not null or p.order_id is not null, d.other, p.other
    from o
    left join d on d.order_id = o.id
    left join p on p.order_id = o.id
    left join oc on oc.order_id = o.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.report_collection(p_org uuid, p_from date, p_to date, p_owner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET jit TO 'off'
 SET enable_nestloop TO 'off'
AS $function$
declare
  v_out jsonb;
  v_zone text;
  v_today date;
  v_min constant integer := 5;
  v_partial boolean := false;
begin
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'collection') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  -- COL-01's partial rule (public.collection_documents; keep in step)
  if not app.is_admin(p_org) and coalesce(app.business_money_rows(p_org), 0) >
     (select count(*) from public.accounting_documents d where d.organization_id = p_org)
     + (select count(*) from public.payments p where p.organization_id = p_org) then
    v_partial := true;
  end if;

  select coalesce(o.timezone, 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = p_org;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_today := (now() at time zone v_zone)::date;

  with pay as materialized (
    -- the payments collected in the period, with their rep (COL-01's rule; a payment has no company: keep in step)
    -- PAY-08: a partly refunded payment counts its amount less its active refunds
    select p.id, greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0) as amount_agorot, p.paid_on, p.method, coalesce(dl.owner_id, ct.owner_id) as owner_id
      from public.payments p
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where p.organization_id = p_org
       and p.status in ('recorded', 'confirmed')
       and p.paid_on >= p_from and p.paid_on <= p_to
  ),
  mine as materialized (
    select * from pay where p_owner is null or owner_id = p_owner
  ),
  months as (
    select m::date as month
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  ),
  by_month as (
    select m.month, coalesce(sum(x.amount_agorot), 0)::bigint as amount, count(x.id) as payments
      from months m
      left join mine x on date_trunc('month', x.paid_on::timestamp)::date = m.month
     group by m.month
  ),
  by_method as (
    select x.method, sum(x.amount_agorot)::bigint as amount, count(*) as payments from mine x group by x.method
  ),
  by_rep as (
    select x.owner_id, sum(x.amount_agorot)::bigint as amount, count(*) as payments from mine x group by x.owner_id
  ),
  -- collection days. Only a document with a counted allocation dated in the period can have its last one there: those
  -- are found first through the period's payments (and the offsets made in it), so the allocations' read rule (a check of
  -- the document per row) runs on the few allocations of those documents, not on every allocation of the business
  docs as materialized (
    -- the debt documents (not a proforma billed by an active invoice) with the rep of COL-01 (keep in step)
    select d.id, d.doc_type, d.doc_date, d.due_date, d.proforma_id,
           coalesce(dl.owner_id, ct.owner_id, co.owner_id) as owner_id
      from public.accounting_documents d
      left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
      left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
      left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
     where d.organization_id = p_org
       and d.status = 'active'
       and d.doc_type in ('tax_invoice', 'proforma')
       and d.amount_agorot > 0
       and not (d.doc_type = 'proforma'
                and exists (select 1 from public.accounting_documents i
                             where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
       and (p_owner is null or coalesce(dl.owner_id, ct.owner_id, co.owner_id) = p_owner)
  ),
  touched as materialized (
    select a.document_id
      from public.payment_allocations a
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
       and a.payment_id in (select x.id from pay x)
    union
    select o.document_id
      from public.opening_credit_allocations o
     where o.organization_id = p_org and o.released_at is null and o.removed_at is null
       and (o.created_at at time zone v_zone)::date between p_from and p_to
  ),
  cand as materialized (
    -- the debt documents touched in the period: by their own allocations, or (a tax invoice) by its billed proforma's
    select x.* from docs x
     where x.id in (select t.document_id from touched t)
        or (x.doc_type = 'tax_invoice' and x.proforma_id in (select t.document_id from touched t))
  ),
  dated as materialized (
    -- every counted allocation of those documents and of the proformas they bill, with its date (the last one decides,
    -- so none is cut at the period's end)
    select a.document_id, p.paid_on as on_day
      from public.payment_allocations a
      join public.payments p on p.organization_id = a.organization_id and p.id = a.payment_id
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
       and (a.document_id in (select c.id from cand c) or a.document_id in (select c.proforma_id from cand c where c.proforma_id is not null))
    union all
    select o.document_id, (o.created_at at time zone v_zone)::date
      from public.opening_credit_allocations o
     where o.organization_id = p_org and o.released_at is null and o.removed_at is null
       and (o.document_id in (select c.id from cand c) or o.document_id in (select c.proforma_id from cand c where c.proforma_id is not null))
  ),
  dated_doc as (
    -- each counted allocation under the document it pays: its own, and a tax invoice's billed active proforma's
    select t.document_id as doc_id, t.on_day from dated t
    union all
    select i.id, t.on_day
      from dated t
      join cand i on i.doc_type = 'tax_invoice' and i.proforma_id = t.document_id
      join public.accounting_documents p on p.organization_id = p_org and p.id = i.proforma_id and p.status = 'active'
  ),
  last_day as (
    -- the last counted allocation of each debt document, kept when it falls in the period
    select x.id, max(t.on_day) as paid_on
      from cand x
      join dated_doc t on t.doc_id = x.id
     group by x.id
    having max(t.on_day) between p_from and p_to
  ),
  state as (
    select (s ->> 'id')::uuid as id, s ->> 'state' as state
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from last_day),
                                                              '{}'::uuid[]) -> 'documents') s
  ),
  closed as (
    -- COL-06 (2) (ב): a tax invoice that bills an active proforma counts its days from the proforma's date (the day the
    -- customer was first asked to pay); days late stay against the invoice's own due date
    select greatest(l.paid_on - coalesce(pf.doc_date, x.doc_date), 0) as days,
           case when x.due_date is not null then greatest(l.paid_on - x.due_date, 0) end as days_late
      from last_day l
      join cand x on x.id = l.id
      join state s on s.id = l.id and s.state = 'paid'
      left join public.accounting_documents pf
             on x.doc_type = 'tax_invoice' and pf.organization_id = p_org and pf.id = x.proforma_id and pf.status = 'active'
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', v_partial,
    'today', v_today,
    'from', p_from,
    'to', p_to,
    'totals', case when v_partial then null
                   else (select jsonb_build_object('amount', coalesce(sum(x.amount_agorot), 0)::bigint, 'payments', count(*)) from mine x) end,
    'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', b.month, 'amount', b.amount, 'payments', b.payments) order by b.month)
                            from by_month b), '[]'::jsonb),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', b.method, 'amount', b.amount, 'payments', b.payments)
                                            order by b.amount desc, b.method)
                             from by_method b), '[]'::jsonb),
    'by_rep', coalesce((select jsonb_agg(jsonb_build_object('owner_id', b.owner_id, 'amount', b.amount, 'payments', b.payments)
                                         order by b.amount desc, b.owner_id nulls last)
                          from by_rep b), '[]'::jsonb),
    'collection_days', case when v_partial then jsonb_build_object(
                          'min_documents', v_min, 'documents', null, 'average_days', null, 'median_days', null,
                          'with_due_date', null, 'average_days_late', null, 'late_documents', null)
                        else (select jsonb_build_object(
                          'min_documents', v_min,
                          'documents', count(*),
                          'average_days', case when count(*) >= v_min then round(avg(c.days), 1) end,
                          'median_days', case when count(*) >= v_min
                                              then round((percentile_cont(0.5) within group (order by c.days))::numeric, 1) end,
                          'with_due_date', count(c.days_late),
                          'average_days_late', case when count(c.days_late) >= v_min then round(avg(c.days_late), 1) end,
                          'late_documents', count(*) filter (where c.days_late > 0))
                          from closed c) end
  ) into v_out;
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.report_goal_progress(p_org uuid, p_period text DEFAULT NULL::text, p_period_start date DEFAULT NULL::date, p_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with org as (
    select coalesce(o.timezone, 'Asia/Jerusalem') as tz, o.record_visibility::text as visibility,
           (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today
      from public.organizations o
     where o.id = p_org
  ), g as (
    select g.id, g.scope, g.user_id, g.team_id, g.period, g.period_start, g.metric, g.target,
           (g.period_start::timestamp at time zone org.tz) as t_from,
           ((g.period_start + case g.period when 'month' then interval '1 month'
                                            when 'quarter' then interval '3 months'
                                            else interval '1 year' end)::timestamp at time zone org.tz) as t_to
      from public.goals g
      cross join org
     where g.organization_id = p_org
       and (p_user is null or (g.scope = 'user' and g.user_id = p_user))
       and case when p_period is not null or p_period_start is not null
                then g.period = p_period and g.period_start = p_period_start
                else g.period_start <= org.today
                     and org.today < g.period_start + case g.period when 'month' then interval '1 month'
                                                                    when 'quarter' then interval '3 months'
                                                                    else interval '1 year' end
           end
       -- GOL-01 collection: only while the plan holds payments, documents and collection ((15) ב), and only for those
       -- who record payments ((16) ב: COL-01's rule; for anyone else the goal is left out, as COL-01 answers them
       -- {"allowed": false}; the goal's target stays visible on the goals grid per goals_select)
       and (g.metric <> 'collected'
            or (app.org_has_feature(p_org, 'payments') and app.org_has_feature(p_org, 'documents')
                and app.org_has_feature(p_org, 'collection') and app.can_record_payments(p_org)))
  ), windows as (
    select distinct g.period, g.period_start, g.t_from, g.t_to from g
  ), contacted as (
    -- leads with a contact entry inside a goal's window first; their first entry ever is then
    -- looked up for those leads only
    select distinct a.lead_id
      from windows w
      join public.activities a on a.organization_id = p_org and a.lead_id is not null
                              and a.occurred_at >= w.t_from and a.occurred_at < w.t_to
     where a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private
       and a.occurred_at <= now() + interval '5 minutes'
       and exists (select 1 from g where g.metric = 'leads_handled')
  ), first_contact as (
    select a.lead_id, min(a.occurred_at) as at
      from public.activities a
     where a.organization_id = p_org and a.lead_id in (select c.lead_id from contacted c)
       and a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private
       and a.occurred_at <= now() + interval '5 minutes'
     group by a.lead_id
  ), pay_facts as (
    -- GOL-01 collection: payments recorded or confirmed with paid_on in the period, a cheque only once cleared or due
    -- (owner's answer (17) ג), by rep
    -- (the deal's owner, else the contact's) and team (the deal's, else the contact's), as the caller reads them
    select w.period, w.period_start, coalesce(dl.owner_id, ct.owner_id) as user_id, coalesce(dl.team_id, ct.team_id) as team_id,
           -- PAY-08: a partly refunded payment counts its amount less its active refunds
           sum(greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0))::numeric as value, count(*)::bigint as n
      from windows w
      cross join org
      join public.payments p on p.organization_id = p_org and p.status in ('recorded', 'confirmed')
                            and p.paid_on >= w.period_start
                            and p.paid_on < (w.period_start + case w.period when 'month' then interval '1 month'
                                                                            when 'quarter' then interval '3 months'
                                                                            else interval '1 year' end)::date
                            -- (17) (ג): a cheque once cleared or due (keep in step with app.goal_payments_counted)
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= org.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where exists (select 1 from g where g.metric = 'collected')
     group by 1, 2, 3, 4
  ), facts as (
    -- what each person did, and on records of which team
    select w.period, w.period_start, 'won_amount'::text as metric, d.owner_id as user_id, d.team_id,
           sum(d.amount_agorot)::numeric as value
      from windows w
      join public.deals d on d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
                         and d.closed_at >= w.t_from and d.closed_at < w.t_to
     where exists (select 1 from g where g.metric = 'won_amount')
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'won_deals', d.owner_id, d.team_id, count(*)::numeric
      from windows w
      join public.deals d on d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
                         and d.closed_at >= w.t_from and d.closed_at < w.t_to
     where exists (select 1 from g where g.metric = 'won_deals')
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'leads_handled', l.owner_id, l.team_id, count(*)::numeric
      from windows w
      join first_contact f on f.at >= w.t_from and f.at < w.t_to
      join public.leads l on l.organization_id = p_org and l.id = f.lead_id and l.deleted_at is null
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'meetings_held', a.created_by,
           app.activity_goal_team(p_org, a.deal_id, a.lead_id, a.contact_id, a.company_id), count(*)::numeric
      from windows w
      join public.activities a on a.organization_id = p_org and a.type = 'meeting' and a.created_by is not null
                              and a.occurred_at >= w.t_from and a.occurred_at < w.t_to
                              and a.occurred_at <= now() + interval '5 minutes'
     where exists (select 1 from g where g.metric = 'meetings_held')
     group by 1, 2, 4, 5
    union all
    select pf.period, pf.period_start, 'collected', pf.user_id, pf.team_id, pf.value from pay_facts pf
  ), tree as (
    -- each team goal's team and the teams below it
    with recursive t (root, team_id, depth) as (
      select tm.id, tm.id, 1
        from public.teams tm
       where tm.organization_id = p_org and tm.id in (select g.team_id from g where g.scope = 'team')
      union all
      select t.root, c.id, t.depth + 1
        from t join public.teams c on c.organization_id = p_org and c.parent_team_id = t.team_id
       where t.depth < 10
    )
    select distinct t.root, t.team_id from t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'goal_id', r.id,
           'scope', r.scope,
           'user_id', r.user_id,
           'team_id', r.team_id,
           'period', r.period,
           'period_start', r.period_start,
           'metric', r.metric,
           'target', r.target,
           'actual', r.actual,
           'elapsed', r.elapsed)
         order by array_position(array['org', 'team', 'user'], r.scope),
                  array_position(array['won_amount', 'won_deals', 'leads_handled', 'meetings_held', 'collected'], r.metric),
                  array_position(array['month', 'quarter', 'year'], r.period),
                  r.period_start, r.id), '[]'::jsonb)
    from (
      select g.id, g.scope, g.user_id, g.team_id, g.period, g.period_start, g.metric, g.target,
             coalesce((
               select sum(f.value) from facts f
                where f.period = g.period and f.period_start = g.period_start and f.metric = g.metric
                  and (g.scope = 'org'
                       or (g.scope = 'user' and f.user_id = g.user_id)
                       or (g.scope = 'team' and f.team_id in (select tree.team_id from tree where tree.root = g.team_id)))
             ), 0)::bigint as actual,
             round(greatest(0, least(1,
               extract(epoch from (now() - g.t_from)) / nullif(extract(epoch from (g.t_to - g.t_from)), 0)))::numeric, 4) as elapsed
        from g
       where case when g.metric = 'collected' then
               -- GOL-01 collection: every payment that counts for the goal is one the caller reads
               coalesce((
                 select sum(pf.n) from pay_facts pf
                  where pf.period = g.period and pf.period_start = g.period_start
                    and (g.scope = 'org'
                         or (g.scope = 'user' and pf.user_id = g.user_id)
                         or (g.scope = 'team' and pf.team_id in (select tree.team_id from tree where tree.root = g.team_id)))
               ), 0) = app.goal_payments_counted(p_org, g.id)
             else
             app.is_admin(p_org)
          -- platform support in an open session, unless they are also a member (then their role decides)
          or (app.membership_role(p_org) is null and app.support_session(p_org))
          or (select visibility from org) = 'org'
          -- a team's goal: its manager reads every record of the team and the teams below it
          -- (and of every team the goal counts: a tree deeper than app.manages_team reaches is not whole)
          or (g.scope = 'team' and app.goals_manages_team(p_org, g.team_id)
              and not exists (select 1 from tree where tree.root = g.team_id and not app.manages_team(tree.team_id)))
          or (g.scope = 'team' and (select visibility from org) = 'team'
              and not exists (select 1 from tree where tree.root = g.team_id and not app.in_team(tree.team_id)))
          -- a person's own goal; for meetings only while every entry they wrote in the period is on
          -- a record they may still read (activities_select would hide the others)
          or (g.scope = 'user' and g.user_id = (select auth.uid())
              and (g.metric <> 'meetings_held' or app.goal_entries_readable(p_org, g.user_id, g.t_from, g.t_to)))
             end
    ) r;
$function$;

CREATE OR REPLACE FUNCTION public.statement_public(p_token text, p_ip_hash text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link app.statement_links;
  v_org public.organizations;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_today date;
  v_customer text;
  v_show_details boolean;
  v_show_logo boolean;
  v_docs uuid[];
  v_rows jsonb;
  v_totals record;
  v_credit bigint;
  v_built_with boolean;
  v_pays record;
  v_bank jsonb;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.statement_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found or not app.statement_link_usable(v_link) then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted (one row update) before the page's data is read, so the limit holds under
  -- parallel load
  update app.statement_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.id = v_link.id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 60 views per sender in 10 minutes, by the server's keyed IP hash scoped to this link
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.statement_link_sender(v_link.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.statement_link_view_counts as vc (link_id, bucket, window_start, views)
    values (v_link.id, v_bucket, now(), 1)
    on conflict (link_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_org from public.organizations o where o.id = v_link.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_link.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_link.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_today := (now() at time zone coalesce(v_org.timezone, 'Asia/Jerusalem'))::date;

  -- the customer as documents name it (CON-08): the billing name, else the name
  if v_link.contact_id is not null then
    select coalesce(nullif(btrim(c.billing_name), ''), c.full_name) into v_customer
      from public.contacts c where c.organization_id = v_link.organization_id and c.id = v_link.contact_id;
  else
    select coalesce(nullif(btrim(c.billing_name), ''), c.name) into v_customer
      from public.companies c where c.organization_id = v_link.organization_id and c.id = v_link.company_id;
  end if;

  -- BAL-02's scope (public.customer_debt_summary / public.customer_ledger; keep in step): a contact without a company =
  -- its own documents; a company = its own, its contacts' and its deals'
  select coalesce(array_agg(d.id), '{}'::uuid[]) into v_docs
    from public.accounting_documents d
   where d.organization_id = v_link.organization_id
     and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.status = 'active' and d.amount_agorot > 0
     and ((v_link.contact_id is not null and d.contact_id = v_link.contact_id)
          or (v_link.company_id is not null
              and (d.company_id = v_link.company_id
                   or d.contact_id in (select c.id from public.contacts c
                                        where c.organization_id = v_link.organization_id and c.company_id = v_link.company_id)
                   or d.deal_id in (select x.id from public.deals x
                                     where x.organization_id = v_link.organization_id and x.company_id = v_link.company_id))));

  with balances as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(v_link.organization_id, v_docs, '{}'::uuid[]) -> 'documents') x
  ),
  open_docs as (
    select d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, b.balance, d.created_at, d.id,
           case when d.due_date < v_today then v_today - d.due_date else 0 end as overdue_days
      from public.accounting_documents d
      join balances b on b.id = d.id
     where d.organization_id = v_link.organization_id and d.id = any (v_docs) and b.balance > 0
  ),
  ranked as (
    select o.*, row_number() over (order by o.due_date nulls last, o.doc_date, o.created_at, o.id) as n from open_docs o
  )
  select coalesce(sum(r.balance), 0)::bigint as open_agorot,
         coalesce(sum(r.balance) filter (where r.due_date < v_today), 0)::bigint as overdue_agorot,
         count(*) filter (where r.n > 500) as more,
         coalesce(jsonb_agg(jsonb_build_object(
           'type', r.doc_type,
           'number', r.number,
           'doc_date', r.doc_date,
           'due_date', r.due_date,
           'amount_agorot', r.amount_agorot,
           'balance_agorot', r.balance,
           'overdue_days', r.overdue_days) order by r.n) filter (where r.n <= 500), '[]'::jsonb) as rows
    into v_totals
    from ranked r;
  v_rows := v_totals.rows;

  -- PAY-03: the customer's credit, a separate figure (never netted into the debt here)
  v_credit := coalesce((public.money_customer_credit(v_link.organization_id, null, v_link.contact_id, v_link.company_id) ->> 'total')::bigint, 0);

  -- BAL-04 answer (2) (ב): payments received in the last 12 months (paid_on in the business's zone), the same customer
  -- scope as the documents and BAL-01's ledger (keep in step): a contact without a company = its own payments; a company =
  -- its contacts' and its deals' payments. Recorded or confirmed only; the date, the method code and the amount only.
  with pays as (
    -- PAY-08: a partly refunded payment shows its amount less its active refunds (keep in step)
    select p.paid_on, p.method, greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0) as amount_agorot, p.created_at, p.id
      from public.payments p
     where p.organization_id = v_link.organization_id
       and p.status in ('recorded', 'confirmed')
       and p.paid_on > (v_today - interval '12 months')::date and p.paid_on <= v_today
       -- PAY-08: a payment its refunds took to nothing is not listed (keep in step)
       and greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0) > 0
       and ((v_link.contact_id is not null and p.contact_id = v_link.contact_id)
            or (v_link.company_id is not null
                and (p.contact_id in (select c.id from public.contacts c
                                       where c.organization_id = v_link.organization_id and c.company_id = v_link.company_id)
                     or p.deal_id in (select x.id from public.deals x
                                       where x.organization_id = v_link.organization_id and x.company_id = v_link.company_id))))
  ),
  ranked_pays as (
    select y.*, row_number() over (order by y.paid_on desc, y.created_at desc, y.id) as n from pays y
  )
  select count(*) filter (where r.n > 500) as more,
         coalesce(jsonb_agg(jsonb_build_object(
           'paid_on', r.paid_on,
           'method', r.method,
           'amount_agorot', r.amount_agorot) order by r.n) filter (where r.n <= 500), '[]'::jsonb) as rows
    into v_pays
    from ranked_pays r;

  -- BAL-04 answer (4) (ב): the business's bank details, read now (nothing stored), while the statement's TAX-02 switch is
  -- on (no design row = on)
  if coalesce(v_design.show_bank_details_statement, true) then
    v_bank := app.document_bank_snapshot(v_link.organization_id);
  end if;

  begin
    v_built_with := coalesce(app.show_built_with(v_link.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'business', jsonb_build_object(
      -- the display name (customer-facing communication); the registered one with the details, as on documents
      'name', v_org.name,
      'legal_name', case when v_show_details then nullif(btrim(v_settings.legal_name), '') end,
      'tax_id', case when v_show_details then v_settings.tax_id end,
      'address_line', case when v_show_details then v_settings.address_line end,
      'city', case when v_show_details then v_settings.city end,
      'postal_code', case when v_show_details then v_settings.postal_code end,
      'phone', case when v_show_details then v_settings.phone end,
      'email', case when v_show_details then v_settings.email end),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end,
                                'color', coalesce(v_design.accent_color, v_org.brand_color)),
    'customer', jsonb_build_object('name', v_customer),
    'today', v_today,
    'currency', 'ILS',
    'documents', v_rows,
    'more', v_totals.more,
    'payments', v_pays.rows,
    'payments_more', v_pays.more,
    'bank', v_bank,
    'totals', jsonb_build_object('open_agorot', v_totals.open_agorot, 'overdue_agorot', v_totals.overdue_agorot,
                                 'credit_agorot', v_credit),
    'built_with', v_built_with);
end;
$function$;

CREATE OR REPLACE FUNCTION public.statement_staff_view(p_org uuid, p_contact uuid, p_company uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET jit TO 'off'
AS $function$
declare
  v_summary jsonb;
  v_org public.organizations;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_today date;
  v_customer text;
  v_company uuid;
  v_live boolean;
  v_show_details boolean;
  v_show_logo boolean;
  v_switch boolean;
  v_admin boolean;
  v_show_bank boolean;
  v_docs uuid[];
  v_rows jsonb;
  v_totals record;
  v_credit bigint;
  v_pays record;
  v_bank jsonb;
begin
  if (p_contact is null) = (p_company is null) then
    raise exception 'one customer: a contact or a company' using errcode = '22023';
  end if;

  -- BAL-01's rights and keys
  v_summary := public.customer_debt_summary(p_org, p_contact, p_company);
  if not coalesce((v_summary ->> 'allowed')::boolean, false) then
    return jsonb_build_object('allowed', false);
  end if;

  -- the customer as the link's rule takes it (app.statement_customer_live): live, and a contact without a company;
  -- read under RLS, so a customer the caller does not read is not found
  if p_contact is not null then
    select coalesce(nullif(btrim(c.billing_name), ''), c.full_name), c.company_id, c.deleted_at is null
      into v_customer, v_company, v_live
      from public.contacts c where c.organization_id = p_org and c.id = p_contact;
  else
    select coalesce(nullif(btrim(c.billing_name), ''), c.name), null::uuid, c.deleted_at is null
      into v_customer, v_company, v_live
      from public.companies c where c.organization_id = p_org and c.id = p_company;
  end if;
  if not coalesce(v_live, false) then
    return jsonb_build_object('allowed', true, 'partial', false, 'refused', 'not_found');
  end if;
  if v_company is not null then
    return jsonb_build_object('allowed', true, 'partial', false, 'refused', 'company');
  end if;

  -- BAL-01's partial rule (customer_debt_summary): nothing of a view that misses a row of the customer
  if coalesce((v_summary ->> 'partial')::boolean, true) then
    return jsonb_build_object('allowed', true, 'partial', true);
  end if;

  select * into v_org from public.organizations o where o.id = p_org;
  select * into v_design from public.quote_designs d where d.organization_id = p_org;
  select * into v_settings from public.org_document_settings s where s.organization_id = p_org;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_today := (now() at time zone coalesce(v_org.timezone, 'Asia/Jerusalem'))::date;

  -- public.statement_public's selection from here on (keep in step): BAL-02's scope, a contact without a company = its own
  -- documents; a company = its own, its contacts' and its deals'
  select coalesce(array_agg(d.id), '{}'::uuid[]) into v_docs
    from public.accounting_documents d
   where d.organization_id = p_org
     and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.status = 'active' and d.amount_agorot > 0
     and ((p_contact is not null and d.contact_id = p_contact)
          or (p_company is not null
              and (d.company_id = p_company
                   or d.contact_id in (select c.id from public.contacts c
                                        where c.organization_id = p_org and c.company_id = p_company)
                   or d.deal_id in (select x.id from public.deals x
                                     where x.organization_id = p_org and x.company_id = p_company))));

  with balances as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(p_org, v_docs, '{}'::uuid[]) -> 'documents') x
  ),
  open_docs as (
    select d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, b.balance, d.created_at, d.id,
           case when d.due_date < v_today then v_today - d.due_date else 0 end as overdue_days
      from public.accounting_documents d
      join balances b on b.id = d.id
     where d.organization_id = p_org and d.id = any (v_docs) and b.balance > 0
  ),
  ranked as (
    select o.*, row_number() over (order by o.due_date nulls last, o.doc_date, o.created_at, o.id) as n from open_docs o
  )
  select coalesce(sum(r.balance), 0)::bigint as open_agorot,
         coalesce(sum(r.balance) filter (where r.due_date < v_today), 0)::bigint as overdue_agorot,
         count(*) filter (where r.n > 500) as more,
         coalesce(jsonb_agg(jsonb_build_object(
           'type', r.doc_type,
           'number', r.number,
           'doc_date', r.doc_date,
           'due_date', r.due_date,
           'amount_agorot', r.amount_agorot,
           'balance_agorot', r.balance,
           'overdue_days', r.overdue_days) order by r.n) filter (where r.n <= 500), '[]'::jsonb) as rows
    into v_totals
    from ranked r;
  v_rows := v_totals.rows;

  -- PAY-03: the customer's credit, a separate figure (never netted into the debt here)
  v_credit := coalesce((public.money_customer_credit(p_org, null, p_contact, p_company) ->> 'total')::bigint, 0);

  -- payments received in the last 12 months (paid_on in the business's zone), the documents' customer scope; recorded or
  -- confirmed only; the date, the method code and the amount only
  with pays as (
    -- PAY-08: a partly refunded payment shows its amount less its active refunds (keep in step)
    select p.paid_on, p.method, greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0) as amount_agorot, p.created_at, p.id
      from public.payments p
     where p.organization_id = p_org
       and p.status in ('recorded', 'confirmed')
       and p.paid_on > (v_today - interval '12 months')::date and p.paid_on <= v_today
       -- PAY-08: a payment its refunds took to nothing is not listed (keep in step)
       and greatest(p.amount_agorot - coalesce((select sum(r.amount_agorot) from public.payment_refunds r where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active'), 0), 0) > 0
       and ((p_contact is not null and p.contact_id = p_contact)
            or (p_company is not null
                and (p.contact_id in (select c.id from public.contacts c
                                       where c.organization_id = p_org and c.company_id = p_company)
                     or p.deal_id in (select x.id from public.deals x
                                       where x.organization_id = p_org and x.company_id = p_company))))
  ),
  ranked_pays as (
    select y.*, row_number() over (order by y.paid_on desc, y.created_at desc, y.id) as n from pays y
  )
  select count(*) filter (where r.n > 500) as more,
         coalesce(jsonb_agg(jsonb_build_object(
           'paid_on', r.paid_on,
           'method', r.method,
           'amount_agorot', r.amount_agorot) order by r.n) filter (where r.n <= 500), '[]'::jsonb) as rows
    into v_pays
    from ranked_pays r;

  -- BAL-04 answer (35) (א): the bank details for owners and admins only, while the statement's switch is on; read under
  -- RLS (org_bank_details_select = app.is_admin), in app.document_bank_snapshot's shape (keep in step)
  v_switch := coalesce(v_design.show_bank_details_statement, true);
  v_admin := app.is_admin(p_org);
  v_show_bank := v_switch and v_admin;
  if v_show_bank then
    select jsonb_build_object(
             'bank_name', b.bank_name,
             'bank_branch', b.bank_branch,
             'bank_account', b.bank_account,
             'bank_account_name', b.bank_account_name)
      into v_bank
      from public.org_bank_details b
     where b.organization_id = p_org and b.bank_account is not null;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'partial', false,
    'business', jsonb_build_object(
      'name', v_org.name,
      'legal_name', case when v_show_details then nullif(btrim(v_settings.legal_name), '') end,
      'tax_id', case when v_show_details then v_settings.tax_id end,
      'address_line', case when v_show_details then v_settings.address_line end,
      'city', case when v_show_details then v_settings.city end,
      'postal_code', case when v_show_details then v_settings.postal_code end,
      'phone', case when v_show_details then v_settings.phone end,
      'email', case when v_show_details then v_settings.email end),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end,
                                'color', coalesce(v_design.accent_color, v_org.brand_color)),
    'customer', jsonb_build_object('name', v_customer),
    'today', v_today,
    'currency', 'ILS',
    'documents', v_rows,
    'more', v_totals.more,
    'payments', v_pays.rows,
    'payments_more', v_pays.more,
    'bank', v_bank,
    'bank_elsewhere', v_switch and not v_admin,
    'totals', jsonb_build_object('open_agorot', v_totals.open_agorot, 'overdue_agorot', v_totals.overdue_agorot,
                                 'credit_agorot', v_credit),
    'built_with', false);
end;
$function$;

