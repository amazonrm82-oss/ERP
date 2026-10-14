-- =============================================================================
-- Recurring revenue on deals (DEAL-07)
-- =============================================================================
-- A deal is one-time, monthly or yearly. Four nullable columns on deals:
--   billing_kind             null = one-time (the default), 'monthly' or 'yearly'
--   recurring_amount_agorot  the amount charged each month / year, in agorot (>= 0)
--   recurring_start_date     the day the recurring charge starts
--   renewal_date             the day the agreement comes up for renewal (optional,
--                            never before the start date)
-- A one-time deal holds none of the recurring fields; a monthly or yearly deal
-- needs an amount and a start date (constraint deals_recurring_shape).
--
-- Why billing_kind is nullable and not "not null default 'one_time'": app.sample_row()
-- (USR-04) ignores a column added after a sample snapshot only while it is null; a
-- not-null column with a default would make every existing sample deal look edited
-- and need an exception there (shared ground). null has one meaning only: one-time.
--
-- Currency: the recurring amount is in the deal's own currency (deals.currency, ILS
-- only by deals_currency_ils, TAX-06), the same column that stands next to
-- amount_agorot; no second currency column.
--
-- The deal's value (amount_agorot) and the first-year rule are derived by the database:
-- see "The first-year value" below (deals.amount_auto, trigger deals_amount_auto).
--
-- deals has a table-wide INSERT/UPDATE grant today; the column grants below keep the
-- columns writable if it ever moves to column grants (as leads, contacts and tasks did).
-- Audited by the existing deals audit trigger (whole-row diff). Not in merge picks
-- (app.merge_columns() is shared ground; follow-up). Safe to run twice.

alter table public.deals add column if not exists billing_kind text;
alter table public.deals add column if not exists recurring_amount_agorot bigint;
alter table public.deals add column if not exists recurring_start_date date;
alter table public.deals add column if not exists renewal_date date;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_billing_kind') then
    alter table public.deals add constraint deals_billing_kind check (billing_kind in ('monthly', 'yearly'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_recurring_shape') then
    alter table public.deals add constraint deals_recurring_shape check (
      case
        when billing_kind is null then
          recurring_amount_agorot is null and recurring_start_date is null and renewal_date is null
        else
          recurring_amount_agorot is not null and recurring_amount_agorot >= 0
          and recurring_start_date is not null
          and (renewal_date is null or renewal_date >= recurring_start_date)
      end
    );
  end if;
end;
$$;

grant insert (billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date),
      update (billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date)
   on public.deals to authenticated;

-- "renewals ahead" filters and sorts of the deals table
create index if not exists deals_renewal_date_idx
  on public.deals (organization_id, renewal_date)
  where renewal_date is not null and deleted_at is null;

-- -----------------------------------------------------------------------------
-- The first-year value (owner, 14 October 2026; DECISIONS.md, DEAL-07)
-- -----------------------------------------------------------------------------
-- deals.amount_auto: true while the deal's value is computed from its recurring terms,
-- null otherwise (never false: a nullable flag keeps app.sample_row() from seeing old
-- sample deals as edited). The database derives it on every write; whatever a writer
-- sends for it is ignored (deals still has a table-wide grant, so it is not refused).
--
-- The rule, app.deal_value() (pure), applied by trigger deals_amount_auto to EVERY writer
-- (forms, inline edit, bulk, board, duplicate, follow-up, won window, merge, imports,
-- automations and server functions alike: none needs an exception, since a writer that
-- keeps the value just keeps the flag). computed = 12 x the recurring amount on a monthly
-- deal, the yearly amount on a yearly one, null on a one-time deal.
--   1. "empty": the writer sends amount_agorot = null (insert or update). With computed:
--      value = computed, flag on. Without (one-time): value 0, flag off.
--   2. "typed": on insert a value is given (also the column default 0), or on update the
--      value differs from the old one. The value is kept as sent and the flag is off, even
--      when it equals the first-year value (owner: "ערך שהוקלד ידנית מכבה את הדגל ולא משתנה
--      יותר"); the value then never changes by itself again. A form that re-sends the value
--      it showed sends the old value, which is case 3, not typing.
--   3. "unchanged" (update, same value): while the flag was on and there is a computed
--      value, the value follows it (a change of the recurring amount or kind recomputes);
--      otherwise the value stays and the flag is off (a move to one-time keeps the value,
--      with no computation).
-- A computed value above 9007199254740991 agorot (the app's largest safe integer) is
-- refused when it would be stored: P0001, hint deal:amount_too_big.
-- Mirrored by dealValueRule() in src/features/deals/recurring.ts; both are checked against
-- tests/unit/fixtures/deal-value.json (unit test and tests/db/106-deal-recurring.test.ts).

alter table public.deals add column if not exists amount_auto boolean;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_amount_auto_true') then
    alter table public.deals add constraint deals_amount_auto_true check (amount_auto);
  end if;
end;
$$;

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
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_computed numeric;
begin
  v_computed := case
    when p_recurring is null then null
    when p_kind = 'monthly' then p_recurring::numeric * 12
    when p_kind = 'yearly' then p_recurring::numeric
  end;

  if p_amount is null
     or (not p_insert and p_amount = p_old_amount and p_old_auto is true and v_computed is not null) then
    -- empty, or unchanged while computed: the value follows the recurring terms
    if v_computed is null then
      amount := 0;
      auto := null;
    else
      if v_computed > 9007199254740991 then
        raise exception 'first-year value too big' using errcode = 'P0001', hint = 'deal:amount_too_big';
      end if;
      amount := v_computed::bigint;
      auto := true;
    end if;
  else
    -- typed (or given on insert): kept, flag off
    amount := p_amount;
    -- unchanged and not computed (or a move to one-time) keeps the value too, flag off
    auto := null;
  end if;
end;
$$;

revoke all on function app.deal_value(text, bigint, bigint, bigint, boolean, boolean) from public, anon;
grant execute on function app.deal_value(text, bigint, bigint, bigint, boolean, boolean) to authenticated, service_role;

-- security invoker: it reads no table, and applies to every writer
create or replace function app.deal_amount_auto() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v record;
begin
  if tg_op = 'INSERT' then
    v := app.deal_value(new.billing_kind, new.recurring_amount_agorot, new.amount_agorot, null, null, true);
  else
    v := app.deal_value(new.billing_kind, new.recurring_amount_agorot, new.amount_agorot, old.amount_agorot, old.amount_auto, false);
  end if;
  new.amount_agorot := v.amount;
  new.amount_auto := v.auto;
  return new;
end;
$$;

revoke all on function app.deal_amount_auto() from public, anon;

create or replace trigger deals_amount_auto before insert or update on public.deals
  for each row execute function app.deal_amount_auto();
