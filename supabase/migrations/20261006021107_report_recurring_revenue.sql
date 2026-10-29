-- =============================================================================
-- RPT-01 (rest): the recurring revenue report ("הכנסה חוזרת", MRR)
-- =============================================================================
-- Owner's answer, 18 October 2026 (DECISIONS.md "דוח הכנסה חוזרת (MRR)"): (1) every plan, no plan key; (2) (ג) NEW
-- recurring revenue by the month a deal was closed, now; recurring revenue that ended (churn) only once a subscriptions
-- module exists. So this report counts what was sold, never what is still being collected.
--
-- * public.report_recurring_revenue(org, from date, to date, pipeline, owner): security invoker on purpose (as every
--   report_*, CLAUDE.md "Reports"): RLS decides which deals count. from/to are calendar days of the business, both
--   inclusive (the report screen's fromDate/toDate, as report_collection); at most 3,660 days (else 22023).
-- * The deals: report_revenue's won-deal rule (migration 001100, also report_revenue_by_product 020275; keep in step):
--   status won, not in the bin, closed_at in the period, the pipeline and owner filters the same. The period's bounds are
--   midnight of `from` and of the day after `to` in the business's time zone (organizations.timezone, default
--   Asia/Jerusalem), and a deal's month is the month of closed_at in that zone, as report_revenue's by_month.
--   Of those, only recurring deals: billing_kind monthly | yearly (DEAL-07, 0181). A one-time deal is never counted here,
--   even with monthly lines (its lines are in "revenue by product").
-- * New recurring revenue per month (MRR) of one deal, in agorot: monthly = recurring_amount_agorot; yearly =
--   recurring_amount_agorot / 12 rounded half up, per deal (round() of numeric; amounts are never negative,
--   deals_recurring_shape), then summed. The amount is the deal's recurring amount as stored (typed, or DLI-03/DLI-04's sum
--   of its recurring lines), in the deal's currency (ILS only, deals_currency_ils), never recomputed.
-- * A recurring deal whose recurring amount is 0 (DLI-03: "empty, waiting for lines") counts as a deal with 0; the count of
--   such deals is `totals.deals_without_amount`, so the screen can say so.
-- * VAT: a deal has one VAT mode, that of its lines (deal_lines_check); a deal without lines has none stored. As in
--   report_revenue_by_product, `deals_with_vat` / `deals_without_vat` count the deals by their lines' mode, so the screen
--   can warn when a period mixes them; the rest (deals - both) have no recorded mode.
-- * Answer: currency, totals, by_month (every month of the period, zeros included), by_owner (no owner = null).
--
-- public.log_export (021103, COL-06) learns the report key `recurring` (keep equal to src/features/reports/definitions.ts,
-- test 117); every other line is 021103's.
-- Every statement is safe to run twice. No object or row is removed.

create or replace function public.report_recurring_revenue(
  p_org uuid,
  p_from date,
  p_to date,
  p_pipeline uuid default null,
  p_owner uuid default null
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_zone text;
  v_out jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select o.timezone into v_zone from public.organizations o where o.id = p_org;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');

  with won as materialized (
    -- report_revenue's won-deal rule (keep in step), recurring deals only
    select d.id, d.owner_id, d.billing_kind,
           coalesce(d.recurring_amount_agorot, 0) as amount,
           case d.billing_kind
             when 'monthly' then coalesce(d.recurring_amount_agorot, 0)
             else round(coalesce(d.recurring_amount_agorot, 0)::numeric / 12)::bigint
           end as mrr,
           date_trunc('month', d.closed_at at time zone v_zone)::date as month
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= (p_from::timestamp at time zone v_zone)
       and d.closed_at < ((p_to + 1)::timestamp at time zone v_zone)
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
       and d.billing_kind in ('monthly', 'yearly')
  ),
  vat as (
    -- one VAT mode per deal (deal_lines_check): the mode of its lines
    select l.deal_id, bool_or(l.price_includes_vat) as with_vat
      from public.deal_lines l
      join won w on w.id = l.deal_id
     where l.organization_id = p_org
     group by l.deal_id
  ),
  months as (
    select m::date as month
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  ),
  by_month as (
    select m.month,
           count(w.id) as deals,
           coalesce(sum(w.mrr), 0)::bigint as new_mrr,
           count(w.id) filter (where w.billing_kind = 'monthly') as monthly_deals,
           coalesce(sum(w.mrr) filter (where w.billing_kind = 'monthly'), 0)::bigint as monthly_mrr,
           count(w.id) filter (where w.billing_kind = 'yearly') as yearly_deals,
           coalesce(sum(w.mrr) filter (where w.billing_kind = 'yearly'), 0)::bigint as yearly_mrr
      from months m
      left join won w on w.month = m.month
     group by m.month
  ),
  by_owner as (
    select w.owner_id, count(*) as deals, sum(w.mrr)::bigint as new_mrr
      from won w
     group by w.owner_id
  )
  select jsonb_build_object(
    'currency', 'ILS',
    'totals', jsonb_build_object(
      'deals', (select count(*) from won),
      'new_mrr', (select coalesce(sum(mrr), 0)::bigint from won),
      'monthly_deals', (select count(*) from won where billing_kind = 'monthly'),
      'monthly_mrr', (select coalesce(sum(mrr), 0)::bigint from won where billing_kind = 'monthly'),
      'yearly_deals', (select count(*) from won where billing_kind = 'yearly'),
      'yearly_mrr', (select coalesce(sum(mrr), 0)::bigint from won where billing_kind = 'yearly'),
      -- the yearly amounts as stored, before the division by 12
      'yearly_amount', (select coalesce(sum(amount), 0)::bigint from won where billing_kind = 'yearly'),
      'deals_without_amount', (select count(*) from won where amount = 0),
      'deals_with_vat', (select count(*) from vat where with_vat),
      'deals_without_vat', (select count(*) from vat where not with_vat)),
    'by_month', coalesce((select jsonb_agg(r order by r.month) from by_month r), '[]'::jsonb),
    'by_owner', coalesce((select jsonb_agg(r order by r.new_mrr desc, r.deals desc, r.owner_id nulls last) from by_owner r), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;
revoke all on function public.report_recurring_revenue(uuid, date, date, uuid, uuid) from public, anon;
grant execute on function public.report_recurring_revenue(uuid, date, date, uuid, uuid) to authenticated;

-- 021103's log_export, plus the report key 'recurring' (RPT-01; every plan, no refusal of its own)
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
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue', 'debt_aging', 'collection', 'recurring') then
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
  -- RPT-02: the file formats of a report export
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid export' using errcode = '22023';
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
