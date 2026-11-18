-- =============================================================================
-- LNK-04: a payment made through a link, by the payment provider's signed webhook
-- =============================================================================
-- Wave 3 use (2) of hard rule 5 (owner, 26 October 2026): one inbound webhook per provider, refused before the database and
-- without logging the body when the signature is not valid. The route (src/features/payment-links/webhook-server.ts, route
-- POST /api/payments/<provider>/webhook) checks the provider adapter's verifyWebhook FIRST and only then calls, with the
-- service key, the one function below. Only the fake provider exists (owner (270) (1) א).
--
-- public.payment_link_webhook(provider, event) (service_role only):
--   * the event is ids and codes only: {event_id, provider_link_id, status, paid_agorot, currency, provider_payment_id,
--     installments}; a malformed one answers {status: invalid} (the route answers 400), and so does a paid event without the
--     paid amount, its currency or the provider's payment id (review 1, 5).
--   * a paid event is taken only when it paid exactly the link's amount in ILS within the link's instalments; anything else
--     records no payment (outcome amount_mismatch) and tells the owners and admins to check at the provider (review 1).
--   * a paid event for an unknown or ambiguous link writes one app.platform_log line `payment_link.webhook_unknown` (ids and
--     codes only; review 6).
--   * a provider this database does not accept (app.payment_link_provider_usable: the fake only while app.settings
--     `payment_links_fake` is 'on') is ignored.
--   * at most 3,000 events a minute in total (app.payment_webhook_minutes, 60 reused rows), then {status: busy} (503: the
--     provider sends it again).
--   * exactly once per provider event id (app.payment_webhook_events, primary key provider + event id): a repeat answers
--     {status: duplicate}. The row is written in the same transaction as the payment, so a failure leaves nothing and the
--     provider's retry is taken.
--   * only a PENDING link is ever paid: the link is found by its provider id, locked; a status other than paid is kept as an
--     event only (failed and abandoned links are LNK-05, not built); a paid event for a link that is not pending records no
--     payment and tells the active owners and admins to check at the provider (the money may have been taken), unless the same
--     provider payment already paid it.
--   * a paid pending link: one `public.payments` row, confirmed, method credit with the instalments the provider answered,
--     dated today in the business zone, the provider's payment id as its reference, written as the server (no recorder: the
--     PAY-07 notice goes to the record's owner). Its parent is the link's source: a quote's deal and contact, an advance for the
--     quote (PAY-03); an order's deal and contact with order_id (ORD-06); a document's deal and contact; a contact. When the
--     source is an open tax invoice, proforma or opening debt, the payment is allocated to it, up to its balance (PAY-02's
--     check judges it; a refusal keeps the payment unallocated). The link becomes paid (payment_id, paid_at,
--     provider_payment_id). A payment the database refuses (no deal or contact left on the source) still marks the link paid
--     and tells the owners and admins to record it by hand.
-- Issuing a document after the payment (the rest of LNK-04: by the business's setting, or taking the provider's own) waits for
-- the invoice provider's choice; not built here. Every statement is safe to run twice. No drops, no row removal.

alter table public.payment_links add column if not exists provider_payment_id text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_links_provider_payment_shape') then
    alter table public.payment_links add constraint payment_links_provider_payment_shape
      check (provider_payment_id is null or provider_payment_id ~ '^[A-Za-z0-9_.:-]{1,128}$') not valid;
  end if;
end;
$$;
alter table public.payment_links validate constraint payment_links_provider_payment_shape;
-- LNK-07: a link's payment is found by its id (the refund's claim)
create index if not exists payment_links_paid_payment_idx on public.payment_links (organization_id, payment_id) where status = 'paid';
-- review 6: the webhook finds a link by the provider's id, across businesses
create index if not exists payment_links_provider_link_idx on public.payment_links (provider, provider_link_id);

