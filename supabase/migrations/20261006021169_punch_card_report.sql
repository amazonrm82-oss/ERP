-- =============================================================================
-- PKG-07: the punch cards report
-- =============================================================================
-- "דוח: כרטיסיות פעילות, ניצול, כרטיסיות שעומדות לפוג, וכסף שהתקבל על שירות שעוד לא ניתן" (SPEC-ADDITIONS, wave 3).
--
-- * public.report_punch_cards(org, days) (INVOKER: RLS decides what is counted; the cards a caller reads are those of the
--   contacts they read, punch_cards_select, and a card's used entries follow it, punch_card_uses_select). `{allowed: false}`
--   for a non-member, for anyone but an owner, admin or manager by role (owner (118) ב: app.membership_role; a rep sees
--   cards on the contact card only) and without the plan key `punch_cards` (the same answer, so an outsider learns nothing).
--   Counted: cards with status 'active' (pending cards waiting for a payment are only counted, cancelled ones never).
--   A card is "current" while expires_on is null or on/after today, "expired" after it (PKG-01: the last usable day; today in
--   the business's zone by app.punch_card_today's rule). Entries used = its entries not given back (PKG-02); left = total - used.
--   * Kind of an active card, which decides whether its money counts (the safe reading):
--       paid   = opened by a payment (not activated by hand, payment_id set) whose payment still counts (payment_void_at null);
--       manual = activated by hand by an owner/admin (activated_manually): no payment is known, so no money; a count only;
--       unpaid = opened by a payment that stopped counting (payment_void_at set, PKG-01 review finding 1) or whose payment
--                link is gone: no money; a count only.
--   * Money received for service not yet given ("unearned") = for each CURRENT PAID card, price_agorot x left / total,
--     rounded half up per card (numeric round, all values non-negative), then summed. price_agorot is the card's price with
--     VAT, as PKG-01 stores it (owner (93) ב), so the amount is with VAT. A card that expired with entries left is not
--     unearned (the service can no longer be given); its share is `expired_value` (same rule), shown apart as its own row
--     "פג תוקף עם יתרה" (owner (116) א).
--   * Utilisation per product (the card's product; name from the catalogue, else the card's snapshot): every active card,
--     current and expired, entries used / entries total.
--   * Expiring: current active cards with entries left whose expires_on is within today .. today + days (default 30, 1..366,
--     else 22023 hint `report:days`); the list holds the first 200 by expires_on, the totals count them all. Owner (117) ב:
--     the screen offers 7 / 14 / 30 / 60, kept per user and business in public.list_preferences (object_type
--     'punch_report', columns exactly [{"days": n}] with n in that closed list: constraint list_preferences_punch_report_shape).
--   * A card of a contact in the recycle bin stays in every count and in the money (the money is still owed; lead's
--     decision); in the expiring list its row says `contact_binned: true` and the screen links nowhere for it.
--   * Used entries come from app.punch_card_used_counts (definer, one read check per card on the ids the report read
--     under RLS), not from punch_card_uses' policy, which checks the card once per use (review finding 1).
--   * `expired_paid_with_entries` counts the paid cards among the expired ones with entries left: the cards
--     `expired_value` sums (review finding 2).
-- * Partial (the pattern of COL-01 / BAL-01): when the caller reads fewer non-cancelled cards than the business holds
--   (app.punch_card_report_facts, definer, members only, a count and today only), the answer is `partial: true` with the
--   caller's own counts and entries and NO money (unearned, expired_value and every per-product amount are null).
-- * public.log_export takes the report key `punch_cards` (the body of 021142 with that one key added), refused without the
--   plan key (hint `feature:punch_cards`) and to anyone but an owner, admin or manager by role (42501, owner (118) ב).
-- `set jit = off` on the report (the rule for a large invoker report under RLS).
-- Every statement is safe to run twice. No drop statement, no delete.

-- Owner (117) ב: the report's "expiring" window, kept per user and business beside the lists' columns. Only 7, 14, 30 or
-- 60 days, as exactly one element [{"days": n}] (the server action checks the same closed list).
alter table public.list_preferences drop constraint if exists list_preferences_object_type_check;
alter table public.list_preferences add constraint list_preferences_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'deal_board', 'product', 'quote', 'document', 'payment', 'punch_report'));
alter table public.list_preferences drop constraint if exists list_preferences_punch_report_shape;
alter table public.list_preferences add constraint list_preferences_punch_report_shape
  check (object_type <> 'punch_report'
         or columns in ('[{"days": 7}]'::jsonb, '[{"days": 14}]'::jsonb, '[{"days": 30}]'::jsonb, '[{"days": 60}]'::jsonb));

