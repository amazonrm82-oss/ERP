-- =============================================================================
-- DSC-01 (the document part): a document discount split between the lines, for reports
-- =============================================================================
-- Where a document discount is lost today: an accepted quote replaces its deal's lines (QUO-13,
-- app.quote_deal_lines_replace, 020480) with the quote's lines, prices and line discounts, but the quote's DOCUMENT
-- discount is not a line and is not carried; since 020510 the deal's amount is the quote's net_total_agorot (after that
-- discount) and deals.amount_quote_id marks it. So the reports that sum deal_lines.total_agorot (revenue by product
-- 020275, by category and gross profit 020331) counted such a deal above its amount. Deals have no document discount of
-- their own, and no report reads quote_lines or order_lines; report_recurring_revenue reads the deal's stored recurring
-- amount, not lines (left as it is).
--
-- * app.discount_split(totals bigint[], discount bigint) returns bigint[] (pure, immutable): each line's share is
--   proportional to its total after its own line discount (the stored line total, in the document's VAT mode: the base
--   app.document_totals takes the document discount off); every line first gets the floor of its exact share, the agorot
--   left go one each to the largest remainders, a tie to the earlier element (the caller passes the lines by position,
--   then id). The shares add up to the discount exactly and none is above its line. Null for input it does not take (a
--   null, a negative value, a discount above the sum), never an error for the one-dimensional arrays the reports pass, so a report never fails over a stored row.
--   Mirrors discountSplit() in src/features/tax/discount-split.ts; tests/unit/fixtures/discount-split.json is run by both
--   (unit test, tests/db/273). Change both together.
-- * The three reports split at read time, nothing is stored: a won deal whose amount_quote_id names an accepted quote of
--   that deal with discount_total_agorot > 0, when every line is in the quote's VAT mode (the copy keeps it), gets the
--   quote's discount split between all its current lines (the deal is valued at the quote's total, so its lines are
--   too). A line's amount is its stored total less its share; gross profit brings it to its net amount with the share as
--   the line's own document discount (app.document_totals on the line alone, as before). The stored totals of quotes,
--   orders and deal lines and the document_totals rule are unchanged. A quote the caller cannot read (quotes_select
--   follows the deal) is not split.
-- * totals gain deals_with_document_discount (all three) and document_discount_agorot (product and category), so the
--   screens say when a discount was split. Everything else in the three bodies is 020275's / 020331's, still security
--   invoker; report_revenue's won-deal rule is unchanged (keep in step).
-- Every statement is safe to run twice. No object or row is removed.

create or replace function app.discount_split(p_totals bigint[], p_discount bigint) returns bigint[]
language plpgsql immutable
set search_path = ''
as $$
declare
  v_n integer := coalesce(cardinality(p_totals), 0);
  v_sum numeric := 0;
  v_shares bigint[] := '{}';
  v_left numeric;
  v_pick record;
  i integer;
begin
  if p_totals is null or p_discount is null or p_discount < 0 or array_position(p_totals, null) is not null then
    return null;
  end if;
  for i in 1 .. v_n loop
    if p_totals[i] < 0 then
      return null;
    end if;
    v_sum := v_sum + p_totals[i];
  end loop;
  if p_discount > v_sum then
    return null;
  end if;
  if p_discount = 0 or v_sum = 0 then
    return array_fill(0::bigint, array[v_n]);
  end if;
  v_left := p_discount;
  for i in 1 .. v_n loop
    v_shares := v_shares || div(p_discount::numeric * p_totals[i], v_sum)::bigint;
    v_left := v_left - v_shares[i];
  end loop;
  for v_pick in
    select t.n
      from unnest(p_totals) with ordinality as t(total, n)
     order by mod(p_discount::numeric * t.total, v_sum) desc, t.n
     limit v_left::bigint
  loop
    v_shares[v_pick.n] := v_shares[v_pick.n] + 1;
  end loop;
  return v_shares;
end;
$$;
revoke all on function app.discount_split(bigint[], bigint) from public, anon;
grant execute on function app.discount_split(bigint[], bigint) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The three line reports (bodies of 020275 and 020331; the split is new)
-- -----------------------------------------------------------------------------

