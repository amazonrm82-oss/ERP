-- =============================================================================
-- LNK-02 (first part of payment links, LNK-01..LNK-07; owner (270) (1) א: built now behind a FAKE provider, hidden on the
-- live site until a real adapter exists): a payment link for an amount, stored per business.
-- =============================================================================
-- * public.payment_links: one link, from exactly one source (SPEC-ADDITIONS 7.3, LNK-02):
--     - a quote (a deposit): sent, viewed or accepted, still valid (an accepted one always), its customer not deleted;
--       the amount at most the quote's total with VAT; plan key `quotes`.
--     - an order: numbered and not cancelled; at most the order's total; plan key `orders`.
--     - an open document: an active tax invoice, proforma or positive opening balance with a balance; at most the balance
--       (app.document_balance, PAY-02's rule); plan key `documents`.
--     - a contact, any amount ("סכום חופשי"); the contact not in the recycle bin.
--   With a maximum number of card instalments (1..36) and a last day (today..+90 days in the business zone; the link
--   stops at the end of that day). Amount in agorot, currency ILS (as every money table).
-- * Who: whoever records payments (app.can_record_payments, PAY-06), in a writable business, with plan keys `payments`
--   and `payment_links`, on a source they read (the insert policy). Reading follows the source (as payments: a quote,
--   order or document by its own read rule, a contact by contacts_select). Never deleted: a pending link is cancelled.
-- * The provider (LNK-01, LNK-03): `provider` is a code from a closed list, only 'fake' until the owner chooses a real
--   one. The payment page is the provider's own page: card numbers and security codes never pass through our servers
--   (no column holds them). A fake link gets the provider id 'fake_<link id>' (= fakePaymentLinkId() in
--   src/features/payment-links/providers/fake.ts) and no page address. A real provider's page is created by the job
--   worker (a new OPS-04 job kind that needs the owner's approval and its own "In use" line; not built), which will fill
--   provider_link_id and hosted_url through a service_role function; both are server-only here.
-- * Status: pending, then cancelled (a person), expired (pg_cron `crm-payment-link-expiry`, every 15 minutes, after the
--   last day), paid or failed (the provider's signed webhook, LNK-04/LNK-05; not built: `payment_id` and `paid_at` are
--   the seam, server-only). A finished link never changes again.
-- * At most 20 pending links per source (hint payment_link:max), so a slip of the hand does not leave a pile.
-- * A purged source takes its links (on delete cascade: a link holds no money; the payment it may lead to is its own row).
--   A contact merge moves the duplicate's free links through the `merged` timeline entry (app.merge_payment_links).
--   Audited. In the full export. No automation events yet (LNK-05).
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.payment_links (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  quote_id               uuid,
  order_id               uuid,
  accounting_document_id uuid,
  contact_id             uuid,
  amount_agorot          bigint not null check (amount_agorot between 1 and 1000000000000),
  currency               text not null default 'ILS' check (currency = 'ILS'),
  max_installments       smallint not null default 1 check (max_installments between 1 and 36),
  expires_on             date not null,
  expires_at             timestamptz not null default now(),
  title                  text check (title is null or char_length(title) between 1 and 200),
  provider               text not null check (provider in ('fake')),
  provider_link_id       text check (provider_link_id is null or provider_link_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  hosted_url             text check (hosted_url is null or (hosted_url ~ '^https://[^\s]+$' and char_length(hosted_url) <= 2000)),
  status                 text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired', 'cancelled')),
  status_at              timestamptz,
  payment_id             uuid,
  paid_at                timestamptz,
  cancelled_at           timestamptz,
  cancelled_by           uuid references auth.users (id) on delete set null,
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, id),
  constraint payment_links_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade,
  constraint payment_links_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade,
  constraint payment_links_document_fk foreign key (organization_id, accounting_document_id)
    references public.accounting_documents (organization_id, id) on delete cascade,
  constraint payment_links_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint payment_links_payment_fk foreign key (organization_id, payment_id)
    references public.payments (organization_id, id) on delete set null (payment_id),
  -- exactly one source
  constraint payment_links_one_source check (num_nonnulls(quote_id, order_id, accounting_document_id, contact_id) = 1),
  constraint payment_links_cancel_shape check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint payment_links_provider_id_unique unique (organization_id, provider, provider_link_id)
);

create index if not exists payment_links_quote_idx on public.payment_links (organization_id, quote_id);
create index if not exists payment_links_order_idx on public.payment_links (organization_id, order_id);
create index if not exists payment_links_document_idx on public.payment_links (organization_id, accounting_document_id);
create index if not exists payment_links_contact_idx on public.payment_links (organization_id, contact_id);
create index if not exists payment_links_payment_idx on public.payment_links (organization_id, payment_id);
create index if not exists payment_links_pending_idx on public.payment_links (expires_at) where status = 'pending';

alter table public.payment_links enable row level security;

revoke all on public.payment_links from anon, authenticated;
grant select on public.payment_links to authenticated;
grant insert (organization_id, quote_id, order_id, accounting_document_id, contact_id, amount_agorot, currency, max_installments,
              expires_on, provider)
  on public.payment_links to authenticated;
grant update (status) on public.payment_links to authenticated;

-- The source a person reads, by that source's own read rule (RLS of the source table)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_links' and policyname = 'payment_links_select') then
    create policy payment_links_select on public.payment_links for select to authenticated
      using (case when payment_links.quote_id is not null
                  then exists (select 1 from public.quotes q where q.organization_id = payment_links.organization_id and q.id = payment_links.quote_id)
                  when payment_links.order_id is not null
                  then exists (select 1 from public.orders o where o.organization_id = payment_links.organization_id and o.id = payment_links.order_id)
                  when payment_links.accounting_document_id is not null
                  then exists (select 1 from public.accounting_documents d
                                where d.organization_id = payment_links.organization_id and d.id = payment_links.accounting_document_id)
                  else exists (select 1 from public.contacts c where c.organization_id = payment_links.organization_id and c.id = payment_links.contact_id)
             end);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_links' and policyname = 'payment_links_insert') then
    create policy payment_links_insert on public.payment_links for insert to authenticated
      with check (app.can_record_payments(organization_id) and app.org_writable(organization_id)
                  and case when payment_links.quote_id is not null
                           then exists (select 1 from public.quotes q where q.organization_id = payment_links.organization_id and q.id = payment_links.quote_id)
                           when payment_links.order_id is not null
                           then exists (select 1 from public.orders o where o.organization_id = payment_links.organization_id and o.id = payment_links.order_id)
                           when payment_links.accounting_document_id is not null
                           then exists (select 1 from public.accounting_documents d
                                         where d.organization_id = payment_links.organization_id and d.id = payment_links.accounting_document_id)
                           else exists (select 1 from public.contacts c where c.organization_id = payment_links.organization_id
                                          and c.id = payment_links.contact_id and c.deleted_at is null)
                      end);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_links' and policyname = 'payment_links_update') then
    create policy payment_links_update on public.payment_links for update to authenticated
      using (app.can_record_payments(organization_id) and app.org_writable(organization_id)
             and case when payment_links.quote_id is not null
                      then exists (select 1 from public.quotes q where q.organization_id = payment_links.organization_id and q.id = payment_links.quote_id)
                      when payment_links.order_id is not null
                      then exists (select 1 from public.orders o where o.organization_id = payment_links.organization_id and o.id = payment_links.order_id)
                      when payment_links.accounting_document_id is not null
                      then exists (select 1 from public.accounting_documents d
                                    where d.organization_id = payment_links.organization_id and d.id = payment_links.accounting_document_id)
                      else exists (select 1 from public.contacts c where c.organization_id = payment_links.organization_id and c.id = payment_links.contact_id)
                 end)
      with check (app.can_record_payments(organization_id) and app.org_writable(organization_id));
  end if;
  -- no delete policy and no delete grant: a link is cancelled, never deleted
end;
$$;

-- The server's values and the rules of a change (every writer)
create or replace function app.payment_links_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_today date;
  v_open bigint;
  v_title text;
  v_ok boolean;
  v_count integer;
  v_key text;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record payments here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if num_nonnulls(new.quote_id, new.order_id, new.accounting_document_id, new.contact_id) <> 1 then
      raise exception 'a payment link has exactly one source' using errcode = 'P0001', hint = 'payment_link:source';
    end if;

    select coalesce(o.timezone, 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = new.organization_id;
    v_today := (now() at time zone v_zone)::date;

    -- the source: still open, and how much of it is open
    if new.quote_id is not null then
      v_key := 'quotes';
      select q.total_agorot,
             'מקדמה להצעת מחיר' || coalesce(' ' || q.number_display, ''),
             q.customer_deleted_at is null
               and (q.status = 'accepted' or (q.status in ('sent', 'viewed') and (q.valid_until is null or q.valid_until >= v_today)))
        into v_open, v_title, v_ok
        from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
    elsif new.order_id is not null then
      v_key := 'orders';
      select o.total_agorot,
             'תשלום להזמנה' || coalesce(' ' || o.number_display, ''),
             o.status not in ('draft', 'cancelled') and o.customer_deleted_at is null
        into v_open, v_title, v_ok
        from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
    elsif new.accounting_document_id is not null then
      v_key := 'documents';
      select case when d.status = 'active'
                       and (d.doc_type in ('tax_invoice', 'proforma') or (d.doc_type = 'opening_balance' and d.amount_agorot > 0))
                  then app.document_balance(d.organization_id, d.id) end,
             'תשלום ל' || app.document_type_label(d.doc_type) || coalesce(' ' || d.number, ''),
             d.status = 'active'
        into v_open, v_title, v_ok
        from public.accounting_documents d where d.organization_id = new.organization_id and d.id = new.accounting_document_id;
      v_ok := case when v_ok is not null then v_ok and coalesce(v_open, 0) > 0 end;
    else
      select c.deleted_at is null, 'תשלום'
        into v_ok, v_title
        from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id;
      v_open := null;
    end if;
    -- a source that is not in this business: the composite FK (and RLS) refuse it, revealing nothing
    if v_ok is null then
      return new;
    end if;
    -- the plan keys: payments and payment links, then the source's own
    if not app.org_has_feature(new.organization_id, 'payments') then
      raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
    end if;
    if not app.org_has_feature(new.organization_id, 'payment_links') then
      raise exception 'payment links are not in the plan' using errcode = 'P0001', hint = 'feature:payment_links';
    end if;
    -- the source's own plan key (a quote needs `quotes`, an order `orders`, a document `documents`)
    if v_key is not null and not app.org_has_feature(new.organization_id, v_key) then
      raise exception 'the source''s module is not in the plan' using errcode = 'P0001', hint = 'feature:' || v_key;
    end if;
    if not v_ok then
      raise exception 'the source is not open for payment' using errcode = 'P0001', hint = 'payment_link:source_state';
    end if;
    if v_open is not null and new.amount_agorot > v_open then
      raise exception 'the amount is more than is open' using errcode = 'P0001', hint = 'payment_link:over';
    end if;

    -- the last day: today .. +90 days in the business zone; the link stops at the end of that day
    if new.expires_on is null or new.expires_on < v_today or new.expires_on > v_today + 90 then
      raise exception 'the last day is today up to 90 days ahead' using errcode = 'P0001', hint = 'payment_link:expires';
    end if;
    new.expires_at := ((new.expires_on + 1)::timestamp at time zone v_zone);

    -- at most 20 pending links per source (one lock per business: counts never race)
    perform pg_advisory_xact_lock(hashtextextended('payment_links:' || new.organization_id::text, 0));
    select count(*) into v_count
      from public.payment_links l
     where l.organization_id = new.organization_id and l.status = 'pending' and l.expires_at > now()
       and l.quote_id is not distinct from new.quote_id and l.order_id is not distinct from new.order_id
       and l.accounting_document_id is not distinct from new.accounting_document_id
       and l.contact_id is not distinct from new.contact_id;
    if v_count >= 20 then
      raise exception 'too many open payment links on this source' using errcode = 'P0001', hint = 'payment_link:max';
    end if;

    -- the server's columns
    new.title := v_title;
    new.currency := 'ILS';
    new.status := 'pending';
    new.status_at := now();
    new.payment_id := null;
    new.paid_at := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.hosted_url := null;
    -- LNK-01: the fake provider's id is fixed by the link (no page); a real provider's comes from the worker
    new.provider_link_id := case when new.provider = 'fake' then 'fake_' || new.id::text end;
    new.created_by := coalesce(auth.uid(), new.created_by);
    return new;
  end if;

  -- UPDATE. A purged payment clears payment_id through its composite FK (a nested trigger): only that passes
  if pg_trigger_depth() > 1 and new.payment_id is null and old.payment_id is not null
     and (to_jsonb(new) - 'payment_id' - 'updated_at') = (to_jsonb(old) - 'payment_id' - 'updated_at') then
    return new;
  end if;
  -- a merge moves a free link to the kept contact (app.merge_payment_links sets 'merge'): only contact_id changes
  if current_setting('app.payment_link_server', true) = 'merge'
     and (to_jsonb(new) - 'contact_id' - 'updated_at') = (to_jsonb(old) - 'contact_id' - 'updated_at') then
    return new;
  end if;
  -- the server's status changes (expiry; later the provider's webhook): from pending only, never back
  if current_setting('app.payment_link_server', true) = 'on' and auth.uid() is null then
    if old.status <> 'pending' or new.status not in ('expired', 'paid', 'failed')
       or (to_jsonb(new) - 'status' - 'status_at' - 'payment_id' - 'paid_at' - 'updated_at')
          <> (to_jsonb(old) - 'status' - 'status_at' - 'payment_id' - 'paid_at' - 'updated_at') then
      raise exception 'a payment link moves only from pending' using errcode = 'P0001', hint = 'payment_link:closed';
    end if;
    new.status_at := now();
    return new;
  end if;

  -- a person: only cancelling a pending link
  -- (the currency is held to 'ILS' by its own check until DEAL-12)
  if (to_jsonb(new) - 'status' - 'currency' - 'updated_at') <> (to_jsonb(old) - 'status' - 'currency' - 'updated_at') then
    raise exception 'a payment link does not change' using errcode = 'P0001', hint = 'payment_link:frozen';
  end if;
  if new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'a finished payment link stays as it is' using errcode = 'P0001', hint = 'payment_link:closed';
    end if;
    if new.status <> 'cancelled' then
      raise exception 'a person only cancels a payment link' using errcode = 'P0001', hint = 'payment_link:frozen';
    end if;
    new.cancelled_at := now();
    new.cancelled_by := auth.uid();
    new.status_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.payment_links_check() from public, anon, authenticated, service_role;

create or replace trigger payment_links_check before insert or update on public.payment_links
  for each row execute function app.payment_links_check();
create or replace trigger payment_links_touch before insert or update on public.payment_links
  for each row execute function app.touch_row();
create or replace trigger payment_links_audit after insert or update or delete on public.payment_links
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- Expiry: a pending link past its last day becomes expired (pg_cron `crm-payment-link-expiry`, every 15 minutes)
-- ----------------------------------------------------------------------------
create or replace function app.expire_payment_links(p_limit integer default 2000) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_server text := current_setting('app.payment_link_server', true);
  v_count integer;
begin
  perform set_config('app.payment_link_server', 'on', true);
  with due as (
    select l.id from public.payment_links l
     where l.status = 'pending' and l.expires_at <= now()
     order by l.expires_at, l.id
     limit greatest(coalesce(p_limit, 2000), 1)
     for update skip locked)
  update public.payment_links l set status = 'expired'
    from due where l.id = due.id;
  get diagnostics v_count = row_count;
  perform set_config('app.payment_link_server', coalesce(v_server, ''), true);
  return v_count;
end;
$$;
revoke all on function app.expire_payment_links(integer) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-payment-link-expiry', '*/15 * * * *', 'select app.expire_payment_links();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- A contact merge moves the duplicate's free links (through the `merged` entry, as PAY-01 did; app.merge_move_links is
-- shared ground)
-- ----------------------------------------------------------------------------
create or replace function app.merge_payment_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_server text;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.contact_id is not null and v_merged <> new.contact_id
     and exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id) then
    v_server := current_setting('app.payment_link_server', true);
    perform set_config('app.payment_link_server', 'merge', true);
    update public.payment_links l set contact_id = new.contact_id
     where l.organization_id = new.organization_id and l.contact_id = v_merged;
    perform set_config('app.payment_link_server', coalesce(v_server, ''), true);
  end if;
  return null;
end;
$$;
revoke all on function app.merge_payment_links() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_payment_links after insert on public.activities
  for each row
  when (new.type = 'system' and new.contact_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_payment_links();
