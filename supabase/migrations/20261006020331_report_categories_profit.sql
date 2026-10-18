-- =============================================================================
-- DLI-06: revenue by product category, and gross profit for those who may see costs
-- =============================================================================
-- Revenue by product and the top products are RPT-01's report_revenue_by_product (020275), unchanged. This adds:
--
-- public.report_revenue_by_category(org, from, to, pipeline, owner): the lines of the deals won in the period, by the
-- category their product is in today. Security invoker (as every report_*): RLS decides which deals, lines, products and
-- categories count. Same won-deal rule as report_revenue / report_revenue_by_product (keep in step): status won, not in
-- the bin, closed_at in [from, to), the pipeline and owner filters. Amounts are the lines' stored totals, one row per
-- category and billing (a recurring line's total is one period, never added to one-time sales). kind: 'category' (a
-- product in a category), 'uncategorized' (a product with no category, or one the caller cannot read), 'free' (a line
-- with no product). by_top rolls subcategories up into their top category.
--
-- public.report_gross_profit(org, from, to, pipeline, owner): the same won lines, each line's net amount before VAT
-- against the cost kept on the line (deal_line_costs, PRD-06 follow-up) x quantity, half up. Security invoker, with no
-- definer shortcut: the costs come through deal_line_costs' RLS (app.can_view_costs), and a caller who may not see costs
-- gets {"allowed": false} and nothing else. A line without a kept cost (a free line, or a product that had no cost) is
-- left out and counted, never taken as zero. A line priced with VAT is brought to its net amount by
-- app.document_totals on the line alone, at the VAT rate of the day the deal was closed in the business's zone (0 when
-- the business does not charge VAT), like the deal card's profit box. One figure per billing; margin in basis points of
-- the net amount (null when it is 0), half away from zero like profitOf().
--
-- public.log_export (body of 020275) accepts the report keys 'categories' and 'profit'; 'profit' only for a caller who
-- may see costs (42501). Keep the list equal to src/features/reports/definitions.ts (test 117).
-- Every statement is safe to run twice.

create or replace function public.report_revenue_by_category(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with won as (
    select d.id, d.amount_agorot
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  ), lines as (
    select l.deal_id, l.product_id, l.total_agorot, l.billing, l.price_includes_vat,
           case when l.product_id is null then 'free' when c.id is null then 'uncategorized' else 'category' end as kind,
           c.id as category_id, c.name as category_name, c.position as category_position,
           pc.id as parent_id, pc.name as parent_name, pc.position as parent_position
      from public.deal_lines l
      join won w on w.id = l.deal_id
      left join public.products p on p.organization_id = p_org and p.id = l.product_id
      left join public.product_categories c on c.organization_id = p_org and c.id = p.category_id
      left join public.product_categories pc on pc.organization_id = p_org and pc.id = c.parent_id
     where l.organization_id = p_org
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'deals', (select count(*) from won),
      'deals_with_lines', (select count(distinct deal_id) from lines),
      'categories', (select count(distinct category_id) from lines),
      'deals_without_lines', (select count(*) from won w where not exists (select 1 from lines l where l.deal_id = w.id)),
      'amount_without_lines', (select coalesce(sum(w.amount_agorot), 0) from won w
                                where not exists (select 1 from lines l where l.deal_id = w.id)),
      'deals_with_vat', (select count(distinct deal_id) from lines where price_includes_vat),
      'deals_without_vat', (select count(distinct deal_id) from lines where not price_includes_vat)),
    'by_billing', coalesce((
      select jsonb_agg(r order by r.billing nulls last) from (
        select l.billing, count(*) as lines, count(distinct l.deal_id) as deals, sum(l.total_agorot) as amount
          from lines l
         group by l.billing) r), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(r order by r.amount desc, r.name nulls last) from (
        select l.kind, l.category_id, l.category_name as name, l.parent_id, l.parent_name, l.billing,
               count(distinct l.product_id) as products, count(distinct l.deal_id) as deals, sum(l.total_agorot) as amount
          from lines l
         group by l.kind, l.category_id, l.category_name, l.parent_id, l.parent_name, l.billing
         order by sum(l.total_agorot) desc, l.category_name nulls last
         limit 200) r), '[]'::jsonb),
    -- a subcategory's lines rolled up into its top category (two levels at most, product_categories_check)
    'by_top', coalesce((
      select jsonb_agg(r order by r.amount desc, r.name nulls last) from (
        select coalesce(l.parent_id, l.category_id) as category_id, coalesce(l.parent_name, l.category_name) as name, l.billing,
               count(distinct l.product_id) as products, count(distinct l.deal_id) as deals, sum(l.total_agorot) as amount
          from lines l
         where l.kind = 'category'
         group by 1, 2, l.billing
         order by sum(l.total_agorot) desc, 2 nulls last
         limit 200) r), '[]'::jsonb));