create or replace function public.report_revenue_by_product(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with won as (
    select d.id, d.amount_agorot, d.amount_quote_id
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  ), split as (
    -- DSC-01: a won deal whose amount is an accepted quote's (deals.amount_quote_id, kept only while equal): the quote's
    -- document discount, which its copied lines do not carry, split between the deal's lines (app.discount_split)
    select g.deal_id, g.ids, app.discount_split(g.totals, g.discount) as shares
      from (
        select l.deal_id, q.discount_total_agorot as discount, q.subtotal_agorot as subtotal,
               sum(l.total_agorot) as line_sum,
               array_agg(l.id order by l.position, l.id) as ids,
               array_agg(l.total_agorot order by l.position, l.id) as totals,
               bool_and(l.price_includes_vat = q.prices_include_vat) as same_mode
          from public.deal_lines l
          join won w on w.id = l.deal_id
          join public.quotes q on q.organization_id = p_org and q.id = w.amount_quote_id and q.deal_id = w.id
                              and q.status = 'accepted'
         where l.organization_id = p_org and q.discount_total_agorot > 0
         group by l.deal_id, q.discount_total_agorot, q.subtotal_agorot) g
     -- only while the deal's lines are still the accepted quote's (their sum is the quote's subtotal before its document
     -- discount): a line added or changed after acceptance never takes a share of a discount it did not have (review)
     where g.same_mode and g.line_sum = g.subtotal
  ), shares as (
    select s.line_id, s.share
      from split x
      cross join lateral unnest(x.ids, x.shares) as s(line_id, share)
     where x.shares is not null
  ), lines as (
    select l.deal_id, l.product_id, l.quantity, l.total_agorot - coalesce(sh.share, 0) as total_agorot, l.billing,
           l.price_includes_vat
      from public.deal_lines l
      join won w on w.id = l.deal_id
      left join shares sh on sh.line_id = l.id
     where l.organization_id = p_org
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'deals', (select count(*) from won),
      'deals_with_lines', (select count(distinct deal_id) from lines),
      'products', (select count(distinct product_id) from lines),
      'deals_without_lines', (select count(*) from won w where not exists (select 1 from lines l where l.deal_id = w.id)),
      'amount_without_lines', (select coalesce(sum(w.amount_agorot), 0) from won w
                                where not exists (select 1 from lines l where l.deal_id = w.id)),
      -- one VAT mode per deal (deal_lines_check): how many deals were priced with VAT and how many before it
      'deals_with_vat', (select count(distinct deal_id) from lines where price_includes_vat),
      'deals_without_vat', (select count(distinct deal_id) from lines where not price_includes_vat),
      -- DSC-01: deals whose accepted quote's document discount was split between their lines, and the discount split
      'deals_with_document_discount', (select count(*) from split where shares is not null),
      'document_discount_agorot', (select coalesce(sum(share), 0) from shares)),
    -- a total per billing: a one-time sale and one period of a recurring line are never added together
    'by_billing', coalesce((
      select jsonb_agg(r order by r.billing nulls last) from (
        select l.billing, count(*) as lines, count(distinct l.deal_id) as deals, sum(l.total_agorot) as amount
          from lines l
         group by l.billing) r), '[]'::jsonb),
    'by_product', coalesce((
      select jsonb_agg(r order by r.amount desc, r.name nulls last) from (
        select l.product_id, p.name, l.billing,
               sum(l.quantity) as quantity, count(distinct l.deal_id) as deals, sum(l.total_agorot) as amount
          from lines l
          left join public.products p on p.organization_id = p_org and p.id = l.product_id
         group by l.product_id, p.name, l.billing
         order by sum(l.total_agorot) desc, p.name nulls last
         limit 200) r), '[]'::jsonb));