-- The business's non-cancelled cards (the partial rule's number) and today by app.punch_card_today's rule. Members only (null
-- otherwise); a count and a date, nothing else.
create or replace function app.punch_card_report_facts(p_org uuid, out cards bigint, out today date)
language sql stable security definer
set search_path = ''
as $$
  select (select count(*) from public.punch_cards c where c.organization_id = p_org and c.status <> 'cancelled'),
         app.punch_card_today(p_org)
   where app.is_member(p_org)
$$;
revoke all on function app.punch_card_report_facts(uuid) from public, anon, authenticated, service_role;
-- report_punch_cards is invoker, so the caller runs this
grant execute on function app.punch_card_report_facts(uuid) to authenticated;

-- Review finding 1 (speed): the used entries of the cards the report already read under RLS, counted without
-- punch_card_uses' policy (which re-checks its card's policy once per use: 9,000 uses took about 7.5 s). Only cards of
-- p_org whose contact the caller reads: the rule of punch_cards_select (a member, and the contact readable by
-- contacts_select: app.can_read_record or app.deputy_readable('contact'); keep the three in step), asked once per card.
-- Members only (nothing otherwise); numbers per card id only.
create or replace function app.punch_card_used_counts(p_org uuid, p_cards uuid[])
returns table (card_id uuid, used integer)
language sql stable security definer
set search_path = ''
as $$
  with readable as (
    select c.id
      from public.punch_cards c
      join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
     where app.is_member(p_org)
       and c.organization_id = p_org and c.id = any(p_cards)
       and (app.can_read_record(ct.organization_id, ct.owner_id, ct.team_id)
            or (ct.organization_id, ct.id) in (select r.organization_id, r.id from app.deputy_readable('contact') r))
  )
  select r.id, count(u.id)::integer
    from readable r
    left join public.punch_card_uses u on u.organization_id = p_org and u.card_id = r.id and u.returned_at is null
   group by r.id
$$;
revoke all on function app.punch_card_used_counts(uuid, uuid[]) from public, anon, authenticated, service_role;
-- report_punch_cards is invoker, so the caller runs this
grant execute on function app.punch_card_used_counts(uuid, uuid[]) to authenticated;

create or replace function public.report_punch_cards(p_org uuid, p_days integer default 30)
returns jsonb
language plpgsql stable
set search_path = ''
set jit = off
as $$
declare
  v_facts  record;
  v_result jsonb;