-- ----------------------------------------------------------------------------
-- What the webhook keeps: one row per provider event (ids and codes), and the minute counters
-- ----------------------------------------------------------------------------
create table if not exists app.payment_webhook_events (
  provider         text not null check (provider in ('fake')),
  event_id         text not null check (event_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  organization_id  uuid references public.organizations (id) on delete cascade,
  link_id          uuid,
  status           text not null check (status in ('pending', 'paid', 'failed', 'expired', 'cancelled')),
  outcome          text not null default 'received'
                   check (outcome in ('received', 'recorded', 'paid_unrecorded', 'already_paid', 'paid_not_open', 'unknown_link',
                                      'ambiguous_link', 'not_handled', 'amount_mismatch')),
  payment_id       uuid,
  received_at      timestamptz not null default now(),
  primary key (provider, event_id)
);
create index if not exists payment_webhook_events_org_idx on app.payment_webhook_events (organization_id, received_at);
alter table app.payment_webhook_events enable row level security;
revoke all on app.payment_webhook_events from public, anon, authenticated, service_role;

create table if not exists app.payment_webhook_minutes (
  slot    smallint primary key check (slot between 0 and 59),
  minute  timestamptz not null,
  hits    integer not null default 0
);
alter table app.payment_webhook_minutes enable row level security;
revoke all on app.payment_webhook_minutes from public, anon, authenticated, service_role;

create or replace function app.payment_webhook_limit() returns integer
language sql immutable
set search_path = ''
as $$ select 3000 $$;
revoke all on function app.payment_webhook_limit() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rules of a link (every writer): 021315's body, plus the provider's payment id (server only, on a paid link)
-- ----------------------------------------------------------------------------
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
  v_pending bigint;
  v_balance bigint;
  v_seen text;
begin
  -- outsider guard on INSERT: RLS refuses (42501) a person who may not record payments here, before anything is revealed.
  -- (An UPDATE by such a person never reaches this trigger: payment_links_update's USING needs the same rights; the
  -- server's merge and FK paths below are judged by their own branches.)
  if tg_op = 'INSERT' and auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if num_nonnulls(new.quote_id, new.order_id, new.accounting_document_id, new.contact_id) <> 1 then
      raise exception 'a payment link has exactly one source' using errcode = 'P0001', hint = 'payment_link:source';
    end if;
    -- finding 4: the fake provider only where app.settings `payment_links_fake` = 'on' (never on the hosted project)
    if new.provider = 'fake'
       and coalesce((select s.value from app.settings s where s.key = 'payment_links_fake'), '') <> 'on' then
      raise exception 'the fake payment provider is off here' using errcode = 'P0001', hint = 'payment_link:provider';
    end if;

    select coalesce(o.timezone, 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = new.organization_id;
    v_today := (now() at time zone v_zone)::date;

    -- the source: open by the one rule, and how much of it is open (the total of a quote or order, a document's balance)
    v_ok := app.payment_link_source_open(new.organization_id, new.quote_id, new.order_id, new.accounting_document_id, new.contact_id);
    if new.quote_id is not null then
      v_key := 'quotes';
      select q.total_agorot, 'מקדמה להצעת מחיר' || coalesce(' ' || q.number_display, '')
        into v_open, v_title
        from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
    elsif new.order_id is not null then
      v_key := 'orders';
      select o.total_agorot, 'תשלום להזמנה' || coalesce(' ' || o.number_display, '')
        into v_open, v_title
        from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
    elsif new.accounting_document_id is not null then
      v_key := 'documents';
      select case when v_ok then app.document_balance(d.organization_id, d.id) end,
             'תשלום ל' || app.document_type_label(d.doc_type) || coalesce(' ' || d.number, '')
        into v_open, v_title
        from public.accounting_documents d where d.organization_id = new.organization_id and d.id = new.accounting_document_id;
    else
      v_title := 'תשלום';
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
    -- delta review 1: a person who sees only part of a document's money gets one neutral answer
    if new.accounting_document_id is not null and auth.uid() is not null then
      v_balance := app.document_balance(new.organization_id, new.accounting_document_id);
      v_seen := current_setting('app.payment_link_caller_balance', true);
      if v_seen is null or split_part(v_seen, ':', 1) <> new.id::text
         or nullif(split_part(v_seen, ':', 2), '')::bigint is distinct from v_balance then
        raise exception 'part of this document''s money is hidden from you' using errcode = 'P0001', hint = 'payment_link:partial';
      end if;
    end if;
    if not v_ok then
      raise exception 'the source is not open for payment' using errcode = 'P0001', hint = 'payment_link:source_state';
    end if;
    -- LNK-04 review (9): a payment needs a deal or a contact, so a source with neither (a company's document or order) takes
    -- no link (its payment could never be recorded)
    if not coalesce(case when new.quote_id is not null
                         then (select q.deal_id is not null or q.contact_id is not null from public.quotes q
                                where q.organization_id = new.organization_id and q.id = new.quote_id)
                         when new.order_id is not null
                         then (select o.deal_id is not null or o.contact_id is not null from public.orders o
                                where o.organization_id = new.organization_id and o.id = new.order_id)
                         when new.accounting_document_id is not null
                         then (select d.deal_id is not null or d.contact_id is not null from public.accounting_documents d
                                where d.organization_id = new.organization_id and d.id = new.accounting_document_id)
                         else true end, false) then
      raise exception 'the source has no deal or contact for the payment' using errcode = 'P0001', hint = 'payment_link:no_customer';
    end if;
    -- the last day: today .. +90 days in the business zone; the link stops at the end of that day
    if new.expires_on is null or new.expires_on < v_today or new.expires_on > v_today + 90 then
      raise exception 'the last day is today up to 90 days ahead' using errcode = 'P0001', hint = 'payment_link:expires';
    end if;
    new.expires_at := ((new.expires_on + 1)::timestamp at time zone v_zone);

    -- at most 20 pending links per source (one lock per business: counts never race)
    perform pg_advisory_xact_lock(hashtextextended('payment_links:' || new.organization_id::text, 0));
    select count(*), coalesce(sum(l.amount_agorot), 0) into v_count, v_pending
      from public.payment_links l
     where l.organization_id = new.organization_id and l.status = 'pending' and l.expires_at > now()
       and l.quote_id is not distinct from new.quote_id and l.order_id is not distinct from new.order_id
       and l.accounting_document_id is not distinct from new.accounting_document_id
       and l.contact_id is not distinct from new.contact_id;
    if v_count >= 20 then
      raise exception 'too many open payment links on this source' using errcode = 'P0001', hint = 'payment_link:max';
    end if;
    -- delta review 2: a quote's or an order's links already paid count too (a document's balance already holds its payments)
    if new.quote_id is not null or new.order_id is not null then
      v_pending := v_pending + coalesce((
        select sum(l.amount_agorot) from public.payment_links l
         where l.organization_id = new.organization_id and l.status = 'paid'
           and l.quote_id is not distinct from new.quote_id and l.order_id is not distinct from new.order_id), 0);
    end if;
    -- finding 2: this link and the source's other pending links together never pass what is open
    if v_open is not null and new.amount_agorot > v_open - v_pending then
      raise exception 'the amount is more than is open' using errcode = 'P0001', hint = 'payment_link:over';
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
    new.closed_reason := null;
    new.source_checked_at := null;
    new.hosted_url := null;
    -- LNK-02: the page is the worker's (public.payment_link_page_record)
    new.page_created_at := null;
    new.page_error_code := null;
    -- LNK-04: the provider's payment id is the webhook's (public.payment_link_webhook)
    new.provider_payment_id := null;
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
  -- LNK-02: the worker's record of the provider's page (public.payment_link_page_record sets 'page'): once, on a pending
  -- link, only the provider's id, the page's address, the time and the last error code; or the error code alone (a retry)
  if current_setting('app.payment_link_server', true) = 'page' and auth.uid() is null then
    if old.status <> 'pending' or new.status <> 'pending' or old.page_created_at is not null
       or (to_jsonb(new) - 'provider_link_id' - 'hosted_url' - 'page_created_at' - 'page_error_code' - 'updated_at')
          <> (to_jsonb(old) - 'provider_link_id' - 'hosted_url' - 'page_created_at' - 'page_error_code' - 'updated_at')
       or (old.provider_link_id is not null and new.provider_link_id is distinct from old.provider_link_id) then
      raise exception 'the provider''s page is recorded once, on a pending link' using errcode = 'P0001', hint = 'payment_link:closed';
    end if;
    return new;
  end if;
  -- the server's status changes (expiry, a closed source; later the provider's webhook): from pending only, never back
  if current_setting('app.payment_link_server', true) = 'on' and auth.uid() is null then
    -- the closing job stamps a pending link it judged still open (only that column)
    if old.status = 'pending' and new.status = 'pending'
       and (to_jsonb(new) - 'source_checked_at' - 'updated_at') = (to_jsonb(old) - 'source_checked_at' - 'updated_at') then
      return new;
    end if;
    if old.status <> 'pending' or new.status not in ('expired', 'paid', 'failed', 'cancelled')
       or (to_jsonb(new) - 'status' - 'status_at' - 'payment_id' - 'paid_at' - 'cancelled_at' - 'closed_reason' - 'source_checked_at' - 'page_error_code' - 'provider_payment_id' - 'updated_at')
          <> (to_jsonb(old) - 'status' - 'status_at' - 'payment_id' - 'paid_at' - 'cancelled_at' - 'closed_reason' - 'source_checked_at' - 'page_error_code' - 'provider_payment_id' - 'updated_at') then
      raise exception 'a payment link moves only from pending' using errcode = 'P0001', hint = 'payment_link:closed';
    end if;
    new.status_at := now();
    if new.status = 'cancelled' then
      new.cancelled_at := now();
      new.cancelled_by := null;
      -- LNK-02: a link whose page could not be made is closed 'page_failed'; every other server cancel is a closed source
      new.closed_reason := case when new.closed_reason = 'page_failed' then 'page_failed' else 'source_closed' end;
    else
      new.cancelled_at := null;
      new.closed_reason := null;
    end if;
    -- LNK-04: the provider's payment id only on a paid link
    if new.status <> 'paid' then
      new.provider_payment_id := null;
    end if;
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

-- ----------------------------------------------------------------------------
-- The webhook's one function (service_role only)
-- ----------------------------------------------------------------------------
create or replace function public.payment_link_webhook(p_provider text, p_event jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_event_id text;
  v_link_ref text;
  v_status text;
  v_paid bigint;
  v_payment_ref text;
  v_currency text;
  v_installments integer;
  v_minute timestamptz := date_trunc('minute', now());
  v_hits integer;
  v_inserted boolean;
  v_count integer;
  v_link public.payment_links;
  v_today date;
  v_deal uuid;
  v_contact uuid;
  v_order uuid;
  v_quote uuid;
  v_payment uuid;
  v_balance bigint;
  v_state text;
  v_server text;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_event_id := p_event ->> 'event_id';
  v_link_ref := p_event ->> 'provider_link_id';
  v_status := p_event ->> 'status';
  v_payment_ref := nullif(p_event ->> 'provider_payment_id', '');
  v_currency := nullif(p_event ->> 'currency', '');
  if coalesce(v_event_id, '') !~ '^[A-Za-z0-9_.:-]{1,128}$' or coalesce(v_link_ref, '') !~ '^[A-Za-z0-9_.:-]{1,128}$'
     or coalesce(v_status, '') not in ('pending', 'paid', 'failed', 'expired', 'cancelled')
     or (v_payment_ref is not null and v_payment_ref !~ '^[A-Za-z0-9_.:-]{1,128}$')
     or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
     or (p_event ? 'paid_agorot' and jsonb_typeof(p_event -> 'paid_agorot') not in ('number', 'null'))
     or (p_event ? 'installments' and jsonb_typeof(p_event -> 'installments') not in ('number', 'null')) then
    return jsonb_build_object('status', 'invalid');
  end if;
  begin
    v_paid := (p_event ->> 'paid_agorot')::bigint;
    v_installments := (p_event ->> 'installments')::integer;
  exception when others then
    return jsonb_build_object('status', 'invalid');
  end;
  if (v_paid is not null and v_paid not between 1 and 1000000000000) or (v_installments is not null and v_installments not between 1 and 36) then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- review 1, 5: a paid event names what was paid, in which currency, and the provider's payment
  if v_status = 'paid' and (v_paid is null or v_currency is null or v_payment_ref is null) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not app.payment_link_provider_usable(p_provider) then
    return jsonb_build_object('status', 'ignored');
  end if;

  -- 3,000 events a minute in total, one row per minute of the hour (reused)
  insert into app.payment_webhook_minutes as m (slot, minute, hits)
  values (extract(minute from v_minute)::smallint, v_minute, 1)
  on conflict (slot) do update
     set hits = case when m.minute = excluded.minute then m.hits + 1 else 1 end, minute = excluded.minute
  returning hits into v_hits;
  if v_hits > app.payment_webhook_limit() then
    return jsonb_build_object('status', 'busy');
  end if;

  -- once per provider event
  insert into app.payment_webhook_events (provider, event_id, status)
  values (p_provider, v_event_id, v_status)
  on conflict (provider, event_id) do nothing
  returning true into v_inserted;
  if not coalesce(v_inserted, false) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  select count(*) into v_count from public.payment_links l where l.provider = p_provider and l.provider_link_id = v_link_ref;
  if v_count <> 1 then
    update app.payment_webhook_events e set outcome = case when v_count = 0 then 'unknown_link' else 'ambiguous_link' end
     where e.provider = p_provider and e.event_id = v_event_id;
    -- review 6: a paid event nobody can take is logged (ids and codes only)
    if v_status = 'paid' then
      insert into app.platform_log (action, details)
      values ('payment_link.webhook_unknown',
              jsonb_build_object('provider', p_provider, 'event_id', v_event_id, 'provider_link_id', v_link_ref,
                                 'outcome', case when v_count = 0 then 'unknown_link' else 'ambiguous_link' end));
    end if;
    return jsonb_build_object('status', 'ignored');
  end if;
  select * into v_link from public.payment_links l where l.provider = p_provider and l.provider_link_id = v_link_ref for update;
  update app.payment_webhook_events e set organization_id = v_link.organization_id, link_id = v_link.id
   where e.provider = p_provider and e.event_id = v_event_id;

  if v_status <> 'paid' then
    -- failed and abandoned links are LNK-05's (not built): kept as an event only
    update app.payment_webhook_events e set outcome = 'not_handled' where e.provider = p_provider and e.event_id = v_event_id;
    return jsonb_build_object('status', 'ignored');
  end if;
  if v_link.status = 'paid' and v_link.provider_payment_id = v_payment_ref then
    update app.payment_webhook_events e set outcome = 'already_paid' where e.provider = p_provider and e.event_id = v_event_id;
    return jsonb_build_object('status', 'duplicate');
  end if;
  if v_link.status <> 'pending' then
    update app.payment_webhook_events e set outcome = 'paid_not_open' where e.provider = p_provider and e.event_id = v_event_id;
    perform app.payment_link_notice(v_link.organization_id, null, 'שולם קישור תשלום שכבר לא היה פתוח',
      'ספק הסליקה דיווח על תשלום בקישור' || coalesce(' "' || left(v_link.title, 120) || '"', '')
      || ', שכבר לא היה פתוח (בוטל, פג תוקף או שולם). התשלום לא נרשם במערכת. בדקו אצל ספק הסליקה, ורשמו את התשלום ידנית או החזירו אותו.');
    return jsonb_build_object('status', 'ignored');
  end if;
  -- review 1: exactly the link's amount, in ILS, within its instalments; anything else is not taken
  if v_currency <> 'ILS' or v_paid <> v_link.amount_agorot or coalesce(v_installments, 1) > v_link.max_installments then
    update app.payment_webhook_events e set outcome = 'amount_mismatch' where e.provider = p_provider and e.event_id = v_event_id;
    perform app.payment_link_notice(v_link.organization_id, null, 'תשלום בקישור לא תאם את הקישור',
      'ספק הסליקה דיווח על תשלום בקישור' || coalesce(' "' || left(v_link.title, 120) || '"', '')
      || ' בסכום, במטבע או במספר תשלומים שלא תואמים את הקישור. התשלום לא נרשם במערכת. בדקו אצל ספק הסליקה, ורשמו את התשלום ידנית או החזירו אותו.');
    return jsonb_build_object('status', 'ignored');
  end if;

  -- the payment, as the server, on the link's source
  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = v_link.organization_id;
  if v_link.quote_id is not null then
    select q.deal_id, q.contact_id into v_deal, v_contact from public.quotes q
     where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
    v_quote := v_link.quote_id;
  elsif v_link.order_id is not null then
    select o.deal_id, o.contact_id into v_deal, v_contact from public.orders o
     where o.organization_id = v_link.organization_id and o.id = v_link.order_id;
    v_order := v_link.order_id;
  elsif v_link.accounting_document_id is not null then
    select d.deal_id, d.contact_id into v_deal, v_contact from public.accounting_documents d
     where d.organization_id = v_link.organization_id and d.id = v_link.accounting_document_id;
  else
    v_contact := v_link.contact_id;
  end if;
  begin
    insert into public.payments
      (organization_id, deal_id, contact_id, amount_agorot, paid_on, method, installments, reference, note, status,
       order_id, is_advance, advance_quote_id)
    values
      (v_link.organization_id, v_deal, v_contact, v_paid, coalesce(v_today, current_date), 'credit',
       coalesce(v_installments, 1), left(v_payment_ref, 100), 'שולם בקישור תשלום', 'confirmed',
       v_order, v_quote is not null, v_quote)
    returning id into v_payment;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    -- a deadlock, a serialization failure or a lock not taken: the provider sends the event again
    if v_state in ('40P01', '40001', '55P03') then
      raise;
    end if;
    v_payment := null;
  end;
  if v_payment is not null and v_link.accounting_document_id is not null then
    v_balance := app.document_balance(v_link.organization_id, v_link.accounting_document_id);
    if coalesce(v_balance, 0) > 0 then
      begin
        insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
        values (v_link.organization_id, v_payment, v_link.accounting_document_id, least(v_balance, v_paid));
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate;
        if v_state in ('40P01', '40001', '55P03') then
          raise;
        end if;
      end;
    end if;
  end if;

  v_server := current_setting('app.payment_link_server', true);
  perform set_config('app.payment_link_server', 'on', true);
  update public.payment_links l
     set status = 'paid', payment_id = v_payment, paid_at = now(), provider_payment_id = v_payment_ref
   where l.organization_id = v_link.organization_id and l.id = v_link.id;
  perform set_config('app.payment_link_server', coalesce(v_server, ''), true);
  update app.payment_webhook_events e
     set outcome = case when v_payment is null then 'paid_unrecorded' else 'recorded' end, payment_id = v_payment
   where e.provider = p_provider and e.event_id = v_event_id;
  if v_payment is null then
    perform app.payment_link_notice(v_link.organization_id, null, 'תשלום בקישור לא נרשם',
      'הלקוח שילם בקישור' || coalesce(' "' || left(v_link.title, 120) || '"', '')
      || ', אבל לא הצלחנו לרשום את התשלום (המסמך או הלקוח כבר לא מקושרים). רשמו את התשלום ידנית.');
    return jsonb_build_object('status', 'paid_unrecorded');
  end if;
  return jsonb_build_object('status', 'recorded');
end;
$$;
revoke all on function public.payment_link_webhook(text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_link_webhook(text, jsonb) to service_role;
