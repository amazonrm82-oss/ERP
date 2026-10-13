-- =============================================================================
-- VAT rates of the platform, by effective date (TAX-03, wave 2)
-- =============================================================================
-- public.vat_rates: one row per change of the Israeli VAT rate. A platform
-- table (no organization_id): the rate is the law, the same for every business.
--   effective_from   the first day the rate applies (unique)
--   rate_bp          the rate in basis points: 1800 = 18%. An integer, like
--                    money in agorot, so no rounding hides in a float.
-- A change of rate is a new row, never an update of an old one (enforced by
-- trigger vat_rates_guard for every rate already in force): a document
-- uses the rate of its own date, app.vat_rate_at(date), so a document dated
-- before a change keeps the old rate. The rate is never written in code; the
-- app reads this table (src/features/tax/rates.ts mirrors app.vat_rate_at()).
-- Seed: 17% from 1 October 2015, 18% from 1 January 2025 (SPEC-ADDITIONS 4.1).
-- A date before the first row has no rate: app.vat_rate_at() answers null, and
-- app.document_vat_rate(), the one a document uses, refuses the date
-- (P0001, hint 'vat:before_table'; owner, 13 October 2026: no rates before
-- 1 October 2015 are needed). A document stores the rate it was made with
-- (its own column, in the quote and document waves), so a later change of
-- this table never changes a document that was already sent.
-- * Every signed-in user reads it; no client writes it (no grants). The
--   platform admin screen (ADM-01) will manage it later through a platform_*
--   function; until then a new rate comes in a migration.
-- * Whether a business charges VAT at all is TAX-01 (app.org_charges_vat());
--   an exempt business shows no VAT line whatever the rate.
-- Every statement is safe to run twice.

create table if not exists public.vat_rates (
  id             uuid primary key default gen_random_uuid(),
  effective_from date not null
                 constraint vat_rates_effective_from_key unique,
  rate_bp        integer not null
                 constraint vat_rates_rate_bp_check check (rate_bp between 0 and 10000),
  note           text constraint vat_rates_note_check check (note is null or char_length(note) <= 200),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.vat_rates is
  'TAX-03: Israeli VAT rate by effective date (platform table). A document uses app.vat_rate_at(its date). A change is a new row.';
comment on column public.vat_rates.rate_bp is 'TAX-03: basis points, 1800 = 18%.';

create or replace trigger vat_rates_touch before insert or update on public.vat_rates
  for each row execute function app.touch_row();

alter table public.vat_rates enable row level security;
revoke all on public.vat_rates from anon, authenticated;
grant select on public.vat_rates to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'vat_rates' and policyname = 'vat_rates_select') then
    create policy vat_rates_select on public.vat_rates for select to authenticated using (true);
  end if;
end;
$$;

-- The seed comes before the guard below, which refuses rows dated in the past;
-- on a second run the guard lets an already stored day through and
-- "on conflict do nothing" skips it.
insert into public.vat_rates (effective_from, rate_bp, note) values
  ('2015-10-01', 1700, '17%'),
  ('2025-01-01', 1800, '18%')
on conflict (effective_from) do nothing;

-- A rate already in force is history: documents of its days were priced with
-- it. "Today" is the day in Israel. Refused for every writer (hint
-- 'vat:rate_in_force'), unless a migration disables this trigger on purpose:
--   * a new row dated today or earlier (a stored day passes, so the unique key
--     answers: "on conflict do nothing" skips it, a plain insert gets 23505);
--   * changing the rate or the day of a row in force, or removing it;
--   * moving a row to a day that has begun.
-- A row still in the future may be corrected or removed; the note may always
-- be fixed.
create or replace function app.vat_rates_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  if tg_op = 'INSERT' then
    if new.effective_from <= v_today
       and not exists (select 1 from public.vat_rates r where r.effective_from = new.effective_from) then
      raise exception 'a VAT rate cannot start on a day that has begun; add it ahead of time'
        using errcode = 'P0001', hint = 'vat:rate_in_force';
    end if;
    return new;
  end if;
  if old.effective_from <= v_today
     and (tg_op = 'DELETE' or new.rate_bp is distinct from old.rate_bp or new.effective_from is distinct from old.effective_from) then
    raise exception 'a VAT rate already in force cannot be changed or removed; add a new row'
      using errcode = 'P0001', hint = 'vat:rate_in_force';
  end if;
  if tg_op = 'UPDATE' and new.effective_from is distinct from old.effective_from and new.effective_from <= v_today then
    raise exception 'a VAT rate cannot be moved to a day that has begun; add a new row'
      using errcode = 'P0001', hint = 'vat:rate_in_force';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.vat_rates_guard() from public, anon, authenticated;

create or replace trigger vat_rates_guard before insert or update or delete on public.vat_rates
  for each row execute function app.vat_rates_guard();

-- The rate in force on a day, in basis points; null before the first known
-- rate or for a null day. Security invoker: the table is readable by every
-- signed-in user and by the server.
create or replace function app.vat_rate_at(p_date date) returns integer
language sql stable security invoker
set search_path = ''
as $$
  select r.rate_bp
    from public.vat_rates r
   where r.effective_from <= p_date
   order by r.effective_from desc
   limit 1
$$;
revoke all on function app.vat_rate_at(date) from public, anon;
grant execute on function app.vat_rate_at(date) to authenticated, service_role;

-- The rate a document of this date uses, in basis points. A date before the
-- first row is refused with its own hint, so the app can say so plainly; no
-- date at all is refused too. The date is the document's own date, never now().
create or replace function app.document_vat_rate(p_date date) returns integer
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_rate integer;
begin
  if p_date is null then
    raise exception 'a document needs a date for its VAT rate' using errcode = '22004';
  end if;
  v_rate := app.vat_rate_at(p_date);
  if v_rate is null then
    raise exception 'no VAT rate for a document dated %', p_date using errcode = 'P0001', hint = 'vat:before_table';
  end if;
  return v_rate;
end;
$$;
revoke all on function app.document_vat_rate(date) from public, anon;
grant execute on function app.document_vat_rate(date) to authenticated, service_role;
