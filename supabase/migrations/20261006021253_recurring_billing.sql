-- Part 1 of 8 (021253-021260, split so each part fits one apply call; they run in name order).
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
