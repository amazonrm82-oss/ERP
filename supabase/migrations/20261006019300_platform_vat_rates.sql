-- =============================================================================
-- VAT rates managed from the platform panel (ADM-01, VAT part)
-- =============================================================================
-- Owner's decision of 15 October 2026 (DECISIONS.md "ניהול שיעורי מע"מ מהפלטפורמה"):
-- the platform owner adds a future VAT rate, and may correct or remove a rate
-- that is still in the future. Platform owners only, with two-step
-- verification (app.require_platform: the JWT claim aal = 'aal2'). A rate whose
-- day has begun in Israel is locked by app.vat_rates_guard for every writer.
-- Every action is written to app.platform_log.
--
-- Removing without a SQL delete: the hosted-database connector refuses a
-- migration whose text holds a delete statement (CLAUDE.md, Migrations), so a
-- removed future rate is marked cancelled (cancelled_at) instead of deleted.
-- A cancelled row never counts: app.vat_rate_at() (and through it
-- app.document_vat_rate(), app.org_document_vat_rate() and the deal line
-- functions) skips it, and so do the app's readers
-- (src/features/tax/queries.ts, src/features/deal-lines/queries.ts) and
-- vatRateAt()'s callers. The day stays one row (the unique key on
-- effective_from): adding a rate again on a cancelled day revives that row.
-- The guard now also refuses cancelling or reviving a row whose day has begun,
-- so the history of rates in force can never change.
--
--   platform_add_vat_rate(day, rate_bp, note)          -> id
--   platform_update_vat_rate(id, day, rate_bp, note)   -> id (future rows only)
--   platform_remove_vat_rate(id)                       (future rows only)
--
-- Refusals: a day that is not after today in Israel, or a row already in force
-- -> P0001 hint 'vat:rate_in_force'; another live rate on that day -> P0001
-- hint 'vat:date_taken'; a rate outside 0..10000 basis points or a note longer
-- than 200 characters -> 22023; an unknown or cancelled row -> P0002.
-- Every statement is safe to run twice.

alter table public.vat_rates add column if not exists cancelled_at timestamptz;
-- A truncate skips the row guard: nobody but the table owner (a migration) may truncate.
revoke truncate on public.vat_rates from service_role, authenticated, anon;
comment on column public.vat_rates.cancelled_at is
  'ADM-01: set when the platform owner removed this rate before its day began; a cancelled row never counts (app.vat_rate_at).';

-- The guard of migration vat_rates, plus: cancelling or reviving a row whose
-- day has begun is refused like any other change of it.
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
     and (tg_op = 'DELETE'
          or new.rate_bp is distinct from old.rate_bp
          or new.effective_from is distinct from old.effective_from
          or new.cancelled_at is distinct from old.cancelled_at) then
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

-- The rate in force on a day, in basis points; null before the first known
-- rate or for a null day. A cancelled row is skipped.
create or replace function app.vat_rate_at(p_date date) returns integer
language sql stable security invoker
set search_path = ''
as $$
  select r.rate_bp
    from public.vat_rates r
   where r.effective_from <= p_date
     and r.cancelled_at is null
   order by r.effective_from desc
   limit 1
$$;
revoke all on function app.vat_rate_at(date) from public, anon;
grant execute on function app.vat_rate_at(date) to authenticated, service_role;

