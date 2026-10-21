-- ORD-06 part two (owner's queue; lead 21 October 2026, answer (א) recorded for the owner): an order's accounting documents and
-- payments. accounting_documents and payments gain a nullable order_id.
-- * Composite FK (organization_id, order_id) to public.orders, on delete set null of the column, with a full index (test 130). A
--   numbered order is never deleted (orders_delete_guard), so the set-null only runs when the whole business goes or a server
--   path removes an order.
-- * A person sets order_id on insert only (insert grant; no update grant). Definer triggers app.accounting_documents_order and
--   app.payments_order (outsider guard first, so RLS's 42501 answers a stranger) hold the rules for every person's write:
--   the order is of this business, numbered (a draft is refused, hint order_money:draft; answer (א), easy to relax later),
--   and the row hangs on the order's own deal or contact (hint order_money:parent), so the read rules of the row (deal, else
--   contact) and of the order agree and a merge or erasure needs nothing new. On update order_id never changes, except the
--   foreign key's own set-null one trigger level down (hint document:frozen / payment:frozen).
-- * They run after accounting_documents_check / payments_check (trigger names sort after them), which stay as they are: their
--   frozen lists do not name order_id, and this trigger holds it.
-- * Merge (app.merge_move_links moves documents and payments by contact_id) leaves order_id as it is; the order's own contact
--   moves with it. Erasure: no new personal text. Full export: the new column only.
-- Every statement is safe to run twice. No drops of data, no row removal.

alter table public.accounting_documents add column if not exists order_id uuid;
alter table public.payments add column if not exists order_id uuid;

alter table public.accounting_documents drop constraint if exists accounting_documents_order_fk;
alter table public.accounting_documents add constraint accounting_documents_order_fk foreign key (organization_id, order_id)
  references public.orders (organization_id, id) on delete set null (order_id);
alter table public.payments drop constraint if exists payments_order_fk;
alter table public.payments add constraint payments_order_fk foreign key (organization_id, order_id)
  references public.orders (organization_id, id) on delete set null (order_id);

create index if not exists accounting_documents_order_idx on public.accounting_documents (organization_id, order_id);
create index if not exists payments_order_idx on public.payments (organization_id, order_id);

grant insert (order_id) on public.accounting_documents to authenticated;
grant insert (order_id) on public.payments to authenticated;

-- The rule for one row: shared by both tables (no grants; called from the two triggers only).
create or replace function app.money_order_link_check(p_org uuid, p_order uuid, p_deal uuid, p_contact uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_order record;
begin
  select o.status, o.deal_id, o.contact_id into v_order
    from public.orders o where o.organization_id = p_org and o.id = p_order;
  if not found then
    -- the composite FK answers too; this keeps the message one
    raise exception 'the order is not of this business' using errcode = 'P0001', hint = 'order_money:parent';
  end if;
  if v_order.status = 'draft' then
    raise exception 'a document or payment attaches to a numbered order only' using errcode = 'P0001', hint = 'order_money:draft';
  end if;
  -- on the order's own deal (with the order's contact or none), else on the order's own contact; never another record
  if not coalesce(case when v_order.deal_id is not null
               then p_deal = v_order.deal_id and (p_contact is null or p_contact = v_order.contact_id)
               when v_order.contact_id is not null
               then p_deal is null and p_contact = v_order.contact_id
               else false
          end, false) then
    raise exception 'the row must hang on the order''s deal or contact' using errcode = 'P0001', hint = 'order_money:parent';
  end if;
end;
$$;
revoke all on function app.money_order_link_check(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.accounting_documents_order() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard: RLS refuses (42501) a person who may not record documents here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.order_id is not null then
      perform app.money_order_link_check(new.organization_id, new.order_id, new.deal_id, new.contact_id);
    end if;
    return new;
  end if;
  -- UPDATE: the link never changes, but for the foreign key's own set-null (a nested trigger)
  if new.order_id is distinct from old.order_id and not (new.order_id is null and pg_trigger_depth() > 1) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  return new;
end;
$$;
revoke all on function app.accounting_documents_order() from public, anon, authenticated, service_role;

create or replace trigger accounting_documents_order before insert or update of order_id on public.accounting_documents
  for each row execute function app.accounting_documents_order();

create or replace function app.payments_order() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard: RLS refuses (42501) a person who may not record payments here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.order_id is not null then
      perform app.money_order_link_check(new.organization_id, new.order_id, new.deal_id, new.contact_id);
    end if;
    return new;
  end if;
  if new.order_id is distinct from old.order_id and not (new.order_id is null and pg_trigger_depth() > 1) then
    raise exception 'a payment stays on its order' using errcode = 'P0001', hint = 'payment:frozen';
  end if;
  return new;
end;
$$;
revoke all on function app.payments_order() from public, anon, authenticated, service_role;

create or replace trigger payments_order before insert or update of order_id on public.payments
  for each row execute function app.payments_order();
