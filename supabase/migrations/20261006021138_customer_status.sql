-- =============================================================================
-- CON-11: a computed customer status (active, dormant, former) by last purchase, and cumulative customer value
-- =============================================================================
-- Spec (SPEC-ADDITIONS, CON-11, wave 3): "סטטוס לקוח מחושב (פעיל, רדום, לשעבר) לפי רכישה אחרונה, וערך לקוח מצטבר".
-- Owner, 2 November 2026: (57) א every plan, no key; (58) ב a purchase is a won deal or a counted payment; (59) א 6 and 18.
-- * A purchase is a won deal (report_revenue's won rule: status 'won', not in the recycle bin, with a close time; keep in
--   step) or a payment recorded or confirmed (never cancelled, failed or refunded). Opening balances never count (they are
--   documents, not payments). A payment moves only the last-purchase date: the value stays the sum of the won deals, so a
--   deal's own payments are never counted twice and a payment with no deal adds nothing.
-- * The customer is a contact or a company. A contact: deals whose contact it is; payments whose contact it is or whose deal's
--   contact it is. A company: deals of the company and deals with no company whose contact's primary company it is (not in
--   the bin); payments on those deals, and payments with no deal whose contact's primary company it is. A contact or company
--   with no purchase is not a customer: no status, no value. One rule, app.customer_purchases (invoker, public tables only).
-- * Status by whole calendar months since the last purchase's day in the business's time zone (a deal's close day; a
--   payment's paid_on): active, then dormant from the day `dormant_months` months after it, then former from the day
--   `former_months` months after it. Defaults 6 and 18, per business in public.customer_status_settings (no row = the
--   defaults). Month steps clamp to the month's end, as PostgreSQL's date + interval does: the pure rule
--   app.customer_status_rule = customerStatusRule() in src/features/customer-status/status.ts, both run
--   tests/unit/fixtures/customer-status.json.
-- * Value = the sum of the won deals' stored amounts (amount_agorot, as report_revenue sums them: each deal in its own VAT
--   mode, no VAT added or removed); a won deal with an amount of 0 counts as a deal and adds nothing (`deals_without_amount`).
-- * The card (public.customer_summary) is computed when read, under the caller's RLS (invoker), through index-driven queries.
--   BAL-01's partial rule: when the caller does not read every one of the customer's purchases (app.customer_purchase_count,
--   definer, a count only, members only), the answer is partial: no status and no value of any kind, since a hidden later
--   purchase would change both. Accepted (as BAL-01's app.customer_money_rows): the count tells a member whether hidden
--   purchases exist (never which or how much); a readable company-less deal whose contact the caller cannot read makes the
--   company's card partial (fails safe). Only the contact's primary company (contacts.company_id) gathers its company-less
--   deals and deal-less payments, not the other companies of CON-05's contact_companies.
-- * The lists (columns, sort, filter, export), the dormant list and the dormant scan read facts kept per customer
--   (app.customer_purchase_facts, below), for owners and admins only.
-- * app.export_choice_values (last redefined in 021076) gains the status codes, so an export's audit filter keeps them.
-- * A payment whose deal is in the recycle bin counts for no customer (the contact and the company paths alike).
-- Accepted (for CLAUDE.md):
--   - a readable company-less deal (or deal-less payment) whose contact the caller cannot read makes the company's card partial
--     (fails safe);
--   - app.customer_purchase_count tells a member whether a customer has purchases hidden from them (never which or how much),
--     as BAL-01's app.customer_money_rows;
--   - CON-05: only the contact's primary company (contacts.company_id) gathers its company-less deals and deal-less payments;
--   - a change of the business's time zone moves the kept last days lazily, at each customer's next refresh;
--   - the list fields (status, value, last purchase), sort, status filter, list export columns, the dormant list and the
--     dormant scan read the business-wide kept facts, for owners and admins only; everyone sees the card;
--   - the list fields check the membership with a plain read, not app.membership_role (see "Computed fields for the lists");
--   - a contact delete's cascade (a purge, a merge) and a kept-facts refresh can rarely meet in 40P01, as PAY-03's purge case
--     (both take the business lock 'customer_credit:<org>' at commit; the delete's own row locks come first).
-- Additive only. Safe to run twice.

-- ----------------------------------------------------------------------------
-- The business's thresholds
-- ----------------------------------------------------------------------------
create table if not exists public.customer_status_settings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  dormant_months   smallint not null default 6,
  former_months    smallint not null default 18,
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint customer_status_settings_dormant_range check (dormant_months between 1 and 60),
  constraint customer_status_settings_former_range check (former_months between 2 and 120),
  constraint customer_status_settings_order check (former_months > dormant_months)
);

create or replace trigger customer_status_settings_touch before insert or update on public.customer_status_settings
  for each row execute function app.touch_row();
create or replace trigger customer_status_settings_audit after insert or update or delete on public.customer_status_settings
  for each row execute function app.audit_row();

alter table public.customer_status_settings enable row level security;
revoke all on public.customer_status_settings from anon, authenticated;
grant select on public.customer_status_settings to authenticated;
grant insert (organization_id, dormant_months, former_months) on public.customer_status_settings to authenticated;
grant update (dormant_months, former_months) on public.customer_status_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_status_settings'
                   and policyname = 'customer_status_settings_select') then
    create policy customer_status_settings_select on public.customer_status_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_status_settings'
                   and policyname = 'customer_status_settings_insert') then
    create policy customer_status_settings_insert on public.customer_status_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_status_settings'
                   and policyname = 'customer_status_settings_update') then
    create policy customer_status_settings_update on public.customer_status_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The pure rule (= customerStatusRule() in src/features/customer-status/status.ts)
