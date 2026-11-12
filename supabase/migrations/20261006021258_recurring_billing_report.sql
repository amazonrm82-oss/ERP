-- SUB-01..SUB-05, part 6 of 8: the report and log_export. Split from one file so each part fits one apply call;
-- the parts run in name order. Every statement is safe to run twice. No drop statement, no delete.

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