$$;
revoke all on function public.report_revenue_by_category(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.report_revenue_by_category(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

create or replace function public.report_gross_profit(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with allowed as (
    select app.can_view_costs(p_org) as ok
  ), won as (
    select d.id,
           -- the rate a line priced with VAT is brought back to its net amount at: the day the deal was closed
           case when app.org_charges_vat(p_org) is distinct from false
                then coalesce(app.vat_rate_at((d.closed_at at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date), 0)
                else 0 end as rate_bp
      from public.deals d
      join public.organizations o on o.id = d.organization_id
     where (select ok from allowed)
       and d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  ), lines as (
    select l.deal_id, l.product_id, l.billing, l.quantity, k.cost_agorot,
           (app.document_totals(
              jsonb_build_array(jsonb_build_object(
                'quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot, 'discount_bp', l.discount_bp,
                'discount_agorot', l.discount_agorot, 'vat_exempt', l.vat_exempt)),
              case when l.price_includes_vat then w.rate_bp else 0 end,
              l.price_includes_vat) ->> 'net_total_agorot')::bigint as net,
           case when k.cost_agorot is null then null else round(l.quantity * k.cost_agorot)::bigint end as cost
      from public.deal_lines l
      join won w on w.id = l.deal_id
      left join public.deal_line_costs k on k.organization_id = l.organization_id and k.deal_line_id = l.id
     where l.organization_id = p_org
  ), costed as (
    select * from lines where cost is not null
  )
  select case when not (select ok from allowed) then jsonb_build_object('allowed', false) else jsonb_build_object(
    'allowed', true,
    'totals', jsonb_build_object(
      'deals', (select count(*) from won),
      'deals_with_costs', (select count(distinct deal_id) from costed),
      'lines', (select count(*) from lines),
      'costed_lines', (select count(*) from costed),
      'uncosted_lines', (select count(*) from lines where cost is null)),
    -- one figure per billing: a recurring line's amount is one period, never added to one-time sales
    'by_billing', coalesce((
      select jsonb_agg(r order by r.billing nulls last) from (
        select c.billing, count(*) as lines, count(distinct c.deal_id) as deals,
               sum(c.net) as revenue, sum(c.cost) as cost, sum(c.net) - sum(c.cost) as profit,
               case when sum(c.net) = 0 then null
                    else round((sum(c.net) - sum(c.cost)) * 10000.0 / sum(c.net))::integer end as margin_bp
          from costed c
         group by c.billing) r), '[]'::jsonb),
    'by_product', coalesce((
      select jsonb_agg(r order by r.profit desc, r.name nulls last) from (
        select c.product_id, p.name, c.billing, sum(c.quantity) as quantity, count(distinct c.deal_id) as deals,
               sum(c.net) as revenue, sum(c.cost) as cost, sum(c.net) - sum(c.cost) as profit,
               case when sum(c.net) = 0 then null
                    else round((sum(c.net) - sum(c.cost)) * 10000.0 / sum(c.net))::integer end as margin_bp
          from costed c
          left join public.products p on p.organization_id = p_org and p.id = c.product_id
         group by c.product_id, p.name, c.billing
         order by sum(c.net) - sum(c.cost) desc, p.name nulls last
         limit 200) r), '[]'::jsonb)) end;
$$;
revoke all on function public.report_gross_profit(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.report_gross_profit(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

-- 020275's log_export, plus the report keys 'categories' and 'profit' ('profit' for those who may see costs)
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
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
    -- DLI-06: gross profit carries costs
    if p_report = 'profit' and not app.can_view_costs(p_org) then
      raise exception 'the gross profit report is for those who may see costs' using errcode = '42501';
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
