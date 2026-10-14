-- =============================================================================
-- The deal value from its product lines (DLI-03; owner, 14 October 2026)
-- =============================================================================
-- DECISIONS.md "ערך עסקה משורות מוצר". The deal value (deals.amount_agorot), in order:
--   1. a value a person typed;
--   2. the sum of the deal's product lines, before VAT;
--   3. a recurring deal with no lines: the first-year value of its recurring amount
--      (DEAL-07, migration deal_recurring, as before);
--   4. empty (0).
-- On a recurring deal (monthly / yearly) with lines, the lines' sum is the amount per
-- period: recurring_amount_agorot follows it while a person has not typed it, and the
-- deal value is the first year of that amount (12 x monthly, the yearly amount).
-- A typed value turns the computation off from both sources; clearing it (null) brings
-- it back.
--
-- New nullable columns (no app.sample_row() change: a key missing from a sample snapshot
-- is ignored while it is null):
--   deals.amount_source           null | 'lines' | 'first_year': which source the computed
--                                 value follows. Only with amount_auto. A row computed
--                                 before this migration has amount_auto true and no source;
--                                 it was a first-year value (the app reads it so), and it
--                                 gets its source on its next write. No bulk rewrite.
--   deals.recurring_amount_auto   true while the recurring amount follows the lines, null
--                                 otherwise (never false). Only on a recurring deal.
-- Both are derived by the database for every writer; whatever a writer sends is ignored
-- (deals has a table-wide grant, so it is not refused).
--
-- The lines' sum (app.deal_lines_sum, internal; app.deal_lines_net for direct callers): the before-VAT total of all the deal's lines by the
-- one totals rule, app.document_totals (TAX-05), in the deal's one VAT mode
-- (app.deal_lines_check). Lines priced without VAT add up as they are; on a deal priced
-- including VAT the taxable lines are carried back by the conversion rate of the day in
-- the business's zone (the business charges no VAT: 0; its status is not set: the
-- platform's rate of the day; none: 0), the same rate conversionRateBp() uses on the card;
-- exempt lines count at their amount. The deal stores the result; a later rate change
-- moves it only on the deal's next write or line change.
--
-- The rule is extended, not forked: app.deal_amount_rule() (pure) is DEAL-07's app.deal_value()
-- body plus the lines' sum and the old recurring state in, and the source and the recurring
-- amount out. app.deal_value() keeps its signature (a new signature would need a retired copy,
-- and re-running 0181 in a test would bring back a clashing overload) and is now the rule for
-- a deal without lines: the same answers as before.
--   The recurring amount (recurring deal only):
--     follows the lines when the writer sends null, or (update) sends the old amount while
--     it was following: the lines' sum; with no lines it keeps what it had (0 when empty),
--     flag on. Otherwise it is kept as sent, flag off ("typed"). So a recurring deal sent with no
--     recurring amount is no longer refused by deals_recurring_shape (DEAL-07): it holds 0 and
--     waits for lines. An import still asks for the amount (recurringSchema in the app).
--   The computed value: a recurring deal, the first year of its recurring amount (source
--     'lines' while that amount follows existing lines, else 'first_year'); a one-time deal
--     with lines, the lines' sum (source 'lines'); otherwise none. A recurring amount that is
--     following with no lines and holds 0 ("empty, waiting for lines") computes nothing: the
--     value is empty (0, no flag, no source), so the flag always names a real source; the app
--     shows such an amount as empty (shownRecurringAmount()).
--   The value: as in DEAL-07 (empty, or unchanged while computed: follows; else kept), plus
--     two rules for the lines:
--     * "0 is empty" (owner: "(4) ריק (0, כמו היום)"): an unchanged value of 0 that is not
--       computed follows the lines when the deal has lines. Every deal saved with an empty
--       value before this migration holds 0 with no flag; this lets its lines drive it.
--       A deliberately typed 0 therefore gives way to the lines on the next line change.
--     * all lines gone: an unchanged value computed from the lines (source 'lines') with
--       nothing left to compute becomes empty (0, flag off). A first-year value moved to
--       one-time keeps its value, as in DEAL-07.
-- Mirrored by dealValueRule() in src/features/deals/recurring.ts; both are checked against
-- tests/unit/fixtures/deal-value.json (unit test and tests/db/106); behaviour in tests/db/110.
--
-- When lines change, the deal recomputes through its own trigger (one rule for every
-- writer): statement triggers on deal_lines (insert, update, delete; transition tables)
-- give each touched deal an unchanged update (amount_agorot = amount_agorot), and only when
-- the rule's answer differs from what the deal holds, so a line change that moves nothing
-- writes nothing (no audit entry, no outbox event). Security definer: the line policies
-- already require app.can_edit_record on the deal and a deal not in the bin, and server
-- writers (purge, sample removal, erasure) need the same path. No loop: the deal triggers
-- never write lines. A deal deleted with its lines (cascade) is gone: the update finds no
-- row. A deal in the bin is recomputed like any other.
--
-- No drops, no row removal, no bulk rewrite. Safe to run twice.