-- ----------------------------------------------------------------------------
create or replace function app.customer_status_rule(p_last date, p_today date, p_dormant integer, p_former integer)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_last is null or p_today is null or p_dormant is null or p_former is null then null
    when p_today >= (p_last + make_interval(months => p_former))::date then 'former'
    when p_today >= (p_last + make_interval(months => p_dormant))::date then 'dormant'
    else 'active'
  end
$$;
revoke all on function app.customer_status_rule(date, date, integer, integer) from public, anon;
grant execute on function app.customer_status_rule(date, date, integer, integer) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The one purchase rule: a customer's won deals and counted payments, as whoever runs it may read them (invoker; read
-- under RLS from the invoker functions below, in full from the definer ones). Public tables only. PL/pgSQL with one
-- branch per customer kind, so every query is driven by an index with a plain uuid `=` (leakproof, so an index condition
-- under RLS too; CLAUDE.md "Indexes under RLS"): deals and payments by contact_id, company_id or deal_id, never an OR
-- over parameters that a generic plan cannot drop.
-- ----------------------------------------------------------------------------
create or replace function app.customer_purchases(p_org uuid, p_contact uuid, p_company uuid)
returns table (kind text, day date, amount_agorot bigint)
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_zone text := coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem');
  v_contacts uuid[];
  v_deals uuid[];
begin
  if p_contact is not null then
    v_deals := array(select d.id from public.deals d
                      where d.organization_id = p_org and d.contact_id = p_contact and d.deleted_at is null);
    return query
      select 'deal'::text, (d.closed_at at time zone v_zone)::date, d.amount_agorot::bigint
        from public.deals d
       where d.organization_id = p_org and d.id = any (v_deals) and d.status = 'won' and d.closed_at is not null;
    -- the contact's own payments and its deals' payments, each payment once
    return query
      select 'payment'::text, p.paid_on, null::bigint
        from public.payments p
       where p.organization_id = p_org and p.status in ('recorded', 'confirmed')
         and p.id = any (array(
           select p2.id from public.payments p2 where p2.organization_id = p_org and p2.contact_id = p_contact
           union
           select p2.id from public.payments p2 where p2.organization_id = p_org and p2.deal_id = any (v_deals)))
         -- one rule in both paths: a payment whose deal is in the recycle bin does not count
         and (p.deal_id is null
              or not exists (select 1 from public.deals d
                              where d.organization_id = p_org and d.id = p.deal_id and d.deleted_at is not null));
  elsif p_company is not null then
    v_contacts := array(select c.id from public.contacts c
                         where c.organization_id = p_org and c.company_id = p_company and c.deleted_at is null);
    v_deals := array(
      select d.id from public.deals d
       where d.organization_id = p_org and d.company_id = p_company and d.deleted_at is null
      union all
      select d.id from public.deals d
       where d.organization_id = p_org and d.contact_id = any (v_contacts) and d.company_id is null and d.deleted_at is null);
    return query
      select 'deal'::text, (d.closed_at at time zone v_zone)::date, d.amount_agorot::bigint
        from public.deals d
       where d.organization_id = p_org and d.id = any (v_deals) and d.status = 'won' and d.closed_at is not null;
    return query
      select 'payment'::text, p.paid_on, null::bigint
        from public.payments p
       where p.organization_id = p_org and p.deal_id = any (v_deals) and p.status in ('recorded', 'confirmed')
      union all
      select 'payment'::text, p.paid_on, null::bigint
        from public.payments p
       where p.organization_id = p_org and p.contact_id = any (v_contacts) and p.deal_id is null
         and p.status in ('recorded', 'confirmed');
  end if;
