-- =============================================================================
-- RPT-01 (wave 2, part one): revenue by product
-- =============================================================================
-- public.report_revenue_by_product(org, from, to, pipeline, owner): the lines of the deals won in the period, by
-- product. Security invoker on purpose (as every report_*): RLS decides which deals, lines and products count.
-- * A deal counts as report_revenue counts it: status won, not in the bin, closed_at in [from, to) (the app passes
--   the period's bounds in the business's time zone), the pipeline and owner filters the same.
-- * Amounts are the lines' stored totals (deal_lines.total_agorot, each in its deal's VAT mode), never recomputed.
-- * One row per product and billing (one_time | monthly | quarterly | yearly; null = a line saved before DLI-04, in the
--   deal's period): a monthly line's total is a month's amount, so it is not added to one-time sales. Lines with no
--   product (free lines) are one row per billing with product_id null.
-- * totals also count the won deals without lines and their amount, so the report never hides revenue, and how many
--   deals were priced with VAT and how many before it (the app says so when a period mixes them).
-- * by_billing: one total per billing type; one-time sales and recurring periods are never summed together.
-- public.log_export (body of 020090) accepts the report key 'products'; keep its list equal to
-- src/features/reports/definitions.ts (test 117).
-- Every statement is safe to run twice.

create or replace function public.report_revenue_by_product(
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
    select l.deal_id, l.product_id, l.quantity, l.total_agorot, l.billing, l.price_includes_vat
      from public.deal_lines l
      join won w on w.id = l.deal_id
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
      'deals_without_vat', (select count(distinct deal_id) from lines where not price_includes_vat)),
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

-- 020090's log_export, plus the report key 'products'
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
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products') then
      raise exception 'invalid export' using errcode = '22023';
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