-- Checks shared by add and update. Raises; returns the trimmed note.
create or replace function app.vat_rate_input(p_effective_from date, p_rate_bp integer, p_note text) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_effective_from is null or p_rate_bp is null or p_rate_bp < 0 or p_rate_bp > 10000 then
    raise exception 'invalid VAT rate' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'note too long' using errcode = '22023';
  end if;
  if p_effective_from <= (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'a VAT rate can only be added for a day after today'
      using errcode = 'P0001', hint = 'vat:rate_in_force';
  end if;
  return v_note;
end;
$$;
revoke all on function app.vat_rate_input(date, integer, text) from public, anon, authenticated;

-- Puts a live rate on a future day: revives a cancelled row of that day, or
-- inserts one. Refuses a day that already has a live rate. Returns the id.
create or replace function app.vat_rate_place(p_effective_from date, p_rate_bp integer, p_note text) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_row public.vat_rates%rowtype;
begin
  select * into v_row from public.vat_rates r where r.effective_from = p_effective_from for update;
  if found then
    if v_row.cancelled_at is null then
      raise exception 'a VAT rate already exists for this day' using errcode = 'P0001', hint = 'vat:date_taken';
    end if;
    update public.vat_rates
       set rate_bp = p_rate_bp, note = p_note, cancelled_at = null
     where id = v_row.id;
    return v_row.id;
  end if;
  begin
    insert into public.vat_rates (effective_from, rate_bp, note)
    values (p_effective_from, p_rate_bp, p_note)
    returning id into v_row.id;
  exception when unique_violation then
    -- another session placed a rate on this day at the same moment
    raise exception 'a VAT rate already exists for this day' using errcode = 'P0001', hint = 'vat:date_taken';
  end;
  return v_row.id;
end;
$$;
revoke all on function app.vat_rate_place(date, integer, text) from public, anon, authenticated;

create or replace function public.platform_add_vat_rate(p_effective_from date, p_rate_bp integer, p_note text default null) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_note text;
  v_id uuid;
begin
  perform app.require_platform(array[]::text[]);
  v_note := app.vat_rate_input(p_effective_from, p_rate_bp, p_note);
  v_id := app.vat_rate_place(p_effective_from, p_rate_bp, v_note);
  perform app.log_platform('vat_rate.add', null,
    jsonb_build_object('id', v_id, 'effective_from', p_effective_from, 'rate_bp', p_rate_bp, 'note', v_note));
  return v_id;
end;
$$;
revoke all on function public.platform_add_vat_rate(date, integer, text) from public, anon;
grant execute on function public.platform_add_vat_rate(date, integer, text) to authenticated;

create or replace function public.platform_update_vat_rate(p_id uuid, p_effective_from date, p_rate_bp integer, p_note text default null) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.vat_rates%rowtype;
  v_note text;
  v_id uuid;
begin
  perform app.require_platform(array[]::text[]);
  select * into v_old from public.vat_rates r where r.id = p_id for update;
  if not found or v_old.cancelled_at is not null then
    raise exception 'VAT rate not found' using errcode = 'P0002';
  end if;
  if v_old.effective_from <= (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'a VAT rate already in force cannot be changed; add a new row'
      using errcode = 'P0001', hint = 'vat:rate_in_force';
  end if;
  v_note := app.vat_rate_input(p_effective_from, p_rate_bp, p_note);
  if p_effective_from = v_old.effective_from then
    if p_rate_bp is not distinct from v_old.rate_bp and v_note is not distinct from v_old.note then
      return v_old.id;
    end if;
    update public.vat_rates set rate_bp = p_rate_bp, note = v_note where id = v_old.id;
    v_id := v_old.id;
  elsif exists (select 1 from public.vat_rates r where r.effective_from = p_effective_from) then
    -- the new day holds a row: a live one refuses (vat_rate_place), a cancelled
    -- one is revived with the new values and the old row is cancelled
    v_id := app.vat_rate_place(p_effective_from, p_rate_bp, v_note);
    update public.vat_rates set cancelled_at = now() where id = v_old.id;
  else
    begin
      update public.vat_rates set effective_from = p_effective_from, rate_bp = p_rate_bp, note = v_note where id = v_old.id;
    exception when unique_violation then
      -- another session placed a rate on that day at the same moment
      raise exception 'a VAT rate already exists for this day' using errcode = 'P0001', hint = 'vat:date_taken';
    end;
    v_id := v_old.id;
  end if;
  perform app.log_platform('vat_rate.update', null,
    jsonb_build_object('id', v_id,
      'old', jsonb_build_object('id', v_old.id, 'effective_from', v_old.effective_from, 'rate_bp', v_old.rate_bp, 'note', v_old.note),
      'new', jsonb_build_object('effective_from', p_effective_from, 'rate_bp', p_rate_bp, 'note', v_note)));
  return v_id;
end;
$$;
revoke all on function public.platform_update_vat_rate(uuid, date, integer, text) from public, anon;
grant execute on function public.platform_update_vat_rate(uuid, date, integer, text) to authenticated;

create or replace function public.platform_remove_vat_rate(p_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.vat_rates%rowtype;
begin
  perform app.require_platform(array[]::text[]);
  select * into v_old from public.vat_rates r where r.id = p_id for update;
  if not found or v_old.cancelled_at is not null then
    raise exception 'VAT rate not found' using errcode = 'P0002';
  end if;
  if v_old.effective_from <= (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'a VAT rate already in force cannot be removed'
      using errcode = 'P0001', hint = 'vat:rate_in_force';
  end if;
  update public.vat_rates set cancelled_at = now() where id = v_old.id;
  perform app.log_platform('vat_rate.remove', null,
    jsonb_build_object('id', v_old.id, 'effective_from', v_old.effective_from, 'rate_bp', v_old.rate_bp, 'note', v_old.note));
end;
$$;
revoke all on function public.platform_remove_vat_rate(uuid) from public, anon;
grant execute on function public.platform_remove_vat_rate(uuid) to authenticated;