begin
  -- owner (118) ב: owners, admins and managers by role only
  if not app.is_member(p_org) or coalesce(app.membership_role(p_org)::text, '') not in ('owner', 'admin', 'manager')
     or not app.org_has_feature(p_org, 'punch_cards') then
    return jsonb_build_object('allowed', false);
  end if;
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'invalid days' using errcode = '22023', hint = 'report:days';
  end if;
  select * into v_facts from app.punch_card_report_facts(p_org);

  with seen as materialized (
    select c.id, c.contact_id, c.product_id, c.name, c.status, c.entries_total, c.expires_on, c.price_agorot,
           case when c.activated_manually then 'manual'
                when c.payment_id is not null and c.payment_void_at is null then 'paid'
                else 'unpaid' end as kind
      from public.punch_cards c
     where c.organization_id = p_org and c.status <> 'cancelled'
  ),
  scope as (
    select (select count(*) from seen) <> coalesce(v_facts.cards, -1) as partial
  ),
  used as materialized (
    select x.card_id, x.used
      from app.punch_card_used_counts(p_org, array(select s.id from seen s where s.status = 'active')) x
  ),
  cards as materialized (
    select s.*, least(coalesce(x.used, 0), s.entries_total) as used,
           s.entries_total - least(coalesce(x.used, 0), s.entries_total) as left_entries,
           (s.expires_on is null or s.expires_on >= v_facts.today) as current,
           round(s.price_agorot::numeric * (s.entries_total - least(coalesce(x.used, 0), s.entries_total)) / s.entries_total)::bigint
             as share
      from seen s
      left join used x on x.card_id = s.id
     where s.status = 'active'
  ),
  expiring as (
    select c.* from cards c
     where c.current and c.left_entries > 0 and c.expires_on is not null
       and c.expires_on <= v_facts.today + p_days
  ),
  by_product as (
    select c.product_id, coalesce(min(p.name), min(c.name)) as name,
           count(*)::bigint as cards,
           count(*) filter (where c.current)::bigint as current_cards,
           sum(c.entries_total)::bigint as entries_total,
           sum(c.used)::bigint as entries_used,
           sum(c.left_entries) filter (where c.current)::bigint as entries_left,
           coalesce(sum(c.share) filter (where c.current and c.kind = 'paid'), 0)::bigint as unearned
      from cards c
      left join public.products p on p.organization_id = p_org and p.id = c.product_id
     group by c.product_id
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', p.partial,
    'today', v_facts.today,
    'days', p_days,
    'totals', jsonb_build_object(
      'active', (select count(*) from cards c where c.current),
      'active_paid', (select count(*) from cards c where c.current and c.kind = 'paid'),
      'active_manual', (select count(*) from cards c where c.current and c.kind = 'manual'),
      'active_unpaid', (select count(*) from cards c where c.current and c.kind = 'unpaid'),
      'pending', (select count(*) from seen s where s.status = 'pending'),
      'expired', (select count(*) from cards c where not c.current),
      'expired_with_entries', (select count(*) from cards c where not c.current and c.left_entries > 0),
      -- review finding 2: the paid ones among them, the cards expired_value counts
      'expired_paid_with_entries', (select count(*) from cards c where not c.current and c.left_entries > 0 and c.kind = 'paid'),
      'entries_total', (select coalesce(sum(c.entries_total), 0) from cards c),
      'entries_used', (select coalesce(sum(c.used), 0) from cards c),
      'entries_left', (select coalesce(sum(c.left_entries), 0) from cards c where c.current),
      'unearned', case when p.partial then null
                       else (select coalesce(sum(c.share), 0) from cards c where c.current and c.kind = 'paid') end,
      'expired_value', case when p.partial then null
                            else (select coalesce(sum(c.share), 0) from cards c where not c.current and c.kind = 'paid') end,
      'expiring', (select count(*) from expiring),
      'expiring_entries', (select coalesce(sum(e.left_entries), 0) from expiring e)),
    'by_product', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', b.product_id, 'name', b.name, 'cards', b.cards, 'current_cards', b.current_cards,
               'entries_total', b.entries_total, 'entries_used', b.entries_used, 'entries_left', coalesce(b.entries_left, 0),
               'utilisation', case when b.entries_total > 0 then round(b.entries_used::numeric / b.entries_total, 4) end,
               'unearned', case when p.partial then null else b.unearned end)
             order by b.cards desc, b.name, b.product_id)
        from by_product b), '[]'::jsonb),
    'expiring_cards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'card_id', e.id, 'contact_id', e.contact_id, 'contact_name', e.contact_name, 'name', e.name,
               'expires_on', e.expires_on, 'entries_left', e.left_entries, 'entries_total', e.entries_total, 'kind', e.kind,
               'contact_binned', e.contact_binned)
             order by e.expires_on, e.id)
        from (select x.*, ct.full_name as contact_name, (ct.deleted_at is not null) as contact_binned
                from expiring x
                left join public.contacts ct on ct.organization_id = p_org and ct.id = x.contact_id
               order by x.expires_on, x.id
               limit 200) e), '[]'::jsonb))
    into v_result
    from scope p;
  return v_result;
end;
$$;
revoke all on function public.report_punch_cards(uuid, integer) from public, anon;
grant execute on function public.report_punch_cards(uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- log_export: the body of 20261006021142_campaign_costs.sql with the report key punch_cards added
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
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue', 'debt_aging', 'collection', 'recurring', 'campaign_roi', 'punch_cards') then
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
