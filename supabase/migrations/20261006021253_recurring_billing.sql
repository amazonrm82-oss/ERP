-- SUB-01..SUB-05: recurring billing of a business's customers (method A, "document only"; owner (269) ג: plan key
-- `recurring_billing` from the pro plan up). This is the business's own retainer or membership with ITS customers, apart from
-- the subscription the business pays Mexuz.
--
-- * public.recurring_billings: one recurring billing of a customer (a contact, or a company; exactly one), optionally from a
--   won deal (deal_id, composite FK set null). Cycle monthly|quarterly|yearly, start date, billing day 1..28 (no month-end
--   day, so every month has it), end date or none ("until further notice"), commitment period in months (0..120,
--   informational: the screen shows its last day and warns before a cancel inside it). VAT mode per billing
--   (prices_include_vat: given on insert, else the business's setting; never changed). The amount of one cycle before VAT
--   (amount_agorot) and the next cycle date (next_cycle_on) are server-kept. Never deleted by a person: cancelled with a
--   reason (then frozen). Statuses active|paused|cancelled|failed (SUB-04): a person pauses and resumes (paused or failed ->
--   active; the next cycle is the first billing date from today, missed cycles are not made up), cancels with a reason; only
--   the server marks failed (3 failed tries of one cycle). Rights: app.can_record_payments (owners, admins, managers by role
--   or the PRM-01 grant record_payments) in a writable business with the key, on a customer the caller reads; reading follows
--   the customer. Audited. The outsider guard comes first in the definer check trigger.
-- * public.recurring_billing_lines: lines from the catalog (or free lines), shaped like deal lines (DLI-01, PL-03's claimed
--   price source, product FK with no on delete action, price list FK set null, flags products / discounts / price_lists),
--   priced in the billing's VAT mode. 200 per billing. A change recomputes the billing's amount; it applies from the NEXT
--   cycle by construction (a made cycle keeps its own amounts), and once the billing has a cycle a changed amount is
--   recorded as a `price_changed` event (SUB-04) beside the audit entries.
-- * public.recurring_billing_cycles (server-written): one row per billing and cycle date (unique), with the period's last
--   day and the amounts at the VAT rate of that date. SUB-02 method A: no document provider exists yet (DOC-05+ wait), so a
--   due cycle makes a TASK for the rep (MNY-01's owner rule, like COL-04: the deal's owner, else the customer's, an active
--   full-seat non-viewer; else the owner, else the oldest admin) to issue the document outside and record it (DOC-01). A
--   recorder links the recorded document to the cycle (accounting_document_id, column grant; an active tax invoice,
--   invoice-receipt, receipt or proforma of the same customer, read under the caller's RLS) or marks it skipped; either closes
--   the cycle's task. Nothing is sent to the customer.
-- * public.recurring_billing_events (server-written history): created, paused, resumed, cancelled, failed, ended,
--   day_changed, price_changed (old and new amount, effective from the next cycle), cycle_due. Codes and amounts only.
-- * The job: pg_cron `crm-recurring-billings` every 15 minutes runs app.run_recurring_billings(p_orgs): active billings whose
--   next cycle date is today or earlier in the business zone, from 08:00, writable businesses with the key, customer not in
--   the bin; 200 per business and 2,000 per run (a transaction may lower both: app.recurring_billing_per_org / _limit);
--   businesses take turns (app.recurring_billing_turns); one cycle per billing a run; each billing in its own exception
--   block; 3 failures of one cycle (app.recurring_billing_failures) mark the billing failed.
-- * SUB-03: public.recurring_billing_from_deal(org, deal) (INVOKER: every write is the person's, so RLS and the line rules
--   hold) makes a billing from a won deal's recurring lines (DLI-04 billing per line): cycle = the deal's billing kind, else
--   the first recurring line's; lines of that period are copied with their stored price, source and list; a line the rules
--   no longer allow (an archived product) is skipped and counted. One live billing per deal.
-- * SUB-05: public.report_recurring_billing(org, from, to) (INVOKER, RLS decides): MRR of the active billings (quarterly / 3
--   and yearly / 12, half up, per billing; before VAT), new and churned customers and their MRR per month, the expected
--   amount of next month's cycles. Report key `recurring_billing` in public.log_export (021169's body plus that key, refused
--   without the plan key and to those who do not record payments).
-- * Plan key: app.plan_key_defaults (021249's body plus "recurring_billing": false); pro and business on, personal and basic
--   off, the hidden free plan off. public.plans_public (021237's body): 'recurring_billing' added to the closed landing list
--   after 'punch_cards' (PLAN_CAPABILITIES lists it as built; test 344's pin rechecked).
--
-- * Independent review (12 November 2026): M1 prices_include_vat has no default, so a billing takes the business's setting;
--   M2 the deal of a billing is read under the caller's RLS (invoker trigger recurring_billings_a_deal_check) and must be of
--   the billing's own customer exactly (app.recurring_deal_matches: a contact's billing takes a deal of that contact, or a
--   deal with no contact whose company is the contact's company; a company's billing a deal of that company), one hint for
--   missing, unreadable or another customer's; M3 the report's partial rule (app.recurring_billing_count) and billings of a
--   customer in the bin left out; L1 a successful cycle and a resume clear the failure count; L2 a gap makes no backlog
--   (one `cycles_skipped` event with the count); L3 no lines = no cycle and no task (one `no_lines` event); L4 one document
--   per cycle, of the billing's own customer, and a cycle back to waiting reopens the task it closed; L6 a removed price
--   list's price copies as a typed one; L7 without the plan key a recorder may still pause or cancel.
-- * Owner's answers (12 November 2026): (352) ב each due cycle also makes a DRAFT order of its lines for the rep
--   (app.recurring_cycle_order, the server's manual draft through every order rule; `orders` key and the orders module on;
--   recurring_billing_cycles.order_id, server only; a refused order leaves the cycle and task, one `order_not_made` event);
--   (353) ג a resume asks whether to make up the missed cycles (public.recurring_billing_resume; make_up_until; each made-up
--   cycle counted against the per-business cap; the choice in the `resumed` event); (354) ב billing day 0 = the month's last
--   day (app.recurring_day_in_month); (355) א a cancel inside the commitment is allowed and its event keeps the reason, the
--   commitment's last day and that it was inside; (356) ב the report for owners, admins and managers by role; (357) ג every
--   report amount before VAT and with VAT.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The plan key
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "features": { "recurring_billing": false } },
  "basic": { "features": { "recurring_billing": false } },
  "pro": { "features": { "recurring_billing": true } },
  "business": { "features": { "recurring_billing": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and p.features is distinct from (p.features || (d.v -> 'features'));

update public.plans p
   set features = coalesce(p.features, '{}'::jsonb) || '{"recurring_billing": false}'::jsonb
 where not (coalesce(p.features, '{}'::jsonb) ? 'recurring_billing');

create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": false,
    "price_lists": false,
    "discounts": false,
    "quotes": false,
    "orders": false,
    "documents": false,
    "payments": false,
    "balances": false,
    "collection": false,
    "money_waiting": false,
    "consents": false,
    "segments": false,
    "goals": false,
    "granular_permissions": false,
    "booking_page": false,
    "business_card": false,
    "qr_codes": false,
    "site_widget": false,
    "retention": false,
    "remove_built_with": false,
    "payment_links": false,
    "instant_reply": false,
    "auto_reassign": false,
    "dashboards": false,
    "goals_per_rep": false,
    "booking_team_pages": false,
    "lead_distribution": false,
    "campaign_costs": false,
    "punch_cards": false,
    "meta_leads": false,
    "meeting_reminders": false,
    "signatures": false,
    "sms": false,
    "review_requests": false,
    "public_page": false,
    "money_waiting_actions": false,
    "recurring_billing": false
  },
  "limits": {
    "max_products": 0,
    "max_price_lists": 0,
    "max_quote_templates": 0,
    "max_booking_pages": 0,
    "max_booking_pages_per_user": 0,
    "max_segments": 0,
    "max_qr_codes": 0,
    "max_pdf_per_month": 0,
    "max_customer_emails_per_month": 0,
    "max_customer_emails_per_day": 0,
    "max_custom_reports": 0,
    "max_custom_objects": 0,
    "max_teams": 0,
    "max_whatsapp_numbers": 0,
    "view_seats_per_paid_seat": 0,
    "max_site_widgets": 0,
    "max_business_cards_per_user": 0,
    "max_booking_team_pages": 0,
    "ai_credits_per_month": 0,
    "ai_credits_per_user_per_month": 0,
    "max_signatures_per_month": 0,
    "max_sms_per_month": 0,
    "max_quotes_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The schedule (pure): the first billing date on or after a day
-- ----------------------------------------------------------------------------
-- owner (354) ב: the billing day is 1..28, or 0 = the last day of the month (28, 29, 30 or 31)
create or replace function app.recurring_day_in_month(p_month date, p_day integer) returns date
language sql immutable
set search_path = ''
as $$
  select case when p_day = 0 then (date_trunc('month', p_month) + interval '1 month')::date - 1
              else date_trunc('month', p_month)::date + (p_day - 1) end
$$;
revoke all on function app.recurring_day_in_month(date, integer) from public, anon;
grant execute on function app.recurring_day_in_month(date, integer) to authenticated;

-- = nextCycleDate() in src/features/recurring-billing/schedule.ts. The series: the billing day of the start month, then every
-- 1, 3 or 12 months; dates before the start date are not in it.
create or replace function app.recurring_next_cycle(p_start date, p_cycle text, p_day integer, p_from date) returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_step integer := case p_cycle when 'monthly' then 1 when 'quarterly' then 3 when 'yearly' then 12 end;
  v_from date;
  v_base date;
  v_months integer;
  v_k integer;
  v_day date;
begin
  if v_step is null or p_start is null or p_day is null or p_day < 0 or p_day > 28 then
    return null;
  end if;
  v_from := greatest(coalesce(p_from, p_start), p_start);
  v_base := date_trunc('month', p_start)::date;
  v_months := (extract(year from v_from)::integer - extract(year from v_base)::integer) * 12
              + extract(month from v_from)::integer - extract(month from v_base)::integer;
  v_k := (v_months + v_step - 1) / v_step;
  v_day := app.recurring_day_in_month((v_base + make_interval(months => v_k * v_step))::date, p_day);
  if v_day < v_from then
    v_day := app.recurring_day_in_month((v_base + make_interval(months => (v_k + 1) * v_step))::date, p_day);
  end if;
  return v_day;
end;
$$;
revoke all on function app.recurring_next_cycle(date, text, integer, date) from public, anon;
grant execute on function app.recurring_next_cycle(date, text, integer, date) to authenticated;

-- one cycle's amount as a monthly amount (quarterly / 3, yearly / 12, half up), = monthlyAmount()
create or replace function app.recurring_monthly_amount(p_amount bigint, p_cycle text) returns bigint
language sql immutable
set search_path = ''
as $$
  select case p_cycle when 'monthly' then p_amount
                      when 'quarterly' then div(2 * p_amount + 3, 6)
                      when 'yearly' then div(2 * p_amount + 12, 24) end
$$;
revoke all on function app.recurring_monthly_amount(bigint, text) from public, anon;
grant execute on function app.recurring_monthly_amount(bigint, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The billing
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_billings (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  contact_id          uuid,
  company_id          uuid,
  deal_id             uuid,
  name                text not null check (char_length(btrim(name)) between 1 and 120),
  cycle               text not null check (cycle in ('monthly', 'quarterly', 'yearly')),
  start_date          date not null,
  -- owner (354) ב: 1..28, or 0 = the last day of the month
  billing_day         integer not null check (billing_day between 0 and 28),
  end_date            date,
  commitment_months   integer not null default 0 check (commitment_months between 0 and 120),
  -- no default: an insert that does not name it takes the business's setting (the check trigger fills it)
  prices_include_vat  boolean not null,
  status              text not null default 'active' check (status in ('active', 'paused', 'cancelled', 'failed')),
  -- server kept: one cycle's amount before VAT (at today's rate when prices include VAT) and the next cycle date
  amount_agorot       bigint not null default 0,
  next_cycle_on       date,
  -- owner (353) ג: a resume that makes up the missed cycles: the job makes every cycle up to this day (server only)
  make_up_until       date,
  paused_at           timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500),
  currency            text not null default 'ILS' check (currency = 'ILS'),
  created_by          uuid references auth.users (id) on delete set null,
  updated_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id),
  constraint recurring_billings_one_customer check (num_nonnulls(contact_id, company_id) = 1),
  constraint recurring_billings_end_after_start check (end_date is null or end_date >= start_date),
  constraint recurring_billings_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint recurring_billings_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade,
  constraint recurring_billings_deal_fk foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete set null (deal_id)
);
create index if not exists recurring_billings_contact_idx on public.recurring_billings (organization_id, contact_id);
create index if not exists recurring_billings_company_idx on public.recurring_billings (organization_id, company_id);
create index if not exists recurring_billings_deal_idx on public.recurring_billings (organization_id, deal_id);
create index if not exists recurring_billings_due_idx on public.recurring_billings (next_cycle_on) where status = 'active';

alter table public.recurring_billings enable row level security;
revoke all on public.recurring_billings from anon, authenticated;
grant select on public.recurring_billings to authenticated;
grant insert (organization_id, contact_id, company_id, deal_id, name, cycle, start_date, billing_day, end_date, commitment_months,
              prices_include_vat)
  on public.recurring_billings to authenticated;
grant update (name, billing_day, end_date, commitment_months, status, cancel_reason) on public.recurring_billings to authenticated;

-- the customer the caller reads (RLS of contacts / companies)
create or replace function app.recurring_customer_readable(p_org uuid, p_contact uuid, p_company uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select case when p_contact is not null
              then exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact)
              else exists (select 1 from public.companies co where co.organization_id = p_org and co.id = p_company) end
$$;
revoke all on function app.recurring_customer_readable(uuid, uuid, uuid) from public, anon;
grant execute on function app.recurring_customer_readable(uuid, uuid, uuid) to authenticated;

-- who manages billings: BAL-01's recorders, in a writable business with the key
create or replace function app.recurring_billing_writer(p_org uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select app.can_record_payments(p_org) and app.org_writable(p_org) and app.org_has_feature(p_org, 'recurring_billing')
$$;
revoke all on function app.recurring_billing_writer(uuid) from public, anon;
grant execute on function app.recurring_billing_writer(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billings' and policyname = 'recurring_billings_select') then
    create policy recurring_billings_select on public.recurring_billings for select to authenticated
      using (app.is_member(organization_id)
             and app.recurring_customer_readable(recurring_billings.organization_id, recurring_billings.contact_id, recurring_billings.company_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billings' and policyname = 'recurring_billings_insert') then
    create policy recurring_billings_insert on public.recurring_billings for insert to authenticated
      with check (app.recurring_billing_writer(organization_id)
                  and app.recurring_customer_readable(recurring_billings.organization_id, recurring_billings.contact_id, recurring_billings.company_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billings' and policyname = 'recurring_billings_update') then
    -- SUB-04 (review L7): without the plan key a recorder may still pause or cancel (the check trigger allows only those)
    create policy recurring_billings_update on public.recurring_billings for update to authenticated
      using (app.can_record_payments(organization_id) and app.org_writable(organization_id)
             and app.recurring_customer_readable(recurring_billings.organization_id, recurring_billings.contact_id, recurring_billings.company_id))
      with check (app.can_record_payments(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- the business's today
create or replace function app.recurring_today(p_org uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select (now() at time zone app.intake_zone(o.timezone))::date from public.organizations o where o.id = p_org
$$;
revoke all on function app.recurring_today(uuid) from public, anon, authenticated, service_role;

-- The deal a billing comes from (review M2): of the billing's own customer, exactly. A contact's billing: the deal's contact
-- is that contact, or the deal has no contact and its company is the contact's company. A company's billing: the deal's
-- company is that company. Nulls never match.
create or replace function app.recurring_deal_matches(p_deal_contact uuid, p_deal_company uuid, p_contact uuid, p_company uuid,
                                                     p_contact_company uuid) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_contact is not null then
      coalesce(p_deal_contact = p_contact, false)
      or (p_deal_contact is null and p_deal_company is not null and coalesce(p_deal_company = p_contact_company, false))
    when p_company is not null then coalesce(p_deal_company = p_company, false)
    else false end
$$;
revoke all on function app.recurring_deal_matches(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.recurring_deal_matches(uuid, uuid, uuid, uuid, uuid) to authenticated;

-- A person's deal: read under the caller's RLS (invoker), so an unreadable deal answers exactly like a missing one or one
-- of another customer (one hint). Runs before the definer check (trigger name order).
create or replace function app.recurring_billings_deal_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_deal record;
begin
  if new.deal_id is null or auth.uid() is null
     or not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  select d.contact_id, d.company_id,
         (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id) as contact_company
    into v_deal
    from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id and d.deleted_at is null;
  if not found or not app.recurring_deal_matches(v_deal.contact_id, v_deal.company_id, new.contact_id, new.company_id, v_deal.contact_company) then
    raise exception 'the deal is not found or is of another customer' using errcode = 'P0001', hint = 'recurring_billing:deal';
  end if;
  return new;
end;
$$;
revoke all on function app.recurring_billings_deal_check() from public, anon, authenticated;

-- the billing dates from p_from up to (not including) p_until: how many cycles a gap passed over (review L2)
create or replace function app.recurring_cycles_between(p_start date, p_cycle text, p_day integer, p_from date, p_until date) returns integer
language plpgsql immutable
set search_path = ''
as $$
declare
  v_day date := app.recurring_next_cycle(p_start, p_cycle, p_day, p_from);
  v_n integer := 0;
begin
  while v_day is not null and v_day < p_until and v_n < 1000 loop
    v_n := v_n + 1;
    v_day := app.recurring_next_cycle(p_start, p_cycle, p_day, v_day + 1);
  end loop;
  return v_n;
end;
$$;
revoke all on function app.recurring_cycles_between(date, text, integer, date, date) from public, anon, authenticated, service_role;

-- the day a billing was made, in the business's zone
create or replace function app.recurring_created_on(p_org uuid, p_at timestamptz) returns date
language sql stable security definer
set search_path = ''
as $$
  select (p_at at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date
$$;
revoke all on function app.recurring_created_on(uuid, timestamptz) from public, anon, authenticated, service_role;

-- delta review MED-1: where a make-up starts: the first billing date on or after p_from, moved on so that at most 24 cycles
-- fall up to p_today (the older ones are not made)
create or replace function app.recurring_make_up_from(p_start date, p_cycle text, p_day integer, p_from date, p_today date) returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_day date := app.recurring_next_cycle(p_start, p_cycle, p_day, p_from);
  v_n integer := app.recurring_cycles_between(p_start, p_cycle, p_day, p_from, p_today + 1);
begin
  while v_n > 24 loop
    v_day := app.recurring_next_cycle(p_start, p_cycle, p_day, v_day + 1);
    v_n := v_n - 1;
  end loop;
  return v_day;
end;
$$;
revoke all on function app.recurring_make_up_from(date, text, integer, date, date) from public, anon, authenticated, service_role;

-- Server-set columns and the status rules, for every writer. Definer: the events and the deal check read past RLS.
create or replace function app.recurring_billings_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_deal record;
begin
  -- the job and the amount recompute (app.recurring_billing_server names the business, transaction-local)
  if current_setting('app.recurring_billing_server', true) = new.organization_id::text then
    return new;
  end if;
  -- a merge moves only the customer (app.merge_recurring_billings sets the marker around its own update)
  if tg_op = 'UPDATE' and current_setting('app.recurring_billing_merge', true) = new.organization_id::text then
    if row(new.organization_id, new.name, new.cycle, new.start_date, new.billing_day, new.end_date, new.status,
           new.amount_agorot, new.next_cycle_on, new.prices_include_vat)
       is not distinct from row(old.organization_id, old.name, old.cycle, old.start_date, old.billing_day, old.end_date,
           old.status, old.amount_agorot, old.next_cycle_on, old.prices_include_vat)
       and ((new.deal_id is not distinct from old.deal_id
             and ((old.contact_id is not null and new.contact_id is not null and new.company_id is null)
                  or (old.company_id is not null and new.company_id is not null and new.contact_id is null)))
            -- a deal merge moves only the deal, or clears it when the kept deal is another customer's (L5, delta review L-d)
            or (old.deal_id is not null
                and row(new.contact_id, new.company_id) is not distinct from row(old.contact_id, old.company_id))) then
      return new;
    end if;
    raise exception 'a merge moves only the customer of a recurring billing' using errcode = 'P0001', hint = 'recurring_billing:fixed';
  end if;
  -- outsider guard: RLS refuses (42501) a person who may not write here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  v_today := app.recurring_today(new.organization_id);
  new.name := btrim(new.name);
  new.cancel_reason := nullif(btrim(coalesce(new.cancel_reason, '')), '');

  if tg_op = 'INSERT' then
    if not app.org_has_feature(new.organization_id, 'recurring_billing') then
      raise exception 'recurring billing is not in this plan' using errcode = 'P0001', hint = 'feature:recurring_billing';
    end if;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.status := 'active';
    new.amount_agorot := 0;
    new.make_up_until := null;
    new.paused_at := null;
    new.cancelled_at := null;
    new.cancel_reason := null;
    new.prices_include_vat := coalesce(new.prices_include_vat,
      (select s.prices_include_vat from public.org_document_settings s where s.organization_id = new.organization_id), false);
    if new.deal_id is not null then
      select d.contact_id, d.company_id,
             (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id) as contact_company
        into v_deal
        from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id and d.deleted_at is null;
      if not found or not app.recurring_deal_matches(v_deal.contact_id, v_deal.company_id, new.contact_id, new.company_id, v_deal.contact_company) then
        raise exception 'the deal is not found or is of another customer' using errcode = 'P0001', hint = 'recurring_billing:deal';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('recurring_billing_deal:' || new.deal_id::text, 0));
      if exists (select 1 from public.recurring_billings b
                  where b.organization_id = new.organization_id and b.deal_id = new.deal_id and b.status <> 'cancelled') then
        raise exception 'the deal already has a recurring billing' using errcode = 'P0001', hint = 'recurring_billing:deal_exists';
      end if;
    end if;
    new.next_cycle_on := app.recurring_next_cycle(new.start_date, new.cycle, new.billing_day, v_today);
    if new.end_date is not null and new.next_cycle_on > new.end_date then
      new.next_cycle_on := null;
    end if;
  else
    -- (the currency is held by its own check constraint)
    if row(new.organization_id, new.contact_id, new.company_id, new.deal_id, new.cycle, new.start_date, new.prices_include_vat,
           new.created_by, new.created_at)
       is distinct from row(old.organization_id, old.contact_id, old.company_id, old.deal_id, old.cycle, old.start_date,
           old.prices_include_vat, old.created_by, old.created_at)
       -- the FK's own set-null of a purged deal
       and not (pg_trigger_depth() > 1 and old.deal_id is not null and new.deal_id is null
                and row(new.contact_id, new.company_id, new.cycle, new.start_date) is not distinct from row(old.contact_id, old.company_id, old.cycle, old.start_date)) then
      raise exception 'the customer, cycle and start of a recurring billing stay as made' using errcode = 'P0001', hint = 'recurring_billing:fixed';
    end if;
    if old.status = 'cancelled' and pg_trigger_depth() <= 1 then
      raise exception 'a cancelled recurring billing does not change' using errcode = 'P0001', hint = 'recurring_billing:cancelled';
    end if;
    -- review L7: without the plan key a recorder only stops a billing (pause, or cancel with a reason)
    if auth.uid() is not null and pg_trigger_depth() <= 1 and not app.org_has_feature(new.organization_id, 'recurring_billing')
       and not (new.status is distinct from old.status and new.status in ('paused', 'cancelled')
                and row(new.name, new.billing_day, new.end_date, new.commitment_months)
                    is not distinct from row(old.name, old.billing_day, old.end_date, old.commitment_months)) then
      raise exception 'recurring billing is not in this plan' using errcode = 'P0001', hint = 'feature:recurring_billing';
    end if;
    -- server columns keep their values
    new.amount_agorot := old.amount_agorot;
    new.next_cycle_on := old.next_cycle_on;
    new.make_up_until := old.make_up_until;
    new.paused_at := old.paused_at;
    new.cancelled_at := old.cancelled_at;

    if new.status is distinct from old.status then
      if new.status = 'failed' then
        raise exception 'only the system marks a billing failed' using errcode = 'P0001', hint = 'recurring_billing:status';
      elsif new.status = 'paused' then
        if old.status <> 'active' then
          raise exception 'only an active billing is paused' using errcode = 'P0001', hint = 'recurring_billing:status';
        end if;
        new.paused_at := now();
        -- delta review 2 (L): a pause ends a make-up that was still waiting, so the L-a lock never outlives it
        new.make_up_until := null;
      elsif new.status = 'active' then
        new.paused_at := null;
        if current_setting('app.recurring_resume_make_up', true) = new.id::text then
          -- owner (353) ג, delta review MED-1: make up the missed cycles from the first missed date (the next cycle date the
          -- pause or failure kept), never before the day the billing was made (business zone), and at most the last 24
          new.next_cycle_on := app.recurring_make_up_from(new.start_date, new.cycle, new.billing_day,
            greatest(coalesce(old.next_cycle_on, v_today), app.recurring_created_on(new.organization_id, new.created_at)), v_today);
          new.make_up_until := v_today;
        else
          -- continue: the first billing date from today; missed cycles are not made up
          new.next_cycle_on := app.recurring_next_cycle(new.start_date, new.cycle, new.billing_day, v_today);
          new.make_up_until := null;
        end if;
      elsif new.status = 'cancelled' then
        if new.cancel_reason is null then
          raise exception 'a cancel needs a reason' using errcode = 'P0001', hint = 'recurring_billing:cancel_reason';
        end if;
        new.cancelled_at := now();
        new.next_cycle_on := null;
      end if;
    elsif new.cancel_reason is distinct from old.cancel_reason then
      raise exception 'the reason is given with the cancel' using errcode = 'P0001', hint = 'recurring_billing:cancel_reason';
    end if;

    -- delta review L-a: while a make-up is still running, the billing day and end date wait for it
    if old.make_up_until is not null and (new.billing_day is distinct from old.billing_day or new.end_date is distinct from old.end_date) then
      raise exception 'the missed cycles are still being made' using errcode = 'P0001', hint = 'recurring_billing:make_up_pending';
    end if;
    -- a changed billing day or end date moves the next cycle (from the day after the last made cycle, or today)
    if new.status = 'active' and new.make_up_until is null
       and (new.billing_day is distinct from old.billing_day or new.end_date is distinct from old.end_date
            or new.status is distinct from old.status) then
      new.next_cycle_on := app.recurring_next_cycle(new.start_date, new.cycle, new.billing_day,
        greatest(v_today, coalesce((select max(c.cycle_on) + 1 from public.recurring_billing_cycles c
                                     where c.organization_id = new.organization_id and c.billing_id = new.id), v_today)));
    end if;
    if new.end_date is not null and new.next_cycle_on > new.end_date then
      new.next_cycle_on := null;
    end if;
    -- delta review 2 (MED): a make-up is pending only while a missed cycle is still due, so nothing missed (or no next cycle
    -- at all, after the end date) leaves no L-a lock behind
    if new.make_up_until is not null and (new.next_cycle_on is null or new.next_cycle_on > v_today) then
      new.make_up_until := null;
    end if;
  end if;

  if auth.uid() is not null and new.end_date is not null and new.end_date < new.start_date then
    raise exception 'the end date is after the start' using errcode = 'P0001', hint = 'recurring_billing:end_date';
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;
revoke all on function app.recurring_billings_check() from public, anon, authenticated;

create or replace trigger recurring_billings_a_deal_check before insert on public.recurring_billings
  for each row execute function app.recurring_billings_deal_check();
create or replace trigger recurring_billings_check before insert or update on public.recurring_billings
  for each row execute function app.recurring_billings_check();
create or replace trigger recurring_billings_touch before update on public.recurring_billings
  for each row execute function app.touch_row();
-- an update of the deal alone is the FK's set-null of a purged deal (also while the business itself is deleted): not logged
create or replace trigger recurring_billings_audit after insert or delete on public.recurring_billings
  for each row execute function app.audit_row();
create or replace trigger recurring_billings_audit_update after update of contact_id, company_id, name, billing_day, end_date,
  commitment_months, status, cancel_reason, amount_agorot on public.recurring_billings
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- History (server written)
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_billing_events (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  billing_id        uuid not null,
  kind              text not null check (kind in ('created', 'paused', 'resumed', 'cancelled', 'failed', 'ended', 'day_changed',
                                                  'price_changed', 'cycle_due', 'cycles_skipped', 'no_lines', 'order_not_made', 'deal_unlinked')),
  -- owner (355) א: a cancel keeps its reason and whether it fell inside the commitment period (its last day in effective_on)
  reason            text check (reason is null or char_length(btrim(reason)) between 1 and 500),
  in_commitment     boolean,
  -- owner (353) ג: a resume says whether the missed cycles are made up
  make_up           boolean,
  -- cycles_skipped: how many billing dates passed while no cycle could be made (review L2)
  skipped_cycles    integer check (skipped_cycles is null or skipped_cycles > 0),
  old_amount_agorot bigint,
  new_amount_agorot bigint,
  effective_on      date,
  currency          text not null default 'ILS' check (currency = 'ILS'),
  actor_id          uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (organization_id, id),
  constraint recurring_billing_events_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade
);
create index if not exists recurring_billing_events_billing_idx on public.recurring_billing_events (organization_id, billing_id, created_at);
alter table public.recurring_billing_events enable row level security;
revoke all on public.recurring_billing_events from anon, authenticated;
grant select on public.recurring_billing_events to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_events' and policyname = 'recurring_billing_events_select') then
    create policy recurring_billing_events_select on public.recurring_billing_events for select to authenticated
      using (exists (select 1 from public.recurring_billings b
                      where b.organization_id = recurring_billing_events.organization_id and b.id = recurring_billing_events.billing_id));
  end if;
end;
$$;

create or replace function app.recurring_billings_events() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_commitment date;
begin
  if not app.org_exists(new.organization_id) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on, actor_id)
    values (new.organization_id, new.id, 'created', new.next_cycle_on, auth.uid());
    return null;
  end if;
  if new.status is distinct from old.status then
    v_kind := case new.status when 'paused' then 'paused' when 'cancelled' then 'cancelled' when 'failed' then 'failed'
                              else 'resumed' end;
    if v_kind = 'cancelled' then
      v_commitment := case when new.commitment_months > 0
                           then (new.start_date + make_interval(months => new.commitment_months))::date - 1 end;
      insert into public.recurring_billing_events (organization_id, billing_id, kind, reason, in_commitment, effective_on, actor_id)
      values (new.organization_id, new.id, 'cancelled', new.cancel_reason,
              v_commitment is not null and app.recurring_today(new.organization_id) <= v_commitment, v_commitment, auth.uid());
    else
      insert into public.recurring_billing_events (organization_id, billing_id, kind, make_up, effective_on, actor_id)
      values (new.organization_id, new.id, v_kind, case when v_kind = 'resumed' then current_setting('app.recurring_resume_make_up', true) = new.id::text end,
              new.next_cycle_on, auth.uid());
    end if;
    -- review L1: a resumed billing starts with a clean failure count
    if v_kind = 'resumed' then
      update app.recurring_billing_failures f set failures = 0, last_attempt_at = null
       where f.organization_id = new.organization_id and f.billing_id = new.id and f.failures > 0;
    end if;
  elsif new.billing_day is distinct from old.billing_day then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on, actor_id)
    values (new.organization_id, new.id, 'day_changed', new.next_cycle_on, auth.uid());
  end if;
  if new.status = 'active' and old.next_cycle_on is not null and new.next_cycle_on is null and new.end_date is not null then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on, actor_id)
    values (new.organization_id, new.id, 'ended', new.end_date, auth.uid());
  end if;
  if new.amount_agorot is distinct from old.amount_agorot
     and exists (select 1 from public.recurring_billing_cycles c where c.organization_id = new.organization_id and c.billing_id = new.id) then
    insert into public.recurring_billing_events (organization_id, billing_id, kind, old_amount_agorot, new_amount_agorot, effective_on, actor_id)
    values (new.organization_id, new.id, 'price_changed', old.amount_agorot, new.amount_agorot, new.next_cycle_on, auth.uid());
  end if;
  return null;
end;
$$;
revoke all on function app.recurring_billings_events() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Lines
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_billing_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  billing_id         uuid not null,
  position           integer not null default 0 check (position between 0 and 100000),
  product_id         uuid,
  description        text not null check (char_length(btrim(description)) between 1 and 1000),
  quantity           numeric not null default 1,
  unit_price_agorot  bigint not null default 0 check (unit_price_agorot between 0 and 1000000000000),
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot    bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  total_agorot       bigint not null default 0,
  vat_exempt         boolean not null default false,
  price_source       text not null default 'manual' check (price_source in ('product', 'price_list', 'manual')),
  price_list_id      uuid,
  price_list_name    text,
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint recurring_billing_lines_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade,
  -- no action: a product on a line cannot be removed, only archived (PRD-02)
  constraint recurring_billing_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint recurring_billing_lines_price_list_fk foreign key (organization_id, price_list_id)
    references public.price_lists (organization_id, id) on delete set null (price_list_id),
  constraint recurring_billing_lines_quantity check (quantity > 0 and quantity <= 1000000 and quantity = round(quantity, 3)),
  constraint recurring_billing_lines_one_discount check (discount_bp is null or discount_agorot is null),
  constraint recurring_billing_lines_free_manual check (product_id is not null or price_source = 'manual'),
  constraint recurring_billing_lines_list_source check (price_source = 'price_list' or price_list_id is null)
);
create index if not exists recurring_billing_lines_billing_idx on public.recurring_billing_lines (organization_id, billing_id, position);
create index if not exists recurring_billing_lines_product_idx on public.recurring_billing_lines (organization_id, product_id);
create index if not exists recurring_billing_lines_price_list_idx on public.recurring_billing_lines (organization_id, price_list_id);

alter table public.recurring_billing_lines enable row level security;
revoke all on public.recurring_billing_lines from anon, authenticated;
grant select, delete on public.recurring_billing_lines to authenticated;
grant insert (organization_id, billing_id, position, product_id, description, quantity, unit_price_agorot, discount_bp,
              discount_agorot, vat_exempt, price_source, price_list_id, currency)
  on public.recurring_billing_lines to authenticated;
grant update (position, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, price_source,
              price_list_id, currency)
  on public.recurring_billing_lines to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_select') then
    create policy recurring_billing_lines_select on public.recurring_billing_lines for select to authenticated
      using (exists (select 1 from public.recurring_billings b
                      where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_insert') then
    create policy recurring_billing_lines_insert on public.recurring_billing_lines for insert to authenticated
      with check (app.recurring_billing_writer(organization_id)
                  and exists (select 1 from public.recurring_billings b
                               where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id
                                 and b.status <> 'cancelled'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_update') then
    create policy recurring_billing_lines_update on public.recurring_billing_lines for update to authenticated
      using (app.recurring_billing_writer(organization_id)
             and exists (select 1 from public.recurring_billings b
                          where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id
                            and b.status <> 'cancelled'))
      with check (app.recurring_billing_writer(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_lines' and policyname = 'recurring_billing_lines_delete') then
    create policy recurring_billing_lines_delete on public.recurring_billing_lines for delete to authenticated
      using (app.recurring_billing_writer(organization_id)
             and exists (select 1 from public.recurring_billings b
                          where b.organization_id = recurring_billing_lines.organization_id and b.id = recurring_billing_lines.billing_id
                            and b.status <> 'cancelled'));
  end if;
end;
$$;

-- deal_lines_check's rules for a billing's line (DLI-01, PL-03), in the billing's VAT mode, for every writer
create or replace function app.recurring_billing_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_mode boolean;
  v_status text;
  v_kind text;
  v_active boolean;
  v_archived timestamptz;
  v_name text;
  v_totals jsonb;
begin
  -- outsider guard: a person who may not write here is refused by RLS (42501) right after this trigger
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  select b.prices_include_vat, b.status into v_mode, v_status
    from public.recurring_billings b where b.organization_id = new.organization_id and b.id = new.billing_id;
  if not found then
    -- the foreign key refuses the row (23503)
    return new;
  end if;
  if v_status = 'cancelled' then
    raise exception 'a cancelled recurring billing does not change' using errcode = 'P0001', hint = 'recurring_billing:cancelled';
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('recurring_billing_lines:' || new.billing_id::text, 0));
    if (select count(*) from public.recurring_billing_lines l
         where l.organization_id = new.organization_id and l.billing_id = new.billing_id) >= 200 then
      raise exception 'at most 200 lines in a recurring billing' using errcode = 'P0001', hint = 'recurring_billing_lines:max';
    end if;
    if new.product_id is not null then
      if not app.org_has_feature(new.organization_id, 'products') then
        raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
      end if;
      select p.vat_kind, p.is_active, p.archived_at into v_kind, v_active, v_archived
        from public.products p where p.organization_id = new.organization_id and p.id = new.product_id;
      if found then
        if auth.uid() is not null and (not v_active or v_archived is not null) then
          raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'recurring_billing_lines:product';
        end if;
        new.vat_exempt := v_kind <> 'taxable';
      end if;
    else
      new.vat_exempt := coalesce(new.vat_exempt, false);
    end if;
  else
    new.organization_id := old.organization_id;
    new.billing_id := old.billing_id;
    new.product_id := old.product_id;
    if old.product_id is not null then
      new.vat_exempt := old.vat_exempt;
    else
      new.vat_exempt := coalesce(new.vat_exempt, old.vat_exempt);
    end if;
  end if;

  if (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  if new.price_source <> 'price_list' then
    if new.price_list_id is not null and auth.uid() is not null then
      raise exception 'only a price from a price list names a list' using errcode = 'P0001', hint = 'recurring_billing_lines:price_list';
    end if;
    new.price_list_id := null;
    new.price_list_name := null;
  elsif new.price_list_id is not null and (tg_op = 'INSERT' or new.price_list_id is distinct from old.price_list_id) then
    if not app.org_has_feature(new.organization_id, 'price_lists') then
      raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
    end if;
    select l.name into v_name from public.price_lists l where l.organization_id = new.organization_id and l.id = new.price_list_id;
    new.price_list_name := v_name;
  elsif tg_op = 'INSERT' then
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'recurring_billing_lines:price_list';
  else
    -- a list removed (set null) or unchanged: the line keeps the name it was priced by
    new.price_list_name := old.price_list_name;
  end if;

  v_totals := app.document_totals(
    jsonb_build_array(jsonb_build_object(
      'quantity', new.quantity, 'unit_price_agorot', new.unit_price_agorot, 'discount_bp', new.discount_bp,
      'discount_agorot', new.discount_agorot, 'vat_exempt', new.vat_exempt)),
    0, v_mode);
  new.total_agorot := (v_totals #>> '{lines,0,total_agorot}')::bigint;
  return new;
end;
$$;
revoke all on function app.recurring_billing_lines_check() from public, anon, authenticated;

-- one cycle's amounts of a billing at the VAT rate of a day (null rate: VAT status not set, counted as no VAT)
create or replace function app.recurring_billing_totals(p_org uuid, p_billing uuid, p_day date) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_mode boolean;
  v_rate integer;
  v_lines jsonb;
begin
  select b.prices_include_vat into v_mode from public.recurring_billings b where b.organization_id = p_org and b.id = p_billing;
  if not found then
    return null;
  end if;
  v_rate := app.org_document_vat_rate(p_org, p_day);
  select coalesce(jsonb_agg(jsonb_build_object(
           'quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot, 'discount_bp', l.discount_bp,
           'discount_agorot', l.discount_agorot, 'vat_exempt', l.vat_exempt) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.recurring_billing_lines l where l.organization_id = p_org and l.billing_id = p_billing;
  return app.document_totals(v_lines, coalesce(v_rate, 0), v_mode) || jsonb_build_object('rate_known', v_rate is not null);
end;
$$;
revoke all on function app.recurring_billing_totals(uuid, uuid, date) from public, anon, authenticated, service_role;

-- the billing's amount after its lines changed (a server write of the server-kept column)
create or replace function app.recurring_billing_lines_recompute() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_billing uuid := coalesce(new.billing_id, old.billing_id);
  v_net bigint;
begin
  if not app.org_exists(v_org)
     or not exists (select 1 from public.recurring_billings b where b.organization_id = v_org and b.id = v_billing) then
    return null;
  end if;
  v_net := (app.recurring_billing_totals(v_org, v_billing, app.recurring_today(v_org)) ->> 'net_total_agorot')::bigint;
  perform set_config('app.recurring_billing_server', v_org::text, true);
  update public.recurring_billings b set amount_agorot = coalesce(v_net, 0)
   where b.organization_id = v_org and b.id = v_billing and b.amount_agorot is distinct from coalesce(v_net, 0);
  perform set_config('app.recurring_billing_server', '', true);
  return null;
end;
$$;
revoke all on function app.recurring_billing_lines_recompute() from public, anon, authenticated;

create or replace trigger recurring_billing_lines_check before insert or update on public.recurring_billing_lines
  for each row execute function app.recurring_billing_lines_check();
create or replace trigger recurring_billing_lines_touch before update on public.recurring_billing_lines
  for each row execute function app.touch_row();
-- the list's set-null alone (a removed price list, or the business deleted) is not logged
create or replace trigger recurring_billing_lines_audit after insert or delete on public.recurring_billing_lines
  for each row execute function app.audit_row();
create or replace trigger recurring_billing_lines_audit_update after update of position, description, quantity, unit_price_agorot,
  discount_bp, discount_agorot, vat_exempt, price_source on public.recurring_billing_lines
  for each row execute function app.audit_row();
create or replace trigger recurring_billing_lines_recompute after insert or update or delete on public.recurring_billing_lines
  for each row execute function app.recurring_billing_lines_recompute();

-- ----------------------------------------------------------------------------
-- Cycles (server written; a recorder links the document or skips the cycle)
-- ----------------------------------------------------------------------------
create table if not exists public.recurring_billing_cycles (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  billing_id              uuid not null,
  cycle_on                date not null,
  period_end              date not null,
  net_agorot              bigint not null,
  vat_agorot              bigint not null,
  total_agorot            bigint not null,
  vat_rate_bp             integer,
  currency                text not null default 'ILS' check (currency = 'ILS'),
  status                  text not null default 'due' check (status in ('due', 'documented', 'skipped')),
  accounting_document_id  uuid,
  task_id                 uuid,
  documented_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, id),
  constraint recurring_billing_cycles_once unique (billing_id, cycle_on),
  constraint recurring_billing_cycles_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade,
  constraint recurring_billing_cycles_document_fk foreign key (organization_id, accounting_document_id)
    references public.accounting_documents (organization_id, id) on delete set null (accounting_document_id),
  constraint recurring_billing_cycles_task_fk foreign key (organization_id, task_id)
    references public.tasks (organization_id, id) on delete set null (task_id),
  constraint recurring_billing_cycles_documented check (status <> 'documented' or accounting_document_id is not null)
);
-- owner (352) ב: the draft order the job made for the cycle (server only; a removed draft clears it)
alter table public.recurring_billing_cycles add column if not exists order_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recurring_billing_cycles_order_fk' and conrelid = 'public.recurring_billing_cycles'::regclass) then
    alter table public.recurring_billing_cycles add constraint recurring_billing_cycles_order_fk foreign key (organization_id, order_id)
      references public.orders (organization_id, id) on delete set null (order_id);
  end if;
end;
$$;
create index if not exists recurring_billing_cycles_order_idx on public.recurring_billing_cycles (organization_id, order_id);
create index if not exists recurring_billing_cycles_billing_idx on public.recurring_billing_cycles (organization_id, billing_id, cycle_on);
create index if not exists recurring_billing_cycles_document_idx on public.recurring_billing_cycles (organization_id, accounting_document_id);
-- review L4: one document links to at most one cycle
create unique index if not exists recurring_billing_cycles_document_once on public.recurring_billing_cycles (organization_id, accounting_document_id)
  where accounting_document_id is not null;
create index if not exists recurring_billing_cycles_task_idx on public.recurring_billing_cycles (organization_id, task_id);

alter table public.recurring_billing_cycles enable row level security;
revoke all on public.recurring_billing_cycles from anon, authenticated;
grant select on public.recurring_billing_cycles to authenticated;
grant update (accounting_document_id, status) on public.recurring_billing_cycles to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_cycles' and policyname = 'recurring_billing_cycles_select') then
    create policy recurring_billing_cycles_select on public.recurring_billing_cycles for select to authenticated
      using (exists (select 1 from public.recurring_billings b
                      where b.organization_id = recurring_billing_cycles.organization_id and b.id = recurring_billing_cycles.billing_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recurring_billing_cycles' and policyname = 'recurring_billing_cycles_update') then
    create policy recurring_billing_cycles_update on public.recurring_billing_cycles for update to authenticated
      using (app.recurring_billing_writer(organization_id)
             and exists (select 1 from public.recurring_billings b
                          where b.organization_id = recurring_billing_cycles.organization_id and b.id = recurring_billing_cycles.billing_id))
      with check (app.recurring_billing_writer(organization_id));
  end if;
end;
$$;

-- A person's write: only the document link and the status (column grants); the document read under the caller's RLS, so an
-- unreadable one answers like a missing one. Invoker on purpose (current RLS of accounting_documents).
create or replace function app.recurring_billing_cycles_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_billing record;
  v_doc record;
begin
  if auth.uid() is null then
    return new;
  end if;
  if not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if row(new.organization_id, new.billing_id, new.cycle_on, new.period_end, new.net_agorot, new.vat_agorot, new.total_agorot,
         new.vat_rate_bp, new.task_id, new.order_id, new.created_at)
     is distinct from row(old.organization_id, old.billing_id, old.cycle_on, old.period_end, old.net_agorot, old.vat_agorot,
         old.total_agorot, old.vat_rate_bp, old.task_id, old.order_id, old.created_at)
     and not (pg_trigger_depth() > 1 and ((old.task_id is not null and new.task_id is null) or (old.order_id is not null and new.order_id is null))) then
    raise exception 'a cycle keeps its date and amounts' using errcode = 'P0001', hint = 'recurring_cycle:fixed';
  end if;
  if new.accounting_document_id is distinct from old.accounting_document_id then
    if new.accounting_document_id is not null then
      select b.contact_id, b.company_id, b.deal_id into v_billing
        from public.recurring_billings b where b.organization_id = new.organization_id and b.id = new.billing_id;
      select d.contact_id, d.company_id, d.deal_id, d.status, d.doc_type,
             (select c.company_id from public.contacts c where c.organization_id = d.organization_id and c.id = d.contact_id) as contact_company
        into v_doc
        from public.accounting_documents d where d.organization_id = new.organization_id and d.id = new.accounting_document_id;
      if not found or v_doc.status <> 'active' or v_doc.doc_type not in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'proforma')
         -- review L4: the billing's own customer (a contact's own document; a company's, or one of its contacts'), not merely
         -- the same deal
         or not ((v_billing.contact_id is not null and v_doc.contact_id = v_billing.contact_id)
                 or (v_billing.company_id is not null and (v_doc.company_id = v_billing.company_id or v_doc.contact_company = v_billing.company_id))) then
        raise exception 'an active invoice or receipt of the same customer' using errcode = 'P0001', hint = 'recurring_cycle:document';
      end if;
      -- one document is the record of one cycle (the unique index holds it under races)
      if exists (select 1 from public.recurring_billing_cycles c
                  where c.organization_id = new.organization_id and c.accounting_document_id = new.accounting_document_id and c.id <> new.id) then
        raise exception 'the document is already the record of another cycle' using errcode = 'P0001', hint = 'recurring_cycle:document_used';
      end if;
      new.status := 'documented';
      new.documented_at := now();
    else
      new.documented_at := null;
      if new.status = 'documented' then
        new.status := 'due';
      end if;
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'documented' or (new.status = 'skipped' and new.accounting_document_id is not null) then
      raise exception 'a documented cycle names its document' using errcode = 'P0001', hint = 'recurring_cycle:status';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.recurring_billing_cycles_check() from public, anon, authenticated;

-- a documented or skipped cycle closes its open task (definer: the task may be another person's)
create or replace function app.recurring_billing_cycles_close_task() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.task_id is not null and new.status in ('documented', 'skipped') and new.status is distinct from old.status then
    update public.tasks t
       set status = 'done',
           outcome = case new.status when 'documented' then 'נסגרה: נרשם מסמך למחזור' else 'נסגרה: המחזור דולג' end
     where t.organization_id = new.organization_id and t.id = new.task_id and t.status = 'open';
  -- review L4: a cycle back to waiting reopens the task the cycle closed (never one a person closed with their own note)
  elsif new.task_id is not null and new.status = 'due' and old.status in ('documented', 'skipped') then
    update public.tasks t set status = 'open', outcome = null
     where t.organization_id = new.organization_id and t.id = new.task_id and t.status = 'done'
       and t.outcome in ('נסגרה: נרשם מסמך למחזור', 'נסגרה: המחזור דולג');
  end if;
  return null;
end;
$$;
revoke all on function app.recurring_billing_cycles_close_task() from public, anon, authenticated;

create or replace trigger recurring_billing_cycles_check before update on public.recurring_billing_cycles
  for each row execute function app.recurring_billing_cycles_check();
create or replace trigger recurring_billing_cycles_touch before update on public.recurring_billing_cycles
  for each row execute function app.touch_row();
-- a person's link or status (the task's set-null, from a purge, is not logged)
create or replace trigger recurring_billing_cycles_audit after update of accounting_document_id, status on public.recurring_billing_cycles
  for each row execute function app.audit_row();
create or replace trigger recurring_billing_cycles_close_task after update on public.recurring_billing_cycles
  for each row execute function app.recurring_billing_cycles_close_task();

-- the events trigger reads cycles, so it is made after them
create or replace trigger recurring_billings_events after insert or update on public.recurring_billings
  for each row execute function app.recurring_billings_events();

-- ----------------------------------------------------------------------------
-- The job (SUB-02 method A)
-- ----------------------------------------------------------------------------
create table if not exists app.recurring_billing_failures (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  billing_id       uuid not null,
  cycle_on         date not null,
  failures         integer not null default 0,
  last_attempt_at  timestamptz,
  primary key (billing_id, cycle_on),
  constraint recurring_billing_failures_billing_fk foreign key (organization_id, billing_id)
    references public.recurring_billings (organization_id, id) on delete cascade
);
create index if not exists recurring_billing_failures_org_idx on app.recurring_billing_failures (organization_id, billing_id);
alter table app.recurring_billing_failures enable row level security;
revoke all on app.recurring_billing_failures from public, anon, authenticated, service_role;

create table if not exists app.recurring_billing_turns (
  organization_id  uuid primary key references public.organizations (id) on delete cascade,
  served_at        timestamptz not null
);
alter table app.recurring_billing_turns enable row level security;
revoke all on app.recurring_billing_turns from public, anon, authenticated, service_role;

create or replace function app.recurring_billing_per_org() returns integer language sql stable set search_path = '' as $$
  select least(200, greatest(1, coalesce(nullif(current_setting('app.recurring_billing_per_org', true), '')::integer, 200)))
$$;
create or replace function app.recurring_billing_limit() returns integer language sql stable set search_path = '' as $$
  select least(2000, greatest(1, coalesce(nullif(current_setting('app.recurring_billing_limit', true), '')::integer, 2000)))
$$;
revoke all on function app.recurring_billing_per_org() from public, anon, authenticated, service_role;
revoke all on function app.recurring_billing_limit() from public, anon, authenticated, service_role;

-- the rep of a billing: MNY-01's owner rule (the deal's owner, else the customer's), an active full-seat non-viewer; else the
-- business's owner, else its oldest admin
create or replace function app.recurring_billing_rep(p_org uuid, p_billing uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select m.user_id
       from public.recurring_billings b
       left join public.deals dl on dl.organization_id = b.organization_id and dl.id = b.deal_id and dl.deleted_at is null
       left join public.contacts ct on ct.organization_id = b.organization_id and ct.id = b.contact_id
       left join public.companies co on co.organization_id = b.organization_id and co.id = b.company_id
       join public.memberships m on m.organization_id = b.organization_id
        and m.user_id = coalesce(dl.owner_id, ct.owner_id, co.owner_id)
        and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
      where b.organization_id = p_org and b.id = p_billing),
    (select m.user_id from public.memberships m
      where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin')
      order by (m.role = 'owner') desc, m.created_at, m.user_id
      limit 1))
$$;
revoke all on function app.recurring_billing_rep(uuid, uuid) from public, anon, authenticated, service_role;



-- owner (352) ב: the draft order of one cycle: the billing's customer, its live deal of the same customer, its lines as
-- priced in the billing (one-time lines of this cycle's charge), the billing's VAT mode, owner = the rep. Written as the server
-- (app.order_server, no session in the job), so every order rule of app.orders_check / app.order_lines_check applies to a
-- server's manual draft. Only with the `orders` key and the orders module on; null otherwise. The caller holds an exception
-- block: a refused order leaves the cycle and its task, and one `order_not_made` event.
create or replace function app.recurring_cycle_order(p_org uuid, p_billing uuid, p_rep uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.recurring_billings;
  v_order uuid := gen_random_uuid();
  v_deal uuid;
  v_server text := current_setting('app.order_server', true);
begin
  if not app.org_has_feature(p_org, 'orders')
     or not coalesce((select mo.orders_enabled from public.org_modules mo where mo.organization_id = p_org), false) then
    return null;
  end if;
  select * into v_b from public.recurring_billings b where b.organization_id = p_org and b.id = p_billing;
  select d.id into v_deal from public.deals d
   where d.organization_id = p_org and d.id = v_b.deal_id and d.deleted_at is null
     and d.contact_id is not distinct from v_b.contact_id
     and (v_b.company_id is null or d.company_id = v_b.company_id);
  -- delta review L-c (CAL-13's rule): the rep owns the draft only while they read its parent (the deal when attached, else the
  -- contact, else the company); otherwise the draft has no owner
  if p_rep is not null and not coalesce((
       select app.user_can_read_record(p_org, p_rep, r.owner_id, r.team_id)
         from (select d.owner_id, d.team_id from public.deals d where d.organization_id = p_org and d.id = v_deal
               union all
               select c.owner_id, c.team_id from public.contacts c where c.organization_id = p_org and c.id = v_b.contact_id and v_deal is null
               union all
               select co.owner_id, co.team_id from public.companies co
                where co.organization_id = p_org and co.id = v_b.company_id and v_deal is null and v_b.contact_id is null) r
        limit 1), false) then
    p_rep := null;
  end if;
  perform set_config('app.order_server', 'on', true);
  -- the order is dated the day it is made, and its VAT is that day's (app.orders_check sets order_date for every new order); the
  -- cycle row keeps the amounts at the cycle date's rate
  insert into public.orders (id, organization_id, status, source, deal_id, contact_id, company_id, owner_id, prices_include_vat, currency)
  values (v_order, p_org, 'draft', 'manual', v_deal, v_b.contact_id, v_b.company_id, p_rep, v_b.prices_include_vat, 'ILS');
  insert into public.order_lines (organization_id, order_id, position, kind, product_id, name, description, quantity, unit_price_agorot,
                                  discount_bp, discount_agorot, vat_exempt, billing, price_source, price_list_id, currency)
  select p_org, v_order, row_number() over (order by l.position, l.id), 'item', l.product_id, left(btrim(l.description), 300),
         case when char_length(btrim(l.description)) > 300 then l.description end,
         l.quantity, l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt, 'one_time',
         case when l.price_source = 'price_list' and l.price_list_id is null then 'manual' else l.price_source end,
         l.price_list_id, 'ILS'
    from public.recurring_billing_lines l
   where l.organization_id = p_org and l.billing_id = p_billing
   order by l.position, l.id;
  perform set_config('app.order_server', coalesce(v_server, ''), true);
  return v_order;
end;
$$;
revoke all on function app.recurring_cycle_order(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- One cycle of a billing on a day: its row, its task and (352) its draft order; nothing for a billing with no lines (one
-- `no_lines` event until a cycle is made again). Returns the next billing date (null past the end date). Called by the job
-- inside its per-billing exception block, with app.recurring_billing_server set.
create or replace function app.recurring_billing_make_cycle(p_org uuid, p_billing uuid, p_on date) returns date
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.recurring_billings;
  v_zone text;
  v_next date;
  v_end date;
  v_totals jsonb;
  v_cycle uuid;
  v_task uuid;
  v_order uuid;
  v_rep uuid;
begin
  select * into v_b from public.recurring_billings b where b.organization_id = p_org and b.id = p_billing;
  v_zone := app.intake_zone((select o.timezone from public.organizations o where o.id = p_org));
  v_next := app.recurring_next_cycle(v_b.start_date, v_b.cycle, v_b.billing_day, p_on + 1);
  v_end := v_next - 1;
  if v_b.end_date is not null and v_end > v_b.end_date then
    v_end := v_b.end_date;
  end if;
  if not exists (select 1 from public.recurring_billing_lines l where l.organization_id = p_org and l.billing_id = p_billing) then
    -- review L3: a billing with no lines makes no cycle and no task; it says so once (until a cycle is made again)
    if not exists (select 1 from public.recurring_billing_events e
                    where e.organization_id = p_org and e.billing_id = p_billing and e.kind = 'no_lines'
                      and e.created_at > coalesce((select max(c.created_at) from public.recurring_billing_cycles c
                                                    where c.organization_id = p_org and c.billing_id = p_billing), '-infinity')) then
      insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on)
      values (p_org, p_billing, 'no_lines', p_on);
    end if;
  else
    v_totals := app.recurring_billing_totals(p_org, p_billing, p_on);
    insert into public.recurring_billing_cycles (organization_id, billing_id, cycle_on, period_end, net_agorot, vat_agorot,
                                                 total_agorot, vat_rate_bp)
    values (p_org, p_billing, p_on, v_end,
            (v_totals ->> 'net_total_agorot')::bigint, (v_totals ->> 'vat_agorot')::bigint, (v_totals ->> 'total_agorot')::bigint,
            case when (v_totals ->> 'rate_known')::boolean then (v_totals ->> 'rate_bp')::integer end)
    on conflict (billing_id, cycle_on) do nothing
    returning id into v_cycle;
  end if;

  if v_cycle is not null then
    v_rep := app.recurring_billing_rep(p_org, p_billing);
    insert into public.tasks (organization_id, title, description, task_type, due_at, priority, owner_id, deal_id, contact_id, company_id)
    values (p_org,
            left('חיוב חוזר: ' || v_b.name || ' · מחזור ' || to_char(p_on, 'DD/MM/YYYY'), 300),
            'להפיק מסמך ללקוח במערכת החשבונות, לרשום אותו במסמכים ולשייך אותו למחזור בדף החיוב החוזר. אם נוצרה טיוטת הזמנה, לבדוק ולאשר אותה.',
            'todo', greatest(now(), (p_on + time '12:00') at time zone v_zone), 2, v_rep,
            (select dl.id from public.deals dl where dl.organization_id = p_org and dl.id = v_b.deal_id and dl.deleted_at is null),
            v_b.contact_id, v_b.company_id)
    returning id into v_task;
    -- owner (352) ב: the cycle's draft order, in its own block (a refused order leaves the cycle and the task)
    begin
      v_order := app.recurring_cycle_order(p_org, p_billing, v_rep);
    exception when others then
      v_order := null;
      perform set_config('app.order_server', '', true);
      insert into public.recurring_billing_events (organization_id, billing_id, kind, effective_on)
      values (p_org, p_billing, 'order_not_made', p_on);
      raise warning 'crm-recurring-billings: billing % cycle % order not made (SQLSTATE %)', p_billing, p_on, sqlstate;
    end;
    update public.recurring_billing_cycles c set task_id = v_task, order_id = v_order
     where c.organization_id = p_org and c.id = v_cycle;
    insert into public.recurring_billing_events (organization_id, billing_id, kind, new_amount_agorot, effective_on)
    values (p_org, p_billing, 'cycle_due', (v_totals ->> 'net_total_agorot')::bigint, p_on);
  end if;
  return case when v_b.end_date is not null and v_next > v_b.end_date then null else v_next end;
end;
$$;
revoke all on function app.recurring_billing_make_cycle(uuid, uuid, date) from public, anon, authenticated, service_role;

create or replace function app.run_recurring_billings(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_on date;
  v_skipped integer;
  v_done integer := 0;
  v_failures integer;
  v_served uuid[] := '{}'::uuid[];
  -- cycles made per business in this run (a make-up counts each of its cycles against the per-business cap)
  v_counts jsonb := '{}'::jsonb;
  v_made integer;
  -- the cycle date being made when the block failed (delta review 2: the failure is kept under the date really tried)
  v_trying date;
begin
  for v_row in
    select z.* from (
      select b.organization_id, b.id, b.cycle, b.start_date, b.billing_day, b.end_date, b.next_cycle_on, b.make_up_until,
             t0.today, f.last_attempt_at, coalesce(f.failures, 0) as failures, tn.served_at,
             row_number() over (partition by b.organization_id order by f.last_attempt_at nulls first, b.next_cycle_on, b.id) as n
        from public.recurring_billings b
        join public.organizations o on o.id = b.organization_id
        cross join lateral (select app.intake_zone(o.timezone) as zone, (now() at time zone app.intake_zone(o.timezone))::date as today) t0
        left join app.recurring_billing_failures f on f.billing_id = b.id and f.cycle_on = b.next_cycle_on
        left join app.recurring_billing_turns tn on tn.organization_id = b.organization_id
       where (p_orgs is null or b.organization_id = any (p_orgs))
         and b.status = 'active'
         and b.next_cycle_on is not null
         and b.next_cycle_on <= current_date + 1
         and b.next_cycle_on <= t0.today
         and (now() at time zone t0.zone)::time >= time '08:00'
         and app.org_writable(b.organization_id)
         and app.org_has_feature(b.organization_id, 'recurring_billing')
         and not exists (select 1 from public.contacts ct where ct.organization_id = b.organization_id and ct.id = b.contact_id and ct.deleted_at is not null)
         and not exists (select 1 from public.companies co where co.organization_id = b.organization_id and co.id = b.company_id and co.deleted_at is not null)
    ) z
     where z.n <= app.recurring_billing_per_org()
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.next_cycle_on, z.id
     limit app.recurring_billing_limit()
  loop
    if not (v_row.organization_id = any (v_served)) then
      v_served := v_served || v_row.organization_id;
    end if;
    v_made := coalesce((v_counts ->> v_row.organization_id::text)::integer, 0);
    if v_made >= app.recurring_billing_per_org() then
      continue;
    end if;
    begin
      perform set_config('app.recurring_billing_server', v_row.organization_id::text, true);
      v_on := v_row.next_cycle_on;
      v_trying := null;
      -- review L2: after a gap (the business could not write, the key was off, the customer in the bin) the missed cycles are
      -- not made: one event counts them and the billing goes on from the first billing date from today. Owner (353) ג: a resume
      -- that chose to make them up (make_up_until) makes every one, each counted against the per-business cap.
      -- delta review L-b: a cycle that failed (fewer than 3 times) is tried again on its own date, alone; delta review 2: the
      -- gap rule then applies from the date after it, so a retry never makes the cycles that passed meanwhile
      if v_row.failures > 0 and v_on < v_row.today and not (v_row.make_up_until is not null and v_on <= v_row.make_up_until)
         and not (v_row.end_date is not null and v_on > v_row.end_date) then
        v_trying := v_on;
        v_on := app.recurring_billing_make_cycle(v_row.organization_id, v_row.id, v_on);
        v_trying := null;
        v_made := v_made + 1;
      end if;
      if v_on is not null and v_on < v_row.today and not (v_row.make_up_until is not null and v_on <= v_row.make_up_until) then
        v_skipped := app.recurring_cycles_between(v_row.start_date, v_row.cycle, v_row.billing_day, v_on,
                       least(v_row.today, coalesce(v_row.end_date + 1, v_row.today)));
        v_on := app.recurring_next_cycle(v_row.start_date, v_row.cycle, v_row.billing_day, v_row.today);
        if v_skipped > 0 then
          insert into public.recurring_billing_events (organization_id, billing_id, kind, skipped_cycles, effective_on)
          values (v_row.organization_id, v_row.id, 'cycles_skipped', v_skipped, v_on);
        end if;
      end if;
      loop
        exit when v_on is null or v_on > v_row.today or (v_row.end_date is not null and v_on > v_row.end_date)
                  or v_made >= app.recurring_billing_per_org();
        v_trying := v_on;
        v_on := app.recurring_billing_make_cycle(v_row.organization_id, v_row.id, v_on);
        v_trying := null;
        v_made := v_made + 1;
      end loop;
      if v_row.end_date is not null and v_on > v_row.end_date then
        v_on := null;
      end if;
      update public.recurring_billings b
         set next_cycle_on = v_on,
             make_up_until = case when v_on is null or b.make_up_until is null or v_on > b.make_up_until then null else b.make_up_until end
       where b.organization_id = v_row.organization_id and b.id = v_row.id;
      -- review L1: a billing that went through clears its failure count
      update app.recurring_billing_failures f set failures = 0, last_attempt_at = null
       where f.organization_id = v_row.organization_id and f.billing_id = v_row.id and f.failures > 0;
      perform set_config('app.recurring_billing_server', '', true);
      v_counts := v_counts || jsonb_build_object(v_row.organization_id::text, v_made);
      v_done := v_done + 1;
    exception when others then
      insert into app.recurring_billing_failures (organization_id, billing_id, cycle_on, failures, last_attempt_at)
      values (v_row.organization_id, v_row.id, coalesce(v_trying, v_row.next_cycle_on), 1, now())
      on conflict (billing_id, cycle_on)
        do update set failures = app.recurring_billing_failures.failures + 1, last_attempt_at = excluded.last_attempt_at
      returning failures into v_failures;
      if v_failures >= 3 then
        perform set_config('app.recurring_billing_server', v_row.organization_id::text, true);
        -- delta review 2 (L): a failed billing keeps no pending make-up (its resume asks again)
        update public.recurring_billings b set status = 'failed', make_up_until = null
         where b.organization_id = v_row.organization_id and b.id = v_row.id and b.status = 'active';
      end if;
      perform set_config('app.recurring_billing_server', '', true);
      raise warning 'crm-recurring-billings: billing % failed (SQLSTATE %)%', v_row.id, sqlstate,
        case when v_failures >= 3 then ', marked failed after 3 failures' else '' end;
    end;
  end loop;

  insert into app.recurring_billing_turns (organization_id, served_at)
  select o, clock_timestamp() from unnest(v_served) o
  on conflict (organization_id) do update set served_at = excluded.served_at;
  return v_done;
end;
$$;
revoke all on function app.run_recurring_billings(uuid[]) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-recurring-billings', '*/15 * * * *', 'select app.run_recurring_billings();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Owner (353) ג: resume, and say whether the missed cycles are made up (invoker: the person's own update under RLS)
-- ----------------------------------------------------------------------------
create or replace function public.recurring_billing_resume(p_org uuid, p_billing uuid, p_make_up boolean) returns boolean
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform set_config('app.recurring_resume_make_up', case when coalesce(p_make_up, false) then p_billing::text else '' end, true);
  update public.recurring_billings b set status = 'active'
   where b.organization_id = p_org and b.id = p_billing and b.status in ('paused', 'failed');
  get diagnostics v_n = row_count;
  perform set_config('app.recurring_resume_make_up', '', true);
  return v_n > 0;
end;
$$;
revoke all on function public.recurring_billing_resume(uuid, uuid, boolean) from public, anon;
grant execute on function public.recurring_billing_resume(uuid, uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- SUB-03: one click from a won deal (invoker: every write is the person's)
-- ----------------------------------------------------------------------------
create or replace function public.recurring_billing_from_deal(p_org uuid, p_deal uuid) returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_deal record;
  v_cycle text;
  v_mode boolean;
  v_start date;
  v_billing uuid;
  v_line record;
  v_copied integer := 0;
  v_skipped integer := 0;
  v_other integer := 0;
begin
  select d.id, d.name, d.contact_id, d.company_id, d.billing_kind, d.recurring_start_date, d.deleted_at, s.kind as stage_kind
    into v_deal
    from public.deals d join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
   where d.organization_id = p_org and d.id = p_deal;
  if not found or v_deal.deleted_at is not null then
    raise exception 'deal not found' using errcode = '42501';
  end if;
  if v_deal.stage_kind <> 'won' then
    raise exception 'the deal is not won' using errcode = 'P0001', hint = 'recurring_billing:deal_not_won';
  end if;
  if v_deal.contact_id is null and v_deal.company_id is null then
    raise exception 'the deal has no customer' using errcode = 'P0001', hint = 'recurring_billing:deal_customer';
  end if;
  v_cycle := case when v_deal.billing_kind in ('monthly', 'yearly') then v_deal.billing_kind end;
  if v_cycle is null then
    select l.billing into v_cycle from public.deal_lines l
     where l.organization_id = p_org and l.deal_id = p_deal and l.billing in ('monthly', 'quarterly', 'yearly')
     order by l.position, l.id limit 1;
  end if;
  if v_cycle is null then
    raise exception 'the deal has no recurring lines' using errcode = 'P0001', hint = 'recurring_billing:deal_no_lines';
  end if;
  select l.price_includes_vat into v_mode from public.deal_lines l
   where l.organization_id = p_org and l.deal_id = p_deal order by l.created_at, l.id limit 1;
  v_start := coalesce(v_deal.recurring_start_date,
    (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date);

  insert into public.recurring_billings (organization_id, contact_id, company_id, deal_id, name, cycle, start_date, billing_day,
                                         prices_include_vat)
  values (p_org, v_deal.contact_id, case when v_deal.contact_id is null then v_deal.company_id end, p_deal,
          left(btrim(v_deal.name), 120), v_cycle, v_start, case when extract(day from v_start) > 28 then 0 else extract(day from v_start)::integer end, v_mode)
  returning id into v_billing;

  for v_line in
    select l.* from public.deal_lines l where l.organization_id = p_org and l.deal_id = p_deal order by l.position, l.id
  loop
    if coalesce(v_line.billing, 'one_time') <> v_cycle then
      v_other := v_other + 1;
      continue;
    end if;
    begin
      insert into public.recurring_billing_lines (organization_id, billing_id, position, product_id, description, quantity,
                                                  unit_price_agorot, discount_bp, discount_agorot, vat_exempt, price_source, price_list_id)
      values (p_org, v_billing, v_line.position, v_line.product_id, v_line.description, v_line.quantity, v_line.unit_price_agorot,
              v_line.discount_bp, v_line.discount_agorot, v_line.vat_exempt,
              -- review L6: a list price whose list was removed keeps its price as a typed one
              case when v_line.price_source = 'price_list' and v_line.price_list_id is null then 'manual' else v_line.price_source end,
              case when v_line.price_source = 'price_list' then v_line.price_list_id end);
      v_copied := v_copied + 1;
    exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
      v_skipped := v_skipped + 1;
    end;
  end loop;
  if v_copied = 0 then
    raise exception 'no recurring line could be copied' using errcode = 'P0001', hint = 'recurring_billing:deal_no_lines';
  end if;
  return jsonb_build_object('id', v_billing, 'copied', v_copied, 'skipped', v_skipped, 'other_period', v_other);
end;
$$;
revoke all on function public.recurring_billing_from_deal(uuid, uuid) from public, anon;
grant execute on function public.recurring_billing_from_deal(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- SUB-05: the report (INVOKER: RLS decides what is counted)
-- ----------------------------------------------------------------------------
-- review M3: how many billings the business has whose customer is not in the bin (count only, members only), for the partial
-- rule of the report (BAL-01 / COL-06): a caller who reads fewer gets the rows they read and no totals
create or replace function app.recurring_billing_count(p_org uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then (
    select count(*)::integer from public.recurring_billings r
     where r.organization_id = p_org
       and not exists (select 1 from public.contacts c where c.organization_id = r.organization_id and c.id = r.contact_id and c.deleted_at is not null)
       and not exists (select 1 from public.companies co where co.organization_id = r.organization_id and co.id = r.company_id and co.deleted_at is not null))
  end
$$;
revoke all on function app.recurring_billing_count(uuid) from public, anon;
grant execute on function app.recurring_billing_count(uuid) to authenticated;

-- Owner (356) ב: owners, admins and managers by role (app.membership_role); review M3's partial rule stays. Owner (357) ג:
-- every amount before VAT and with VAT: each billing's lines in its own VAT mode (app.document_totals, exempt lines included),
-- VAT at today's rate, and for next month's expected cycles at the rate of each cycle's date; a business whose VAT status is
-- not set counts no VAT. A cycle's amount per month: quarterly / 3 and yearly / 12, half up, per billing.
create or replace function public.report_recurring_billing(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
as $$
declare
  v_zone text;
  v_today date;
  v_rate integer;
  v_next_first date;
  v_next_last date;
  v_read integer;
  v_partial boolean;
  v_result jsonb;
begin
  if coalesce(app.membership_role(p_org)::text, '') not in ('owner', 'admin', 'manager')
     or not app.org_has_feature(p_org, 'recurring_billing') then
    return jsonb_build_object('allowed', false);
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  v_zone := coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem');
  v_today := (now() at time zone v_zone)::date;
  v_rate := coalesce(app.org_document_vat_rate(p_org, v_today), 0);
  v_next_first := (date_trunc('month', v_today) + interval '1 month')::date;
  v_next_last := (v_next_first + interval '1 month')::date - 1;

  with r as (
    -- the billings the caller reads (RLS), their customer not in the bin (as the job)
    select b.id, coalesce(b.contact_id, b.company_id) as customer, b.cycle, b.status, b.start_date, b.billing_day, b.end_date,
           b.next_cycle_on, b.cancelled_at, b.prices_include_vat,
           (select coalesce(jsonb_agg(jsonb_build_object('quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot,
                                                         'discount_bp', l.discount_bp, 'discount_agorot', l.discount_agorot,
                                                         'vat_exempt', l.vat_exempt) order by l.position, l.id), '[]'::jsonb)
              from public.recurring_billing_lines l where l.organization_id = b.organization_id and l.billing_id = b.id) as lines
      from public.recurring_billings b
     where b.organization_id = p_org
       and not exists (select 1 from public.contacts c where c.organization_id = b.organization_id and c.id = b.contact_id and c.deleted_at is not null)
       and not exists (select 1 from public.companies co where co.organization_id = b.organization_id and co.id = b.company_id and co.deleted_at is not null)
  ),
  t as (
    select r.*, app.document_totals(r.lines, v_rate, r.prices_include_vat) as now_totals,
           (r.status = 'active' and (r.end_date is null or r.end_date >= v_today)) as live,
           app.recurring_next_cycle(r.start_date, r.cycle, r.billing_day, greatest(v_next_first, coalesce(r.next_cycle_on, v_next_first))) as next_cycle,
           case when r.status = 'cancelled' then (r.cancelled_at at time zone v_zone)::date
                when r.end_date is not null and r.end_date < v_today then r.end_date end as ended_on
      from r
  ),
  b as (
    select t.*,
           app.recurring_monthly_amount((t.now_totals ->> 'net_total_agorot')::bigint, t.cycle) as mrr,
           app.recurring_monthly_amount((t.now_totals ->> 'total_agorot')::bigint, t.cycle) as mrr_with_vat,
           (t.live and t.next_cycle_on is not null and t.next_cycle between v_next_first and v_next_last
            and (t.end_date is null or t.next_cycle <= t.end_date)) as next_month_due
      from t
  ),
  nm as (
    select b.id, app.document_totals(b.lines, coalesce(app.org_document_vat_rate(p_org, b.next_cycle), 0), b.prices_include_vat) as totals
      from b where b.next_month_due
  ),
  customers as (
    select b.customer, min(b.start_date) as first_on,
           case when bool_and(b.ended_on is not null) then max(b.ended_on) end as churned_on
      from b group by b.customer
  ),
  months as (
    select m::date as month from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') m
  )
  select jsonb_build_object(
           'read', (select count(*) from b),
           'totals', (select jsonb_build_object(
                         'mrr', coalesce(sum(b.mrr) filter (where b.live), 0),
                         'mrr_with_vat', coalesce(sum(b.mrr_with_vat) filter (where b.live), 0),
                         'active_billings', count(*) filter (where b.live),
                         'active_customers', count(distinct b.customer) filter (where b.live),
                         'paused_billings', count(*) filter (where b.status = 'paused'),
                         'failed_billings', count(*) filter (where b.status = 'failed'),
                         'next_month', coalesce((select sum((nm.totals ->> 'net_total_agorot')::bigint) from nm), 0),
                         'next_month_with_vat', coalesce((select sum((nm.totals ->> 'total_agorot')::bigint) from nm), 0),
                         'next_month_cycles', count(*) filter (where b.next_month_due))
                        from b),
           'by_month', (select coalesce(jsonb_agg(jsonb_build_object(
                           'month', m.month,
                           'new_customers', (select count(*) from customers c where date_trunc('month', c.first_on) = m.month),
                           'new_mrr', coalesce((select sum(b.mrr) from b where date_trunc('month', b.start_date) = m.month), 0),
                           'new_mrr_with_vat', coalesce((select sum(b.mrr_with_vat) from b where date_trunc('month', b.start_date) = m.month), 0),
                           'churned_customers', (select count(*) from customers c where date_trunc('month', c.churned_on) = m.month),
                           'churned_mrr', coalesce((select sum(b.mrr) from b where date_trunc('month', b.ended_on) = m.month), 0),
                           'churned_mrr_with_vat', coalesce((select sum(b.mrr_with_vat) from b where date_trunc('month', b.ended_on) = m.month), 0))
                         order by m.month), '[]'::jsonb) from months m))
    into v_result;

  v_read := (v_result ->> 'read')::integer;
  -- review M3: a caller who does not read every billing of the business gets the counts of the ones they read, no amounts
  v_partial := v_read < coalesce(app.recurring_billing_count(p_org), 0);
  return jsonb_build_object(
    'allowed', true, 'partial', v_partial, 'currency', 'ILS', 'next_month', v_next_first,
    'totals', case when v_partial then null else v_result -> 'totals' end,
    'by_month', case when v_partial
                     then (select coalesce(jsonb_agg(x || jsonb_build_object('new_mrr', null, 'new_mrr_with_vat', null, 'churned_mrr', null,
                                                                               'churned_mrr_with_vat', null) order by x ->> 'month'), '[]'::jsonb)
                             from jsonb_array_elements(v_result -> 'by_month') x)
                     else v_result -> 'by_month' end);
end;
$$;
revoke all on function public.report_recurring_billing(uuid, date, date) from public, anon;
grant execute on function public.report_recurring_billing(uuid, date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- log_export: the body of 20261006021169_punch_card_report.sql with the report key recurring_billing added
-- ----------------------------------------------------------------------------
create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if not app.can_export(p_org) then
      raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue', 'debt_aging', 'collection', 'recurring', 'campaign_roi', 'punch_cards', 'recurring_billing') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
    -- DLI-06: gross profit carries costs
    if p_report = 'profit' and not app.can_view_costs(p_org) then
      raise exception 'the gross profit report is for those who may see costs' using errcode = '42501';
    end if;
    -- QUO-17: the quotes report belongs to the quotes capability
    if p_report = 'quotes' and not app.org_has_feature(p_org, 'quotes') then
      raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
    end if;
    -- SEG-03 (owner (61) ב): the campaign ROI report belongs to the campaign_costs capability
    if p_report = 'campaign_roi' and not app.org_has_feature(p_org, 'campaign_costs') then
      raise exception 'campaign costs are not in this plan' using errcode = 'P0001', hint = 'feature:campaign_costs';
    end if;
    -- PKG-07: the punch cards report belongs to the punch_cards capability
    if p_report = 'punch_cards' then
      -- owner (118) ב: the report is for owners, admins and managers by role (an export grant alone is not enough)
      if coalesce(app.membership_role(p_org)::text, '') not in ('owner', 'admin', 'manager') then
        raise exception 'the punch cards report is for owners, admins and managers' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'punch_cards') then
        raise exception 'punch cards are not in this plan' using errcode = 'P0001', hint = 'feature:punch_cards';
      end if;
    end if;
    -- SUB-05 (owner (356) ב): the recurring billing report is for owners, admins and managers by role, with its plan key
    if p_report = 'recurring_billing' then
      if coalesce(app.membership_role(p_org)::text, '') not in ('owner', 'admin', 'manager') then
        raise exception 'the recurring billing report is for owners, admins and managers' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'recurring_billing') then
        raise exception 'recurring billing is not in this plan' using errcode = 'P0001', hint = 'feature:recurring_billing';
      end if;
    end if;
    -- BAL-03: debt aging is for those who open a ledger (BAL-01's rule), with its three keys
    if p_report = 'debt_aging' then
      if not app.can_record_payments(p_org) then
        raise exception 'debt aging is for those who record payments' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'balances') then
        raise exception 'balances are not in this plan' using errcode = 'P0001', hint = 'feature:balances';
      end if;
      if not (app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments')) then
        raise exception 'documents and payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
      end if;
    end if;
    -- COL-06: the collection report is for those who open the collection screen (BAL-01's rule), with its three keys
    if p_report = 'collection' then
      if not app.can_record_payments(p_org) then
        raise exception 'the collection report is for those who record payments' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'collection') then
        raise exception 'collection is not in this plan' using errcode = 'P0001', hint = 'feature:collection';
      end if;
      if not (app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments')) then
        raise exception 'documents and payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
      end if;
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export; a PDF only for a report (the full export is a zip)
  if p_format is null or p_format not in ('csv', 'xlsx', 'pdf') or (p_format = 'pdf' and p_kind <> 'report') then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02 (owner, 1 November 2026, answer (4) א): a report's PDF is made on our server for every export, never stored, and
  -- counts one production in max_pdf_per_month (app.pdf_take: limit:max_pdf_per_month, rate:pdf, the 80% notice). Taken in
  -- the same statement as the audit entry, so a refused export counts nothing and leaves no entry.
  if p_format = 'pdf' then
    perform app.pdf_take(p_org);
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;
