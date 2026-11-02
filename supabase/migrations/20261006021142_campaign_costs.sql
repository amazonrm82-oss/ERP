-- =============================================================================
-- SEG-03: campaign costs entered by hand, cost per lead and return on investment
-- =============================================================================
-- "עלות קמפיין בהזנה ידנית, וחישוב עלות לליד והחזר על ההשקעה בדוח" (SPEC-ADDITIONS, wave 3). ADS-04 (wave 4) will pull
-- the spend from Meta and Google for those who connect an account; this table stays for everyone else.
--
-- * public.campaign_costs: one row per expense the business enters: a month (its first day), an amount in agorot (ILS),
--   an optional note, and the key it is counted under: a lead source (lead_sources, composite FK set null of the column)
--   and/or a campaign name, matched to the `campaign` text on leads and contacts ignoring case and outer spaces (the same
--   key SEG-02's report groups by). At least one of the two (hint `campaign_cost:key`). Several rows for the same key and
--   month add up (an invoice from the platform and an agency fee, say). A source removed later leaves its rows without a
--   source: they count in the row "עלויות בלי מקור" (or with their campaign).
--   Owner (65) ד: the rule of product costs (PRD-06): whoever may view costs (app.can_view_costs: owner, admin or manager by
--   role, or the PRM-01 grant view_costs) reads them, and writes them in a writable business (app.campaign_costs_writable).
--   Audited. The outsider guard comes first in both triggers (the same predicate).
--   Plan key `campaign_costs` (owner (61) ב: the plans of lead_distribution; migration campaign_costs_plan): a definer
--   trigger with the outsider guard first refuses a new or changed cost without it (hint `feature:campaign_costs`); removing
--   a cost stays allowed, and the foreign key's own set-null is never refused. SEG-02's report by source stays in every plan.
--   `amount_includes_vat` (owner (63) ב, default false): the amount was typed with VAT. Only a business that charges VAT
--   (app.org_charges_vat) may set it (hint `campaign_cost:vat`), and the month needs a VAT rate (hint `vat:before_table`).
-- * public.report_campaign_roi(org, from, to) (INVOKER: RLS decides): {allowed: false} without the plan key or for a non-member.
--   BAL/COL's partial rule (review 2, owner (65) ד): when the caller may not view costs (app.can_view_costs), or reads fewer leads or won deals in the period
--   than the business holds (app.campaign_roi_counts, definer, members only, counts only), the answer is `partial: true` with
--   the caller's own lead and revenue counts and no cost, cost per lead or ROI. Every amount before VAT (owner (63) ב): a cost typed with
--   VAT becomes app.amount_before_vat(amount, the VAT rate on its month's first day) (half up); deal amounts are before VAT
--   already (a deal's value is net: typed, its lines' net, or an accepted quote's net). Per first source, and per source and campaign:
--   leads created in the period (report_leads_by_source's rule: live leads by created_at), deals won in the period and their
--   revenue attributed by the first source (SEG-02, report_revenue_by_source's rule: the converted lead's, else the contact's,
--   else the deal's own; report_revenue's won rule; keep the three in step), the costs of the months whose first day falls in
--   the period (business zone), cost per lead (cost / leads, half up, null without leads or cost) and ROI = (revenue - cost) /
--   cost (4 decimals, null when the cost is 0). Review 3: a cost with no source never mixes with unsourced leads or revenue:
--   `by_source` gives the costs with no source their own row (kind 'unsourced_costs', no cost per lead or ROI), and in
--   `by_campaign` a cost with a campaign and no source is a row of kind 'all_sources' that meets that campaign's leads and
--   revenue of every source (it overlaps the per-source rows of the same campaign; kind 'source' rows hold sourced costs).
-- * public.log_export takes the report key `campaign_roi` (the body of 021118, RPT-02, with that one key added), refused
--   without the plan key (hint `feature:campaign_costs`).
-- No delete statement, no drop statement. Safe to run twice.

-- Who writes campaign costs (owner (65) ד: the rule of product costs, PRD-06): whoever may view costs (app.can_view_costs:
-- owner, admin or manager by role, or the PRM-01 grant view_costs) in a writable business
create or replace function app.campaign_costs_writable(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.can_view_costs(p_org) and app.org_writable(p_org)
$$;
revoke all on function app.campaign_costs_writable(uuid) from public, anon;
grant execute on function app.campaign_costs_writable(uuid) to authenticated, service_role;

create table if not exists public.campaign_costs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  source_id       uuid,
  campaign        text check (campaign is null or (char_length(campaign) between 1 and 200 and campaign = btrim(campaign))),
  month           date not null check (month = date_trunc('month', month)::date and month between date '2000-01-01' and date '2100-12-01'),
  amount_agorot   bigint not null check (amount_agorot between 1 and 100000000000),
  amount_includes_vat boolean not null default false,
  currency        text not null default 'ILS' check (currency = 'ILS'),
  note            text check (note is null or char_length(note) between 1 and 500),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint campaign_costs_source_fk foreign key (organization_id, source_id)
    references public.lead_sources (organization_id, id) on delete set null (source_id)
);
create index if not exists campaign_costs_source_idx on public.campaign_costs (organization_id, source_id);
create index if not exists campaign_costs_month_idx on public.campaign_costs (organization_id, month);

alter table public.campaign_costs enable row level security;
revoke all on public.campaign_costs from anon, authenticated;
grant select, delete on public.campaign_costs to authenticated;
grant insert (organization_id, source_id, campaign, month, amount_agorot, amount_includes_vat, currency, note) on public.campaign_costs to authenticated;
grant update (source_id, campaign, month, amount_agorot, amount_includes_vat, note) on public.campaign_costs to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'campaign_costs' and policyname = 'campaign_costs_select') then
    create policy campaign_costs_select on public.campaign_costs for select to authenticated
      using (app.can_view_costs(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'campaign_costs' and policyname = 'campaign_costs_insert') then
    create policy campaign_costs_insert on public.campaign_costs for insert to authenticated
      with check (app.campaign_costs_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'campaign_costs' and policyname = 'campaign_costs_update') then
    create policy campaign_costs_update on public.campaign_costs for update to authenticated
      using (app.campaign_costs_writable(organization_id))
      with check (app.campaign_costs_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'campaign_costs' and policyname = 'campaign_costs_delete') then
    create policy campaign_costs_delete on public.campaign_costs for delete to authenticated
      using (app.campaign_costs_writable(organization_id));
  end if;
end;
$$;

-- A cost is counted under a source or a campaign: a writer names at least one. The foreign key's own set-null of a removed
-- source (pg_trigger_depth() > 1) may leave neither: the row then counts under "ללא מקור", and nothing else is judged.
-- A cost typed with VAT (a new one, or one whose flag, month or amount changes while set): only in a business that charges
-- VAT, and only for a month the VAT table covers (app.document_vat_rate raises vat:before_table).
create or replace function app.campaign_costs_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- review 5: outsider guard first: someone who may not write costs here gets RLS's plain 42501, never a hint
  if auth.uid() is not null and not app.campaign_costs_writable(new.organization_id) then
    return new;
  end if;
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if new.source_id is null and new.campaign is null then
    raise exception 'a campaign cost names a source or a campaign' using errcode = 'P0001', hint = 'campaign_cost:key';
  end if;
  if new.amount_includes_vat
     and (tg_op = 'INSERT' or not old.amount_includes_vat or new.month is distinct from old.month
          or new.amount_agorot is distinct from old.amount_agorot) then
    if app.org_charges_vat(new.organization_id) is not true then
      raise exception 'only a business that charges VAT types a cost with VAT' using errcode = 'P0001', hint = 'campaign_cost:vat';
    end if;
    perform app.document_vat_rate(new.month);
  end if;
  return new;
end;
$$;
revoke all on function app.campaign_costs_check() from public, anon, authenticated;

create or replace trigger campaign_costs_check before insert or update on public.campaign_costs
  for each row execute function app.campaign_costs_check();

-- The plan key (owner (61) ב). Outsider guard first: someone who may not write costs here gets RLS's plain 42501 and learns
-- nothing about the plan. A new cost or a changed one needs the key; the foreign key's own set-null is a server write.
create or replace function app.campaign_costs_feature() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not app.campaign_costs_writable(new.organization_id) then
    return new;
  end if;
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'campaign_costs') then
    raise exception 'campaign costs are not in the plan' using errcode = 'P0001', hint = 'feature:campaign_costs';
  end if;
  return new;
end;
$$;
revoke all on function app.campaign_costs_feature() from public, anon, authenticated;

create or replace trigger campaign_costs_feature before insert or update on public.campaign_costs
  for each row execute function app.campaign_costs_feature();

-- An amount typed with VAT, before VAT at a rate in basis points, rounded half up (= amountBeforeVat() in
-- src/features/campaign-costs/schema.ts; both run tests/unit/fixtures/amount-before-vat.json). Null on bad input.
create or replace function app.amount_before_vat(p_amount bigint, p_rate_bp integer) returns bigint
language sql immutable
set search_path = ''
as $$
  select case when p_amount is null or p_rate_bp is null or p_rate_bp < 0 then null
              else round(p_amount::numeric * 10000 / (10000 + p_rate_bp))::bigint end
$$;
revoke all on function app.amount_before_vat(bigint, integer) from public, anon;
grant execute on function app.amount_before_vat(bigint, integer) to authenticated, service_role;
create or replace trigger campaign_costs_touch before update on public.campaign_costs
  for each row execute function app.touch_row();
create or replace trigger campaign_costs_audit after insert or update or delete on public.campaign_costs
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- The report
-- ----------------------------------------------------------------------------
-- The whole business's counts the report compares with what the caller reads (BAL/COL's partial rule): the leads created in
-- the period and the deals won in it, by the report's own rules. Members only (null otherwise); counts only.
create or replace function app.campaign_roi_counts(p_org uuid, p_from timestamptz, p_to timestamptz, out leads bigint, out deals bigint)
language sql stable security definer
set search_path = ''
as $$
  select (select count(*) from public.leads l
           where l.organization_id = p_org and l.deleted_at is null and l.created_at >= p_from and l.created_at < p_to),
         (select count(*) from public.deals d
           where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
             and d.closed_at >= p_from and d.closed_at < p_to)
   where app.is_member(p_org)
$$;
revoke all on function app.campaign_roi_counts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app.campaign_roi_counts(uuid, timestamptz, timestamptz) to authenticated;

create or replace function public.report_campaign_roi(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable
set search_path = ''
set jit = off
as $$
declare
  v_all     record;
  v_partial boolean;
  v_result  jsonb;
begin
  -- review 6: the plan key (and a caller outside the business learns nothing: the same answer)
  if not app.is_member(p_org) or not app.org_has_feature(p_org, 'campaign_costs') then
    return jsonb_build_object('allowed', false);
  end if;
  select * into v_all from app.campaign_roi_counts(p_org, p_from, p_to);

  with zone as (
    select coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem') as tz
  ),
  bounds as (
    select (p_from at time zone z.tz)::date as d_from, (p_to at time zone z.tz)::date as d_to from zone z
  ),
  -- leads created in the period (report_leads_by_source's rule)
  leads_in as materialized (
    select l.source_id, nullif(btrim(l.campaign), '') as campaign
      from public.leads l
     where l.organization_id = p_org and l.deleted_at is null
       and l.created_at >= p_from and l.created_at < p_to
  ),
  -- deals won in the period, attributed by the first source (report_revenue_by_source's rule; keep in step)
  won as (
    select d.id, d.amount_agorot, d.contact_id, d.source_id
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
  ),
  attributed as materialized (
    select coalesce(w.amount_agorot, 0) as amount_agorot,
           case when l.has_source then l.source_id when ct.has_source then ct.source_id else w.source_id end as source_id,
           case when l.has_source then nullif(btrim(l.campaign), '')
                when ct.has_source then nullif(btrim(ct.campaign), '') end as campaign
      from won w
      left join lateral (
        select x.source_id, x.campaign, (x.source_id is not null or nullif(btrim(x.campaign), '') is not null) as has_source
          from public.leads x
         where x.organization_id = p_org and x.converted_deal_id = w.id
         order by x.converted_at, x.id
         limit 1) l on true
      left join lateral (
        select y.source_id, y.campaign, (y.source_id is not null or nullif(btrim(y.campaign), '') is not null) as has_source
          from public.contacts y
         where y.organization_id = p_org and y.id = w.contact_id) ct on true
  ),
  -- partial: the caller does not read every lead and won deal the report counts (BAL/COL's rule), or may not view costs
  -- (owner (65) ד: app.can_view_costs, the rule of product costs)
  scope as (
    select not app.can_view_costs(p_org)
           or (select count(*) from leads_in) <> coalesce(v_all.leads, -1)
           or (select count(*) from attributed) <> coalesce(v_all.deals, -1) as partial
  ),
  -- the costs of the months whose first day is in the period, before VAT (a month the VAT table does not cover keeps its
  -- amount; the write refuses such a month, owner (63) ב); none in a partial answer
  costs as materialized (
    select c.source_id, nullif(btrim(c.campaign), '') as campaign,
           case when c.amount_includes_vat
                then coalesce(app.amount_before_vat(c.amount_agorot, app.vat_rate_at(c.month)), c.amount_agorot)
                else c.amount_agorot end as amount_agorot
      from public.campaign_costs c, bounds b
     where c.organization_id = p_org and c.month >= b.d_from and c.month < b.d_to
       and not (select partial from scope)
  ),
  -- leads, revenue and the costs that name a source (review 3: a cost with no source never mixes with unsourced leads)
  facts as (
    select source_id, campaign, 1 as leads, 0 as deals, 0::bigint as revenue, 0::bigint as cost from leads_in
    union all
    select source_id, campaign, 0, 1, amount_agorot, 0 from attributed
    union all
    select source_id, campaign, 0, 0, 0, amount_agorot from costs where source_id is not null
  ),
  by_source as (
    select 'source'::text as kind, f.source_id, s.name as source_name,
           sum(f.leads)::bigint as leads, sum(f.deals)::bigint as deals, sum(f.revenue)::bigint as revenue, sum(f.cost)::bigint as cost
      from facts f
      left join public.lead_sources s on s.organization_id = p_org and s.id = f.source_id
     group by f.source_id, s.name
    union all
    -- the costs entered with no source: one row of their own ("עלויות בלי מקור")
    select 'unsourced_costs', null, null, 0, 0, 0, sum(c.amount_agorot)::bigint
      from costs c where c.source_id is null
    having count(*) > 0
  ),
  unsourced_campaigns as (
    select lower(c.campaign) as ckey, min(c.campaign) as campaign, sum(c.amount_agorot)::bigint as cost
      from costs c
     where c.source_id is null and c.campaign is not null
     group by lower(c.campaign)
  ),
  by_campaign as (
    select 'source'::text as kind, f.source_id, s.name as source_name, min(f.campaign) as campaign,
           sum(f.leads)::bigint as leads, sum(f.deals)::bigint as deals, sum(f.revenue)::bigint as revenue, sum(f.cost)::bigint as cost
      from facts f
      left join public.lead_sources s on s.organization_id = p_org and s.id = f.source_id
     where f.campaign is not null
     group by f.source_id, s.name, lower(f.campaign)
    union all
    -- review 3: a cost with a campaign and no source meets that campaign's leads and revenue of every source
    select 'all_sources', null, null, u.campaign,
           (select count(*) from leads_in l where lower(l.campaign) = u.ckey)::bigint,
           (select count(*) from attributed a where lower(a.campaign) = u.ckey)::bigint,
           (select coalesce(sum(a.amount_agorot), 0) from attributed a where lower(a.campaign) = u.ckey)::bigint,
           u.cost
      from unsourced_campaigns u
  ),
  totals as (
    select (select count(*) from leads_in)::bigint as leads,
           (select count(*) from attributed)::bigint as deals,
           (select coalesce(sum(amount_agorot), 0) from attributed)::bigint as revenue,
           (select coalesce(sum(amount_agorot), 0) from costs)::bigint as cost,
           (select count(*) from costs) as cost_entries
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', (select partial from scope),
    'totals', (
      select jsonb_build_object(
        'leads', t.leads, 'deals', t.deals, 'revenue', t.revenue,
        'cost', case when p.partial then null else t.cost end,
        'cost_entries', case when p.partial then null else t.cost_entries end,
        'cost_per_lead', case when not p.partial and t.leads > 0 and t.cost > 0 then round(t.cost::numeric / t.leads) end,
        'roi', case when not p.partial and t.cost > 0 then round((t.revenue - t.cost)::numeric / t.cost, 4) end)
        from totals t, scope p),
    'by_source', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', r.kind, 'source_id', r.source_id, 'source_name', r.source_name, 'leads', r.leads, 'deals', r.deals,
               'revenue', r.revenue,
               'cost', case when p.partial then null else r.cost end,
               'cost_per_lead', case when r.kind = 'source' and not p.partial and r.leads > 0 and r.cost > 0
                                     then round(r.cost::numeric / r.leads) end,
               'roi', case when r.kind = 'source' and not p.partial and r.cost > 0
                           then round((r.revenue - r.cost)::numeric / r.cost, 4) end)
             order by r.kind = 'unsourced_costs', r.cost desc, r.revenue desc, r.source_name nulls last, r.source_id)
        from by_source r, scope p), '[]'::jsonb),
    'by_campaign', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', r.kind, 'source_id', r.source_id, 'source_name', r.source_name, 'campaign', r.campaign,
               'leads', r.leads, 'deals', r.deals, 'revenue', r.revenue,
               'cost', case when p.partial then null else r.cost end,
               'cost_per_lead', case when not p.partial and r.leads > 0 and r.cost > 0 then round(r.cost::numeric / r.leads) end,
               'roi', case when not p.partial and r.cost > 0 then round((r.revenue - r.cost)::numeric / r.cost, 4) end)
             order by r.cost desc, r.revenue desc, r.kind desc, r.source_name nulls last, r.campaign)
        from by_campaign r, scope p), '[]'::jsonb))
    into v_result;
  return v_result;
end;
$$;
revoke all on function public.report_campaign_roi(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.report_campaign_roi(uuid, timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- log_export: the body of 20261006021118_report_pdf_export.sql with the report key campaign_roi added
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
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue', 'debt_aging', 'collection', 'recurring', 'campaign_roi') then
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