end;
$$;
revoke all on function app.customer_purchases(uuid, uuid, uuid) from public, anon;
grant execute on function app.customer_purchases(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The partial rule's full count: every purchase of the customer, readable or not (a count only, members only)
-- ----------------------------------------------------------------------------
create or replace function app.customer_purchase_count(p_org uuid, p_contact uuid, p_company uuid)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then (select count(*) from app.customer_purchases(p_org, p_contact, p_company)) end
$$;
revoke all on function app.customer_purchase_count(uuid, uuid, uuid) from public, anon, authenticated, service_role;
-- the invoker functions below run it as the caller
grant execute on function app.customer_purchase_count(uuid, uuid, uuid) to authenticated;

-- the business's thresholds, no row = 6 and 18 (members read the table; the server reads it as the owner)
create or replace function app.customer_status_months(p_org uuid, out dormant_months integer, out former_months integer)
language sql stable security invoker
set search_path = ''
as $$
  select coalesce((select s.dormant_months from public.customer_status_settings s where s.organization_id = p_org), 6)::integer,
         coalesce((select s.former_months from public.customer_status_settings s where s.organization_id = p_org), 18)::integer
$$;
revoke all on function app.customer_status_months(uuid) from public, anon;
grant execute on function app.customer_status_months(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The facts as the caller reads them (invoker: RLS decides). One row, always.
-- ----------------------------------------------------------------------------
create or replace function app.customer_facts(p_org uuid, p_contact uuid, p_company uuid)
returns table (
  partial boolean, purchases bigint, deals bigint, payments bigint, deals_without_amount bigint, value_agorot bigint,
  first_purchase_on date, last_purchase_on date, today date, dormant_months integer, former_months integer)
language sql stable security invoker
set search_path = ''
as $$
  with bought as (
    select * from app.customer_purchases(p_org, p_contact, p_company)
  ), facts as (
    select count(*) as purchases,
           count(*) filter (where kind = 'deal') as deals,
           count(*) filter (where kind = 'payment') as payments,
           count(*) filter (where kind = 'deal' and coalesce(amount_agorot, 0) = 0) as without_amount,
           coalesce(sum(amount_agorot) filter (where kind = 'deal'), 0)::bigint as value,
           min(day) as first_day, max(day) as last_day
      from bought
  )
  select coalesce(app.customer_purchase_count(p_org, p_contact, p_company), 0) > f.purchases or not app.is_member(p_org),
         f.purchases, f.deals, f.payments, f.without_amount, f.value, f.first_day, f.last_day,
         (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date,
         m.dormant_months, m.former_months
    from facts f cross join app.customer_status_months(p_org) m
$$;
revoke all on function app.customer_facts(uuid, uuid, uuid) from public, anon;
grant execute on function app.customer_facts(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The card's answer
-- ----------------------------------------------------------------------------
create or replace function public.customer_summary(p_org uuid, p_contact uuid, p_company uuid)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  f record;
begin
  if (p_contact is null) = (p_company is null) then
    raise exception 'a customer is a contact or a company' using errcode = '22023', hint = 'customer_status:subject';
  end if;
  if not app.is_member(p_org) then
    return jsonb_build_object('allowed', false);
  end if;
  select * into f from app.customer_facts(p_org, p_contact, p_company);
  if f.partial then
    return jsonb_build_object('allowed', true, 'partial', true);
  end if;
  if f.purchases = 0 then
    return jsonb_build_object('allowed', true, 'partial', false, 'customer', false,
                              'dormant_months', f.dormant_months, 'former_months', f.former_months);
  end if;
  return jsonb_build_object(
    'allowed', true, 'partial', false, 'customer', true,
    'status', app.customer_status_rule(f.last_purchase_on, f.today, f.dormant_months, f.former_months),
    'deals', f.deals, 'payments', f.payments, 'deals_without_amount', f.deals_without_amount, 'value_agorot', f.value_agorot,
    'first_purchase_on', f.first_purchase_on, 'last_purchase_on', f.last_purchase_on,
    'dormant_on', (f.last_purchase_on + make_interval(months => f.dormant_months))::date,
    'former_on', (f.last_purchase_on + make_interval(months => f.former_months))::date,
    'today', f.today, 'dormant_months', f.dormant_months, 'former_months', f.former_months);
end;
$$;
revoke all on function public.customer_summary(uuid, uuid, uuid) from public, anon;
grant execute on function public.customer_summary(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The kept facts (review of 2 November 2026, lead's direction (a)): one row per customer, refreshed at commit
-- ----------------------------------------------------------------------------
-- Reading every customer's purchases on each list row is too slow (a sort over 20,000 contacts took minutes), so the facts
-- that drive the status are kept per contact and per company, PAY-03 / BAL-02 style: purchases, won-deal value and count,
-- payment count and the last purchase day (in the business's zone when refreshed). The status stays a pure rule over the
-- kept last day, the business's thresholds and today, so a change of thresholds or of the date needs no refresh.
-- * Schema app, no grants (RLS on, no policies): read only by the definer functions below.
-- * Refreshed by DEFERRABLE INITIALLY DEFERRED constraint triggers on deals, payments and contacts (plain "after insert or
--   update or delete", no column list: BEFORE triggers derive payments.status from cheque_status (PAY-04) and a deal's amount
--   from its recurring amount and billing kind (DEAL-07, DLI-03), columns a statement never names; each function compares old
--   and new and returns before the lock when nothing that moves a purchase changed), under PAY-03's business
--   lock ('customer_credit:<org>', shared with BAL-02 so the deferred triggers of one commit never wait on each other in two
--   orders). A row stays (purchases 0) when its last purchase goes; it goes with its contact or company (FK cascade).
-- * Visibility (lead's direction (b)): the kept facts are business-wide, so the list columns, sort, filter, the dormant list
--   and the dormant scan read them only for owners and admins (who read every deal and payment, like PAY-03's credit column);
--   anyone else gets null and the app offers them nothing. The card keeps the live per-customer check with the partial rule.
-- * Accepted: a change of the business's time zone does not move kept days until the customer's next refresh.
create table if not exists app.customer_purchase_facts (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  contact_id       uuid,
  company_id       uuid,
  -- the one key the readers look up by (a contact's or a company's id; uuids never repeat between the two)
  customer_id      uuid generated always as (coalesce(contact_id, company_id)) stored,
  purchases        integer not null default 0,
  deals            integer not null default 0,
  payments         integer not null default 0,
  value_agorot     bigint not null default 0,
  last_purchase_on date,
  refreshed_at     timestamptz not null default now(),
  constraint customer_purchase_facts_pkey primary key (organization_id, customer_id),
  constraint customer_purchase_facts_one check ((contact_id is null) <> (company_id is null)),
  constraint customer_purchase_facts_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint customer_purchase_facts_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade
);
-- the FKs' own indexes (each cascade finds its row by them)
create index if not exists customer_purchase_facts_contact_idx
  on app.customer_purchase_facts (organization_id, contact_id) where contact_id is not null;
create index if not exists customer_purchase_facts_company_idx
  on app.customer_purchase_facts (organization_id, company_id) where company_id is not null;
create index if not exists customer_purchase_facts_last_idx
  on app.customer_purchase_facts (organization_id, last_purchase_on) where purchases > 0;
alter table app.customer_purchase_facts enable row level security;
revoke all on app.customer_purchase_facts from public, anon, authenticated, service_role;

-- one customer's facts read in full (as the owner) and kept; nothing for a contact or company that is gone
create or replace function app.customer_facts_refresh(p_org uuid, p_contact uuid, p_company uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v record;
begin
  if p_org is null or (p_contact is null) = (p_company is null) then
    return;
  end if;
  if p_contact is not null and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact) then
    return;
  end if;
  if p_company is not null and not exists (select 1 from public.companies c where c.organization_id = p_org and c.id = p_company) then
    return;
  end if;
  select count(*)::integer as purchases,
         (count(*) filter (where b.kind = 'deal'))::integer as deals,
         (count(*) filter (where b.kind = 'payment'))::integer as payments,
         coalesce(sum(b.amount_agorot) filter (where b.kind = 'deal'), 0)::bigint as value,
         max(b.day) as last_day
    into v
    from app.customer_purchases(p_org, p_contact, p_company) b;
  if p_contact is not null then
    insert into app.customer_purchase_facts as f
           (organization_id, contact_id, purchases, deals, payments, value_agorot, last_purchase_on, refreshed_at)
    values (p_org, p_contact, v.purchases, v.deals, v.payments, v.value, v.last_day, now())
    on conflict (organization_id, customer_id) do update
       set purchases = excluded.purchases, deals = excluded.deals, payments = excluded.payments,
           value_agorot = excluded.value_agorot, last_purchase_on = excluded.last_purchase_on, refreshed_at = now();
  else
    insert into app.customer_purchase_facts as f
           (organization_id, company_id, purchases, deals, payments, value_agorot, last_purchase_on, refreshed_at)
    values (p_org, p_company, v.purchases, v.deals, v.payments, v.value, v.last_day, now())
    on conflict (organization_id, customer_id) do update
       set purchases = excluded.purchases, deals = excluded.deals, payments = excluded.payments,
           value_agorot = excluded.value_agorot, last_purchase_on = excluded.last_purchase_on, refreshed_at = now();
  end if;
end;
$$;
revoke all on function app.customer_facts_refresh(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- the customers a deal belongs to: its contact, its company, else its contact's company
create or replace function app.customer_facts_deal_customers(p_org uuid, p_contact uuid, p_company uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_contact is not null then
    perform app.customer_facts_refresh(p_org, p_contact, null);
  end if;
  if p_company is not null then
    perform app.customer_facts_refresh(p_org, null, p_company);
  elsif p_contact is not null then
    perform app.customer_facts_refresh(p_org, null, c.company_id)
       from public.contacts c where c.organization_id = p_org and c.id = p_contact and c.company_id is not null;
  end if;
end;
$$;
revoke all on function app.customer_facts_deal_customers(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.customer_facts_on_deal() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  -- a plain trigger (no column list: BEFORE triggers derive status and amount_agorot from columns a statement names, e.g.
  -- the recurring amount); nothing that moves a purchase changed: no lock, nothing to do
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id and new.status is not distinct from old.status
     and new.closed_at is not distinct from old.closed_at and new.amount_agorot is not distinct from old.amount_agorot
     and new.contact_id is not distinct from old.contact_id and new.company_id is not distinct from old.company_id
     and new.deleted_at is not distinct from old.deleted_at then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || v_org::text, 0));
  if tg_op <> 'DELETE' then
    perform app.customer_facts_deal_customers(new.organization_id, new.contact_id, new.company_id);
  end if;
  if tg_op <> 'INSERT' and (tg_op = 'DELETE' or old.contact_id is distinct from new.contact_id
                            or old.company_id is distinct from new.company_id) then
    perform app.customer_facts_deal_customers(old.organization_id, old.contact_id, old.company_id);
  end if;
  -- a deal that went to the bin or came back: payments on it of another contact count again or no more (item 6)
  if tg_op = 'UPDATE' and new.deleted_at is distinct from old.deleted_at then
    perform app.customer_facts_payment_customers(p.organization_id, p.contact_id, null)
       from (select distinct pay.organization_id, pay.contact_id from public.payments pay
              where pay.organization_id = new.organization_id and pay.deal_id = new.id and pay.contact_id is not null
                and pay.contact_id is distinct from new.contact_id) p;
  end if;
  return null;
end;
$$;
revoke all on function app.customer_facts_on_deal() from public, anon, authenticated, service_role;

-- the customers a payment belongs to: its contact, its deal's customers, else its contact's company
create or replace function app.customer_facts_payment_customers(p_org uuid, p_contact uuid, p_deal uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_contact is not null then
    perform app.customer_facts_refresh(p_org, p_contact, null);
  end if;
  if p_deal is not null then
    perform app.customer_facts_deal_customers(p_org, d.contact_id, d.company_id)
       from public.deals d where d.organization_id = p_org and d.id = p_deal;
  elsif p_contact is not null then
    perform app.customer_facts_refresh(p_org, null, c.company_id)
       from public.contacts c where c.organization_id = p_org and c.id = p_contact and c.company_id is not null;
  end if;
end;
$$;
revoke all on function app.customer_facts_payment_customers(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.customer_facts_on_payment() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  -- a plain trigger (no column list: PAY-04's payments_cheque derives status from cheque_status); nothing that moves a
  -- purchase changed: no lock, nothing to do
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.deal_id is not distinct from old.deal_id
     and new.contact_id is not distinct from old.contact_id and new.paid_on is not distinct from old.paid_on then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || v_org::text, 0));
  if tg_op <> 'DELETE' then
    perform app.customer_facts_payment_customers(new.organization_id, new.contact_id, new.deal_id);
  end if;
  if tg_op <> 'INSERT' and (tg_op = 'DELETE' or old.contact_id is distinct from new.contact_id
                            or old.deal_id is distinct from new.deal_id) then
    perform app.customer_facts_payment_customers(old.organization_id, old.contact_id, old.deal_id);
  end if;
  return null;
end;
$$;
revoke all on function app.customer_facts_on_payment() from public, anon, authenticated, service_role;

-- a contact moved company or went to the bin: its company-less deals and deal-less payments count for another company
create or replace function app.customer_facts_on_contact() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.company_id is not distinct from old.company_id
     and new.deleted_at is not distinct from old.deleted_at then
    return null;
  end if;
  -- a deleted contact (a merge's duplicate, a purge, sample data removal) leaves no row to find its company by at commit,
  -- so its old company is refreshed from the deleted row itself
  if tg_op = 'DELETE' then
    if old.company_id is not null then
      perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || old.organization_id::text, 0));
      perform app.customer_facts_refresh(old.organization_id, null, old.company_id);
    end if;
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('customer_credit:' || new.organization_id::text, 0));
  if old.company_id is not null then
    perform app.customer_facts_refresh(old.organization_id, null, old.company_id);
  end if;
  if new.company_id is not null and new.company_id is distinct from old.company_id then
    perform app.customer_facts_refresh(new.organization_id, null, new.company_id);
  end if;
  return null;
end;
$$;
revoke all on function app.customer_facts_on_contact() from public, anon, authenticated, service_role;

-- Constraint triggers, deferred to commit (created only when missing, as BAL-02's)
do $$
declare
  v_plain text;
begin
  select string_agg(t.tgname, ', ') into v_plain
    from pg_trigger t
   where not t.tgisinternal
     and (t.tgrelid, t.tgname) in (('public.deals'::regclass, 'deals_customer_facts'),
                                   ('public.payments'::regclass, 'payments_customer_facts'),
                                   ('public.contacts'::regclass, 'contacts_customer_facts'))
     and not (t.tgconstraint <> 0 and t.tgdeferrable and t.tginitdeferred);
  if v_plain is not null then
    raise exception 'CON-11: % exist as plain triggers; they must be deferred constraint triggers', v_plain using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.deals'::regclass and tgname = 'deals_customer_facts' and not tgisinternal) then
    create constraint trigger deals_customer_facts
      after insert or update or delete on public.deals
      deferrable initially deferred
      for each row execute function app.customer_facts_on_deal();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.payments'::regclass and tgname = 'payments_customer_facts' and not tgisinternal) then
    create constraint trigger payments_customer_facts
      after insert or update or delete on public.payments
      deferrable initially deferred
      for each row execute function app.customer_facts_on_payment();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.contacts'::regclass and tgname = 'contacts_customer_facts' and not tgisinternal) then
    create constraint trigger contacts_customer_facts
      after update or delete on public.contacts
      deferrable initially deferred
      for each row execute function app.customer_facts_on_contact();
  end if;
end;
$$;

-- the customers there are so far (insert only; a second run changes nothing)
insert into app.customer_purchase_facts (organization_id, contact_id, purchases, deals, payments, value_agorot, last_purchase_on)
select c.organization_id, c.id, f.purchases, f.deals, f.payments, f.value, f.last_day
  from public.contacts c
 cross join lateral (
   select count(*)::integer as purchases, (count(*) filter (where b.kind = 'deal'))::integer as deals,
          (count(*) filter (where b.kind = 'payment'))::integer as payments,
          coalesce(sum(b.amount_agorot) filter (where b.kind = 'deal'), 0)::bigint as value, max(b.day) as last_day
     from app.customer_purchases(c.organization_id, c.id, null) b) f
 where (exists (select 1 from public.deals d where d.organization_id = c.organization_id and d.contact_id = c.id)
        or exists (select 1 from public.payments p where p.organization_id = c.organization_id and p.contact_id = c.id))
   and f.purchases > 0
on conflict (organization_id, customer_id) do nothing;

insert into app.customer_purchase_facts (organization_id, company_id, purchases, deals, payments, value_agorot, last_purchase_on)
select co.organization_id, co.id, f.purchases, f.deals, f.payments, f.value, f.last_day
  from public.companies co
 cross join lateral (
   select count(*)::integer as purchases, (count(*) filter (where b.kind = 'deal'))::integer as deals,
          (count(*) filter (where b.kind = 'payment'))::integer as payments,
          coalesce(sum(b.amount_agorot) filter (where b.kind = 'deal'), 0)::bigint as value, max(b.day) as last_day
     from app.customer_purchases(co.organization_id, null, co.id) b) f
 where (exists (select 1 from public.deals d where d.organization_id = co.organization_id and d.company_id = co.id)
        or exists (select 1 from public.contacts c where c.organization_id = co.organization_id and c.company_id = co.id))
   and f.purchases > 0
on conflict (organization_id, customer_id) do nothing;

-- RET-01: the last purchase day of a customer, kept (the server's dormant scan and its retry check; no grants)
create or replace function app.customer_last_purchase_all(p_org uuid, p_contact uuid, p_company uuid)
returns date
language sql stable security definer
set search_path = ''
as $$
  select f.last_purchase_on from app.customer_purchase_facts f
   where f.organization_id = p_org and f.purchases > 0
     and f.customer_id = coalesce(p_contact, p_company)
$$;
revoke all on function app.customer_last_purchase_all(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Computed fields for the lists (column, sort, filter, export): owners and admins only, from the kept facts; null = not a
-- customer, or a caller who is not an owner or admin (the app offers them none of it)
-- ----------------------------------------------------------------------------
-- Who reads the kept facts through the list fields: an active owner or admin of the business (the membership read written
-- into each of the three readers below). A plain membership read on purpose: with app.membership_role the sort of 20,000
-- contacts by status took 6.2 s against 2.5 s (app.is_admin, through app.role_in, is slower still). It is safe because the
-- fields are reached only as PostgREST computed fields on rows of contacts and companies the caller already reads under RLS,
-- whose policies apply app.membership_role (two-step and closed-business rules) for that business; a support session is never
-- an owner or admin (app.role_in gives it 'viewer', and staff hold no membership); schema app is not in the API. The
-- convention this rests on is pinned by test 284: no public function returns a row (or a set) of contacts or companies, so
-- no RPC can hand the fields a row the caller could not read.
create or replace function app.customer_kept_status(p_org uuid, p_contact uuid, p_company uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select app.customer_status_rule(
           f.last_purchase_on,
           (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date,
           coalesce(s.dormant_months, 6)::integer, coalesce(s.former_months, 18)::integer)
    from app.customer_purchase_facts f
    join public.organizations o on o.id = f.organization_id
    left join public.customer_status_settings s on s.organization_id = f.organization_id
   where f.organization_id = p_org and f.customer_id = coalesce(p_contact, p_company) and f.purchases > 0
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active'
                    and m.role in ('owner', 'admin'))
$$;
revoke all on function app.customer_kept_status(uuid, uuid, uuid) from public, anon;
grant execute on function app.customer_kept_status(uuid, uuid, uuid) to authenticated;

create or replace function app.customer_kept_value(p_org uuid, p_contact uuid, p_company uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select f.value_agorot from app.customer_purchase_facts f
   where f.organization_id = p_org and f.customer_id = coalesce(p_contact, p_company) and f.purchases > 0
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active'
                    and m.role in ('owner', 'admin'))
$$;
revoke all on function app.customer_kept_value(uuid, uuid, uuid) from public, anon;
grant execute on function app.customer_kept_value(uuid, uuid, uuid) to authenticated;

create or replace function app.customer_kept_last(p_org uuid, p_contact uuid, p_company uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select f.last_purchase_on from app.customer_purchase_facts f
   where f.organization_id = p_org and f.customer_id = coalesce(p_contact, p_company) and f.purchases > 0
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active'
                    and m.role in ('owner', 'admin'))
$$;
revoke all on function app.customer_kept_last(uuid, uuid, uuid) from public, anon;
grant execute on function app.customer_kept_last(uuid, uuid, uuid) to authenticated;

-- inlined (no SET clause, as BAL-02's debt_balance; the advisor's function_search_path_mutable on them is expected)
create or replace function public.customer_status(public.contacts) returns text
language sql stable
as $$ select app.customer_kept_status(($1).organization_id, ($1).id, null) $$;
create or replace function public.customer_status(public.companies) returns text
language sql stable
as $$ select app.customer_kept_status(($1).organization_id, null, ($1).id) $$;
create or replace function public.customer_value(public.contacts) returns bigint
language sql stable
as $$ select app.customer_kept_value(($1).organization_id, ($1).id, null) $$;
create or replace function public.customer_value(public.companies) returns bigint
language sql stable
as $$ select app.customer_kept_value(($1).organization_id, null, ($1).id) $$;
revoke all on function public.customer_status(public.contacts) from public, anon;
revoke all on function public.customer_status(public.companies) from public, anon;
revoke all on function public.customer_value(public.contacts) from public, anon;
revoke all on function public.customer_value(public.companies) from public, anon;
grant execute on function public.customer_status(public.contacts) to authenticated;
grant execute on function public.customer_status(public.companies) to authenticated;
grant execute on function public.customer_value(public.contacts) to authenticated;
grant execute on function public.customer_value(public.companies) to authenticated;

-- ----------------------------------------------------------------------------
-- The list export keeps the status filter's codes in its audit entry (app.export_choice_values, last redefined in 021076;
-- this is its body with the two new codes)
-- ----------------------------------------------------------------------------
create or replace function app.export_choice_values() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- deal status, task status
    'open', 'won', 'lost', 'done', 'cancelled',
    -- task type
    'todo', 'call', 'meeting', 'follow_up',
    -- task priority
    '1', '2', '3',
    -- company industry
    'services', 'real_estate', 'insurance_finance', 'construction', 'retail', 'health',
    'education', 'marketing', 'technology', 'tourism_events', 'nonprofit', 'other',
    -- CON-10: contact preferred language
    'he', 'ar', 'en', 'ru', 'am', 'fr', 'es',
    -- CON-10: contact preferred channel
    'phone', 'whatsapp', 'email', 'sms',
    -- LST-09: product kind, VAT kind and billing
    'product', 'service', 'subscription', 'bundle',
    'taxable', 'exempt', 'zero_rate',
    'one_time', 'monthly', 'quarterly', 'yearly',
    -- LST-09: quote status codes ('cancelled' is above)
    'draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired',
    -- LST-09: accounting document types and status ('cancelled' is above)
    'tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma', 'active',
    -- GAP-12: the opening balance
    'opening_balance',
    -- LST-09: payment methods ('other' is above) and statuses ('cancelled' is above)
    'credit', 'transfer', 'cash', 'cheque', 'bit_paybox', 'standing_order',
    'recorded', 'confirmed', 'failed', 'refunded',
    -- CON-11: the customer status filter ('active' is above)
    'dormant', 'former'
  ];
$$;
revoke all on function app.export_choice_values() from public, anon, authenticated;

notify pgrst, 'reload schema';
