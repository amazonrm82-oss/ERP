-- =============================================================================
-- One-time and recurring lines in the same deal (DLI-04; owner, 14 October 2026)
-- =============================================================================
-- DECISIONS.md "שורות חד-פעמיות וחוזרות באותה עסקה". Every deal line keeps a billing mode
-- (one_time | monthly | quarterly | yearly). The deal's recurring amount is computed from the
-- recurring lines only, converted to the deal's period (a year holds 12 months, 4 quarters);
-- the deal value is the first year of the recurring lines plus the one-time lines once. Still in
-- force from DLI-03: a typed value wins; 0 counts as empty; a recurring deal whose (recurring)
-- lines are all gone keeps its last recurring amount; the recurring amount follows the lines only
-- while nobody typed it.
--
-- deal_lines.billing (new, nullable):
--   a product line: copied from products.billing when the line is added, never changed later
--     (like vat_exempt); whatever a writer sends is overridden;
--   a free line: the person's choice, default 'one_time' (insert and update; column grants);
--   null: a line saved before this migration. It counts as before (DLI-03: in the deal's own
--     period: monthly / yearly on a recurring deal, once on a one-time deal), so this migration
--     changes no stored value and rewrites no row. Every new line gets a mode; a null is filled
--     once: a free line by the person's next save, a product line from its product (the separate
--     backfill migration deal_line_billing_backfill does it for all of them, with the owner's
--     approval, because it moves the stored value of deals whose lines mix billings).
--
-- The rule (pure, one place): app.deal_value_rule(), mirrored by dealValueRule() in
-- src/features/deals/recurring.ts; both checked against tests/unit/fixtures/deal-value.json
-- (unit test and tests/db/106). Its line inputs are the before-VAT sums of the lines per billing
-- mode (app.deal_lines_sums). With R = the first year of the recurring lines
-- (12 x monthly + 4 x quarterly + yearly, exact):
--   the recurring amount (recurring deal, while it follows the lines): R / 12 on a monthly deal
--     (half up, in agorot), R on a yearly one; with no recurring lines it keeps what it had (0
--     when empty: "waiting for lines");
--   the computed value: a recurring deal, the first year of its recurring amount (12 x monthly,
--     the yearly amount; a typed recurring amount counts too) plus the one-time lines; a one-time
--     deal with lines, R plus the one-time lines (a one-time deal with a recurring line counts the
--     line's first year; the app offers to make the deal recurring, and never does it by itself);
--   source 'lines' when a line takes part (a recurring amount that follows recurring lines, or a
--     one-time line), else 'first_year'.
-- The rest is DLI-03's rule unchanged (typed wins, 0 is empty, all lines gone).
-- app.deal_amount_rule() (DLI-03, same signature) and app.deal_value() (DEAL-07) stay as entry
-- points: deal_amount_rule's single line sum is read as lines billed in the deal's own period,
-- which is exactly the DLI-03 meaning, so they answer as before.
--
-- The sums per mode (app.deal_lines_sums): document_totals() per mode group, in the deal's one VAT
-- mode, carried back by the same conversion rate as app.deal_lines_sum (DLI-03). Internal:
-- security definer, granted to no one; only the definer trigger functions call it.
--
-- No drops, no row removal, no bulk rewrite. Safe to run twice.

alter table public.deal_lines add column if not exists billing text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deal_lines'::regclass and conname = 'deal_lines_billing') then
    alter table public.deal_lines add constraint deal_lines_billing
      check (billing is null or billing in ('one_time', 'monthly', 'quarterly', 'yearly'));
  end if;
end;
$$;

-- a free line's mode is the person's (the trigger overrides it on a product line)
grant insert (billing), update (billing) on public.deal_lines to authenticated;

-- -----------------------------------------------------------------------------
-- The mode of a line
-- -----------------------------------------------------------------------------
-- Security invoker: it reads only the line's own product, which every member reads; a writer the
-- deal is hidden from is refused by RLS right after. No client role executes it directly.
create or replace function app.deal_lines_billing() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_billing text;
begin
  if tg_op = 'INSERT' then
    if new.product_id is not null then
      select p.billing into v_billing
        from public.products p
       where p.organization_id = new.organization_id and p.id = new.product_id;
      -- not found: the foreign key refuses the row (23503)
      new.billing := coalesce(v_billing, 'one_time');
    else
      new.billing := coalesce(new.billing, 'one_time');
    end if;
  elsif old.product_id is not null then
    -- a product line's mode is its product's, set once
    if old.billing is not null then
      new.billing := old.billing;
    elsif new.billing is not null then
      -- a line saved before DLI-04 gets its product's mode when it is filled
      select p.billing into v_billing
        from public.products p
       where p.organization_id = old.organization_id and p.id = old.product_id;
      new.billing := coalesce(v_billing, 'one_time');
    end if;
  else
    -- a free line: the person's choice; a write that does not send it keeps it
    new.billing := coalesce(new.billing, old.billing);
  end if;
  return new;
end;
$$;
revoke all on function app.deal_lines_billing() from public, anon, authenticated;

create or replace trigger deal_lines_billing before insert or update on public.deal_lines
  for each row execute function app.deal_lines_billing();

-- -----------------------------------------------------------------------------
-- The lines' sums before VAT, per billing mode
-- -----------------------------------------------------------------------------
-- p_kind is the deal's billing_kind: a line saved before DLI-04 (billing null) counts in the deal's
-- own period, as it did. All null = no lines.
create or replace function app.deal_lines_sums(
  p_org uuid,
  p_deal uuid,
  p_kind text,
  out once bigint,
  out monthly bigint,
  out quarterly bigint,
  out yearly bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_gross boolean;
  v_rate integer := 0;
  v_charges boolean;
  v_day date;
  v_group record;
  v_net bigint;
begin
  select bool_or(l.price_includes_vat) into v_gross
    from public.deal_lines l
   where l.organization_id = p_org and l.deal_id = p_deal;
  if v_gross is null then
    return;
  end if;
  if v_gross then
    v_charges := app.org_charges_vat(p_org);
    if v_charges is distinct from false then
      v_day := (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
      v_rate := coalesce(app.vat_rate_at(v_day), 0);
    end if;
  end if;
  for v_group in
    select coalesce(l.billing, case when p_kind in ('monthly', 'yearly') then p_kind else 'one_time' end) as billing,
           jsonb_agg(jsonb_build_object(
             'quantity', l.quantity,
             'unit_price_agorot', l.unit_price_agorot,
             'discount_bp', l.discount_bp,
             'discount_agorot', l.discount_agorot,
             'vat_exempt', l.vat_exempt) order by l.position, l.created_at, l.id) as lines
      from public.deal_lines l
     where l.organization_id = p_org and l.deal_id = p_deal
     group by 1
  loop
    v_net := (app.document_totals(v_group.lines, v_rate, v_gross) ->> 'net_total_agorot')::bigint;
    if v_group.billing = 'monthly' then
      monthly := v_net;
    elsif v_group.billing = 'quarterly' then
      quarterly := v_net;
    elsif v_group.billing = 'yearly' then
      yearly := v_net;
    else
      once := v_net;
    end if;
  end loop;
end;
$$;
revoke all on function app.deal_lines_sums(uuid, uuid, text) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The rule (pure)
-- -----------------------------------------------------------------------------
create or replace function app.deal_value_rule(
  p_kind text,
  p_recurring bigint,
  p_amount bigint,
  p_old_amount bigint,
  p_old_auto boolean,
  p_insert boolean,
  p_once bigint,
  p_monthly bigint,
  p_quarterly bigint,
  p_yearly bigint,
  p_old_recurring bigint,
  p_old_recurring_auto boolean,
  p_old_source text,
  out amount bigint,
  out auto boolean,
  out source text,
  out recurring bigint,
  out recurring_auto boolean
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_max constant numeric := 9007199254740991;
  v_has_lines boolean := coalesce(p_once, p_monthly, p_quarterly, p_yearly) is not null;
  v_has_recurring boolean := coalesce(p_monthly, p_quarterly, p_yearly) is not null;
  v_year numeric;
  v_first_year numeric;
  v_computed numeric;
  v_source text;
begin
  -- the first year of the recurring lines, exact
  if v_has_recurring then
    v_year := 12::numeric * coalesce(p_monthly, 0) + 4::numeric * coalesce(p_quarterly, 0) + coalesce(p_yearly, 0);
    if v_year > v_max then
      raise exception 'first-year value too big' using errcode = 'P0001', hint = 'deal:amount_too_big';
    end if;
  end if;

  -- the recurring amount follows the recurring lines while nobody typed it
  recurring := p_recurring;
  recurring_auto := null;
  if p_kind is not null
     and (p_recurring is null
          or (not p_insert and p_recurring = p_old_recurring and p_old_recurring_auto is true)) then
    if v_has_recurring then
      -- converted to the deal's period; half up (the amounts are never negative)
      recurring := (case when p_kind = 'monthly' then round(v_year / 12) else v_year end)::bigint;
    else
      -- no recurring lines: it keeps what it had (0 when empty)
      recurring := coalesce(p_recurring, 0);
    end if;
    recurring_auto := true;
  end if;

  if p_kind is not null then
    v_first_year := case
      when recurring is null then null
      -- an amount waiting for lines (following, no recurring lines, 0) is nothing to compute from
      when recurring_auto is true and not v_has_recurring and recurring = 0 then null
      when p_kind = 'monthly' then recurring::numeric * 12
      when p_kind = 'yearly' then recurring::numeric
    end;
    if v_first_year is not null or p_once is not null then
      v_computed := coalesce(v_first_year, 0) + coalesce(p_once, 0);
    end if;
    v_source := case when (recurring_auto is true and v_has_recurring) or p_once is not null then 'lines' else 'first_year' end;
  elsif v_has_lines then
    -- a one-time deal: the first year of its recurring lines and its one-time lines once
    v_computed := coalesce(v_year, 0) + coalesce(p_once, 0);
    v_source := 'lines';
  end if;

  if p_amount is null
     or (not p_insert and p_amount = p_old_amount and p_old_auto is true and v_computed is not null)
     -- "0 is empty": an unchanged 0 nobody computed follows the lines
     or (not p_insert and p_amount = p_old_amount and p_amount = 0 and p_old_auto is not true
         and v_has_lines and v_computed is not null) then
    -- empty, or unchanged while computed: the value follows its source
    if v_computed is null then
      amount := 0;
      auto := null;
      source := null;
    else
      if v_computed > v_max then
        raise exception 'first-year value too big' using errcode = 'P0001', hint = 'deal:amount_too_big';
      end if;
      amount := v_computed::bigint;
      auto := true;
      source := v_source;
    end if;
  elsif not p_insert and p_amount = p_old_amount and p_old_auto is true and p_old_source = 'lines' then
    -- the value followed the lines and none are left: empty
    amount := 0;
    auto := null;
    source := null;
  else
    -- typed (or given on insert): kept, flag off
    amount := p_amount;
    auto := null;
    source := null;
  end if;
end;
$$;

revoke all on function app.deal_value_rule(text, bigint, bigint, bigint, boolean, boolean, bigint, bigint, bigint, bigint, bigint, boolean, text) from public, anon;
grant execute on function app.deal_value_rule(text, bigint, bigint, bigint, boolean, boolean, bigint, bigint, bigint, bigint, bigint, boolean, text) to authenticated, service_role;

-- DLI-03's entry point, same signature and grants: its one line sum is lines billed in the deal's
-- own period (once on a one-time deal), which is what it meant before DLI-04.
create or replace function app.deal_amount_rule(
  p_kind text,
  p_recurring bigint,
  p_amount bigint,
  p_old_amount bigint,
  p_old_auto boolean,
  p_insert boolean,
  p_lines bigint,
  p_old_recurring bigint,
  p_old_recurring_auto boolean,
  p_old_source text,
  out amount bigint,
  out auto boolean,
  out source text,
  out recurring bigint,
  out recurring_auto boolean
)
language sql
immutable
set search_path = ''
as $$
  select r.amount, r.auto, r.source, r.recurring, r.recurring_auto
    from app.deal_value_rule(p_kind, p_recurring, p_amount, p_old_amount, p_old_auto, p_insert,
                             case when p_kind is null then p_lines end,
                             case when p_kind = 'monthly' then p_lines end,
                             null,
                             case when p_kind = 'yearly' then p_lines end,
                             p_old_recurring, p_old_recurring_auto, p_old_source) r
$$;

-- Security definer, as in DLI-03: it reads the internal app.deal_lines_sums. It uses no
-- current_user, auth.uid() or session setting, so it applies to every writer alike.
create or replace function app.deal_amount_auto() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v record;
  s record;
begin
  if tg_op = 'INSERT' then
    -- a new deal has no lines yet
    v := app.deal_value_rule(new.billing_kind, new.recurring_amount_agorot, new.amount_agorot, null, null, true,
                             null, null, null, null, null, null, null);
  else
    s := app.deal_lines_sums(new.organization_id, new.id, new.billing_kind);
    v := app.deal_value_rule(new.billing_kind, new.recurring_amount_agorot, new.amount_agorot, old.amount_agorot, old.amount_auto, false,
                             s.once, s.monthly, s.quarterly, s.yearly,
                             old.recurring_amount_agorot, old.recurring_amount_auto, old.amount_source);
  end if;
  new.amount_agorot := v.amount;
  new.amount_auto := v.auto;
  new.amount_source := v.source;
  new.recurring_amount_agorot := v.recurring;
  new.recurring_amount_auto := v.recurring_auto;
  return new;
end;
$$;

revoke all on function app.deal_amount_auto() from public, anon, authenticated;

create or replace trigger deals_amount_auto before insert or update on public.deals
  for each row execute function app.deal_amount_auto();

-- A line change recomputes its deal (the statement triggers deal_lines_recompute_* of DLI-03 call
-- this): an unchanged update, only when the rule's answer differs from what the deal holds.
create or replace function app.deal_recompute_value(p_org uuid, p_deal uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.deals d
     set amount_agorot = d.amount_agorot
   where d.organization_id = p_org and d.id = p_deal
     and (select (r.amount, r.auto, r.source, r.recurring, r.recurring_auto)
            from app.deal_lines_sums(d.organization_id, d.id, d.billing_kind) s
            cross join lateral app.deal_value_rule(d.billing_kind, d.recurring_amount_agorot, d.amount_agorot, d.amount_agorot, d.amount_auto, false,
                                                   s.once, s.monthly, s.quarterly, s.yearly,
                                                   d.recurring_amount_agorot, d.recurring_amount_auto, d.amount_source) r)
         is distinct from (d.amount_agorot, d.amount_auto, d.amount_source, d.recurring_amount_agorot, d.recurring_amount_auto);
end;
$$;
revoke all on function app.deal_recompute_value(uuid, uuid) from public, anon, authenticated;