alter table public.deals add column if not exists amount_source text;
alter table public.deals add column if not exists recurring_amount_auto boolean;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_amount_source') then
    alter table public.deals add constraint deals_amount_source
      check (amount_source is null or (amount_source in ('lines', 'first_year') and amount_auto is true));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_recurring_amount_auto') then
    alter table public.deals add constraint deals_recurring_amount_auto
      check (recurring_amount_auto is null or (recurring_amount_auto and billing_kind is not null));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- The lines' sum before VAT
-- -----------------------------------------------------------------------------
-- Two functions, so that a person's read rights never change what the trigger stores:
--   app.deal_lines_sum(org, deal): the sum, always. Internal: security definer (the rate reads
--     the business's VAT settings), granted to no one; only the trigger functions below
--     (security definer, same owner) call it. A writer the deal is hidden from (a merge by a
--     team manager through app.merge_move_links updates other teams' deals) still gets the
--     true sum, so the stored value never drops to "all lines gone".
--   app.deal_lines_net(org, deal): the same sum for a direct caller: a signed-in caller gets an
--     answer only for a deal they may read (app.can_read_record on the deal's owner and team,
--     read here); a server caller (no auth.uid()) always.
-- null = no lines (or, from deal_lines_net, not readable).
create or replace function app.deal_lines_sum(p_org uuid, p_deal uuid) returns bigint
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
  v_gross boolean;
  v_rate integer := 0;
  v_charges boolean;
  v_day date;
begin
  select jsonb_agg(jsonb_build_object(
           'quantity', l.quantity,
           'unit_price_agorot', l.unit_price_agorot,
           'discount_bp', l.discount_bp,
           'discount_agorot', l.discount_agorot,
           'vat_exempt', l.vat_exempt) order by l.position, l.created_at, l.id),
         bool_or(l.price_includes_vat)
    into v_lines, v_gross
    from public.deal_lines l
   where l.organization_id = p_org and l.deal_id = p_deal;
  if v_lines is null then
    return null;
  end if;
  if v_gross then
    v_charges := app.org_charges_vat(p_org);
    if v_charges is distinct from false then
      v_day := (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
      v_rate := coalesce(app.vat_rate_at(v_day), 0);
    end if;
  end if;
  return (app.document_totals(v_lines, v_rate, v_gross) ->> 'net_total_agorot')::bigint;
end;
$$;
revoke all on function app.deal_lines_sum(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.deal_lines_net(p_org uuid, p_deal uuid) returns bigint
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not exists (
       select 1 from public.deals d
        where d.organization_id = p_org and d.id = p_deal
          and app.can_read_record(d.organization_id, d.owner_id, d.team_id)) then
    return null;
  end if;
  return app.deal_lines_sum(p_org, p_deal);
end;
$$;
revoke all on function app.deal_lines_net(uuid, uuid) from public, anon;
grant execute on function app.deal_lines_net(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The rule (pure)
-- -----------------------------------------------------------------------------
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
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_computed numeric;
  v_source text;
begin
  -- DLI-03: the recurring amount follows the lines while nobody typed it
  recurring := p_recurring;
  recurring_auto := null;
  if p_kind is not null
     and (p_recurring is null
          or (not p_insert and p_recurring = p_old_recurring and p_old_recurring_auto is true)) then
    recurring := coalesce(p_lines, p_recurring, 0);
    recurring_auto := true;
  end if;

  if p_kind is not null then
    v_computed := case
      when recurring is null then null
      -- an amount waiting for lines (following, none yet, 0) is nothing to compute from: empty
      when recurring_auto is true and p_lines is null and recurring = 0 then null
      when p_kind = 'monthly' then recurring::numeric * 12
      when p_kind = 'yearly' then recurring::numeric
    end;
    v_source := case when recurring_auto is true and p_lines is not null then 'lines' else 'first_year' end;
  elsif p_lines is not null then
    v_computed := p_lines;
    v_source := 'lines';
  end if;

  if p_amount is null
     or (not p_insert and p_amount = p_old_amount and p_old_auto is true and v_computed is not null)
     -- "0 is empty": an unchanged 0 nobody computed follows the lines
     or (not p_insert and p_amount = p_old_amount and p_amount = 0 and p_old_auto is not true
         and p_lines is not null and v_computed is not null) then
    -- empty, or unchanged while computed: the value follows its source
    if v_computed is null then
      amount := 0;
      auto := null;
      source := null;
    else
      if v_computed > 9007199254740991 then
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
    -- unchanged and not computed (or a move to one-time) keeps the value too, flag off
    auto := null;
    source := null;
  end if;
end;
$$;

revoke all on function app.deal_amount_rule(text, bigint, bigint, bigint, boolean, boolean, bigint, bigint, boolean, text) from public, anon;
grant execute on function app.deal_amount_rule(text, bigint, bigint, bigint, boolean, boolean, bigint, bigint, boolean, text) to authenticated, service_role;

-- DEAL-07's entry point, same signature and grants: the rule for a deal without lines
create or replace function app.deal_value(
  p_kind text,
  p_recurring bigint,
  p_amount bigint,
  p_old_amount bigint,
  p_old_auto boolean,
  p_insert boolean,
  out amount bigint,
  out auto boolean
)
language sql
immutable
set search_path = ''
as $$
  select r.amount, r.auto
    from app.deal_amount_rule(p_kind, p_recurring, p_amount, p_old_amount, p_old_auto, p_insert, null, null, null, null) r
$$;

-- Security definer (it was invoker in 0181): it reads the internal app.deal_lines_sum, which no
-- client role may execute. Safe because the rule never tells a person from a server: it uses no
-- current_user, auth.uid() or session setting, only NEW, OLD and the lines' sum, and applies to
-- every writer alike (DEAL-07). RLS on deals is untouched: the trigger only shapes a row the
-- writer was already allowed to write.
create or replace function app.deal_amount_auto() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v record;
begin
  if tg_op = 'INSERT' then
    -- a new deal has no lines yet
    v := app.deal_amount_rule(new.billing_kind, new.recurring_amount_agorot, new.amount_agorot, null, null, true, null, null, null, null);
  else
    v := app.deal_amount_rule(new.billing_kind, new.recurring_amount_agorot, new.amount_agorot, old.amount_agorot, old.amount_auto, false,
                        app.deal_lines_sum(new.organization_id, new.id),
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

-- -----------------------------------------------------------------------------
-- A line change recomputes its deal
-- -----------------------------------------------------------------------------
-- One deal: an unchanged update, so the deal trigger applies the one rule; only when the
-- rule's answer differs from what the deal holds. A deal already deleted is not found.
create or replace function app.deal_recompute_value(p_org uuid, p_deal uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.deals d
     set amount_agorot = d.amount_agorot
   where d.organization_id = p_org and d.id = p_deal
     and (select (r.amount, r.auto, r.source, r.recurring, r.recurring_auto)
            from app.deal_amount_rule(d.billing_kind, d.recurring_amount_agorot, d.amount_agorot, d.amount_agorot, d.amount_auto, false,
                                app.deal_lines_sum(d.organization_id, d.id),
                                d.recurring_amount_agorot, d.recurring_amount_auto, d.amount_source) r)
         is distinct from (d.amount_agorot, d.amount_auto, d.amount_source, d.recurring_amount_agorot, d.recurring_amount_auto);
end;
$$;
revoke all on function app.deal_recompute_value(uuid, uuid) from public, anon, authenticated;

-- Statement triggers: each touched deal once per statement. A transition table exists only for
-- its own event, so each event reads its own.
create or replace function app.deal_lines_recompute() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v record;
begin
  if tg_op = 'INSERT' then
    for v in select distinct n.organization_id, n.deal_id from deal_lines_new n loop
      perform app.deal_recompute_value(v.organization_id, v.deal_id);
    end loop;
  elsif tg_op = 'UPDATE' then
    -- a line never moves to another deal (app.deal_lines_check), so the new rows name them all
    for v in select distinct n.organization_id, n.deal_id from deal_lines_new n loop
      perform app.deal_recompute_value(v.organization_id, v.deal_id);
    end loop;
  else
    for v in select distinct o.organization_id, o.deal_id from deal_lines_old o loop
      perform app.deal_recompute_value(v.organization_id, v.deal_id);
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function app.deal_lines_recompute() from public, anon, authenticated;

create or replace trigger deal_lines_recompute_insert after insert on public.deal_lines
  referencing new table as deal_lines_new
  for each statement execute function app.deal_lines_recompute();
create or replace trigger deal_lines_recompute_update after update on public.deal_lines
  referencing new table as deal_lines_new
  for each statement execute function app.deal_lines_recompute();
create or replace trigger deal_lines_recompute_delete after delete on public.deal_lines
  referencing old table as deal_lines_old
  for each statement execute function app.deal_lines_recompute();