$$;
revoke all on function public.report_revenue_by_product(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.report_revenue_by_product(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

create or replace function public.report_revenue_by_category(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with won as (
    select d.id, d.amount_agorot, d.amount_quote_id
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  ), split as (
    -- DSC-01: a won deal whose amount is an accepted quote's (deals.amount_quote_id, kept only while equal): the quote's
    -- document discount, which its copied lines do not carry, split between the deal's lines (app.discount_split)
    select g.deal_id, g.ids, app.discount_split(g.totals, g.discount) as shares
      from (
        select l.deal_id, q.discount_total_agorot as discount, q.subtotal_agorot as subtotal,
               sum(l.total_agorot) as line_sum,
               array_agg(l.id order by l.position, l.id) as ids,
               array_agg(l.total_agorot order by l.position, l.id) as totals,
               bool_and(l.price_includes_vat = q.prices_include_vat) as same_mode
          from public.deal_lines l
          join won w on w.id = l.deal_id
          join public.quotes q on q.organization_id = p_org and q.id = w.amount_quote_id and q.deal_id = w.id
                              and q.status = 'accepted'
         where l.organization_id = p_org and q.discount_total_agorot > 0
         group by l.deal_id, q.discount_total_agorot, q.subtotal_agorot) g
     -- only while the deal's lines are still the accepted quote's (their sum is the quote's subtotal before its document
     -- discount): a line added or changed after acceptance never takes a share of a discount it did not have (review)
     where g.same_mode and g.line_sum = g.subtotal
  ), shares as (
    select s.line_id, s.share
      from split x
      cross join lateral unnest(x.ids, x.shares) as s(line_id, share)
     where x.shares is not null
  ), lines as (
    select l.deal_id, l.product_id, l.total_agorot - coalesce(sh.share, 0) as total_agorot, l.billing, l.price_includes_vat,
           case when l.product_id is null then 'free' when c.id is null then 'uncategorized' else 'category' end as kind,
           c.id as category_id, c.name as category_name, c.position as category_position,
           pc.id as parent_id, pc.name as parent_name, pc.position as parent_position
      from public.deal_lines l
      join won w on w.id = l.deal_id
      left join shares sh on sh.line_id = l.id
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
      'deals_without_vat', (select count(distinct deal_id) from lines where not price_includes_vat),
      -- DSC-01: deals whose accepted quote's document discount was split between their lines, and the discount split
      'deals_with_document_discount', (select count(*) from split where shares is not null),
      'document_discount_agorot', (select coalesce(sum(share), 0) from shares)),
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
    select d.id, d.amount_quote_id,
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
  ), split as (
    -- DSC-01: a won deal whose amount is an accepted quote's (deals.amount_quote_id, kept only while equal): the quote's
    -- document discount, which its copied lines do not carry, split between the deal's lines (app.discount_split)
    select g.deal_id, g.ids, app.discount_split(g.totals, g.discount) as shares
      from (
        select l.deal_id, q.discount_total_agorot as discount, q.subtotal_agorot as subtotal,
               sum(l.total_agorot) as line_sum,
               array_agg(l.id order by l.position, l.id) as ids,
               array_agg(l.total_agorot order by l.position, l.id) as totals,
               bool_and(l.price_includes_vat = q.prices_include_vat) as same_mode
          from public.deal_lines l
          join won w on w.id = l.deal_id
          join public.quotes q on q.organization_id = p_org and q.id = w.amount_quote_id and q.deal_id = w.id
                              and q.status = 'accepted'
         where l.organization_id = p_org and q.discount_total_agorot > 0
         group by l.deal_id, q.discount_total_agorot, q.subtotal_agorot) g
     -- only while the deal's lines are still the accepted quote's (their sum is the quote's subtotal before its document
     -- discount): a line added or changed after acceptance never takes a share of a discount it did not have (review)
     where g.same_mode and g.line_sum = g.subtotal
  ), shares as (
    select s.line_id, s.share
      from split x
      cross join lateral unnest(x.ids, x.shares) as s(line_id, share)
     where x.shares is not null
  ), lines as (
    select l.deal_id, l.product_id, l.billing, l.quantity, k.cost_agorot,
           (app.document_totals(
              jsonb_build_array(jsonb_build_object(
                'quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot, 'discount_bp', l.discount_bp,
                'discount_agorot', l.discount_agorot, 'vat_exempt', l.vat_exempt)),
              case when l.price_includes_vat then w.rate_bp else 0 end,
              l.price_includes_vat, null, sh.share) ->> 'net_total_agorot')::bigint as net,
           case when k.cost_agorot is null then null else round(l.quantity * k.cost_agorot)::bigint end as cost
      from public.deal_lines l
      join won w on w.id = l.deal_id
      left join shares sh on sh.line_id = l.id
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
      'uncosted_lines', (select count(*) from lines where cost is null),
      -- DSC-01: deals whose accepted quote's document discount was split between their lines
      'deals_with_document_discount', (select count(*) from split where shares is not null)),
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
