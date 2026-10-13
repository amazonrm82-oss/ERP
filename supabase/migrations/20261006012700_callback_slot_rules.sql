-- =============================================================================
-- Call-back slots follow the business's day (SPD-05 follow-ups, wave 1)
-- =============================================================================
-- Owner's answers of 13 October 2026. The fixed slots (09-12, 12-15, 15-18,
-- 18-20) stay until CAP-09 (wave 2), with these rules, all in the business's
-- time zone:
--   1. a slot of today that has ended is not offered (as before);
--   2. "now" is offered only from 08:00 to 20:00;
--   3. the second day is the business's next working day: rest weekdays and the
--      holidays / eves / occasions it closes on (CAL-03, org_calendar_settings,
--      no row = Friday and Saturday off, holidays off) are skipped. It is called
--      "מחר" when it is tomorrow, else by its name ("יום ראשון");
--      a short working day is a Friday, a holiday eve (an occasion of kind
--      'erev') or Yom HaZikaron (kind 'short'), followed by a rest day of the
--      business (app.short_work_day(), one rule for all three; the calendar's
--      own marks, CAL-03/CAL-05, are unchanged;
--      a business that works the next day keeps a normal day): only the slots
--      that end by 15:00 are offered, today as well as on the next working day,
--      and "now" only until 15:00; from 15:00 a short day is closed like a rest
--      day (below);
--      on the business's rest day (app.org_rest_day() for today, until midnight
--      in its zone; hours come with CAP-09), and on a short day from 15:00,
--      neither "now" nor today's slots are offered, only the next working day's,
--      under the line "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום <name>?"
--      (offer key closed_line); a business with no rest days is unchanged.
--      pick() refuses "now" and today's slots on a rest day with callback:invalid
--      ("בחרו מהרשימה…": they were never on the list); on a short day after
--      15:00 "now" and an ended slot are callback:past ("השעה שבחרתם כבר עברה"),
--      a slot past 15:00 callback:invalid. The lead comes in and is announced
--      as usual in every case;
--   4. forms.callback_slots_off: slots an owner or admin switched off in the form
--      settings (start hours '09', '12', '15', '18'); default none (all on).
--      Column grants like callback_choice; policies forms_insert / forms_update
--      unchanged; audited as a form change.
-- The rules live in the database only: app.intake_callback_options() lists the
-- candidate slots with what is allowed and what has ended,
-- app.intake_callback_offer() is what the hosted form shows (public.intake_form()
-- returns it, so the page renders exactly what intake_submit() will accept), and
-- app.intake_callback_pick() resolves a choice or refuses it (22023, hint
-- callback:invalid for a choice that is not offered, callback:past for a slot
-- that has ended, a day that has passed, or "now" outside the hours).
-- A slot travels with its business date: 'YYYY-MM-DD-HH' (or 'now'), so a page
-- made before midnight and sent after it books the day it showed, or is refused;
-- the call never moves to another day. The relative values of 0119
-- ('today-09', 'tomorrow-09') are no longer accepted (callback:invalid).
-- The Hebrew calendar: app.hebrew_date() and app.israel_occasions() are a port
-- of src/features/calendar-days/holidays.ts (same arithmetic, same rules; a
-- database test compares the two day by day). app.org_rest_day() mirrors
-- restReason() there.
--
-- Notifications (owner's answer, 13 October 2026): the call task of a call-back
-- request is not announced to a person who has just been told about the same
-- lead (new-lead notification) or record (repeat inquiry) by this request; the
-- task is created as before and is in their list. A future slot still reminds at
-- its start (remind_at), "now" does not remind. A task owner who was not told
-- (someone else owns the lead, or they muted that notification) gets the task's
-- "assigned" notification as before. Mechanism: app.intake_call_task() sets the
-- transaction-local app.intake_quiet_task to the owner's id while it inserts the
-- task; app.notify_assignment() skips that one insert. Every other task is as before.
--
-- app.intake_callback_at(), app.intake_callback_label() and
-- app.intake_callback_task() of 0119 stay but are no longer used.
-- Every statement is safe to run twice.

alter table public.forms add column if not exists callback_slots_off text[] not null default '{}';

alter table public.forms drop constraint if exists forms_callback_slots_off_check;
alter table public.forms add constraint forms_callback_slots_off_check
  check (callback_slots_off <@ array['09', '12', '15', '18']::text[]
         and cardinality(callback_slots_off) <= 4
         and array_position(callback_slots_off, null) is null);

comment on column public.forms.callback_slots_off is
  'SPD-05: call-back slots switched off on this form, by start hour (09, 12, 15, 18); empty = all on.';

grant insert (callback_slots_off), update (callback_slots_off) on public.forms to authenticated;

-- ----------------------------------------------------------------------------
-- The Hebrew calendar (port of src/features/calendar-days/holidays.ts)
-- ----------------------------------------------------------------------------

-- Days from the epoch to the molad of Tishrei, after the rule that moves Rosh
-- Hashana off Sunday, Wednesday and Friday (elapsedDays()).
create or replace function app.hebrew_elapsed_days(p_year integer) returns bigint
language sql immutable
set search_path = ''
as $$
  select case when (3 * (x.days + 1)) % 7 < 3 then x.days + 1 else x.days end
    from (select 29 * m.months + (12084 + 13753 * m.months) / 25920 as days
            from (select (235 * p_year::bigint - 234) / 19 as months) m) x;
$$;

-- Day number (1 January of year 1 = 1) of 1 Tishrei of a Hebrew year (newYear()).
create or replace function app.hebrew_new_year(p_year integer) returns bigint
language plpgsql immutable
set search_path = ''
as $$
declare
  v_before bigint := app.hebrew_elapsed_days(p_year - 1);
  v_now bigint := app.hebrew_elapsed_days(p_year);
  v_after bigint := app.hebrew_elapsed_days(p_year + 1);
  v_delay int := 0;
begin
  if v_after - v_now = 356 then
    v_delay := 2;
  elsif v_now - v_before = 382 then
    v_delay := 1;
  end if;
  return -1373427 + v_now + v_delay;
end;
$$;

-- Lengths of the months 1..13 from Tishrei (Adar I is 0 days in a common year).
create or replace function app.hebrew_month_lengths(p_year integer) returns integer[]
language plpgsql immutable
set search_path = ''
as $$
declare
  v_length bigint := app.hebrew_new_year(p_year + 1) - app.hebrew_new_year(p_year);
begin
  return array[30,
               case when v_length % 10 = 5 then 30 else 29 end,
               case when v_length % 10 = 3 then 29 else 30 end,
               29, 30,
               case when (7 * p_year + 1) % 19 < 7 then 30 else 0 end,
               29, 30, 29, 30, 29, 30, 29];
end;
$$;

-- The Hebrew date during the daytime of a calendar day (hebrewDate()).
create or replace function app.hebrew_date(p_day date, out h_year integer, out h_month integer, out h_day integer)
language plpgsql immutable
set search_path = ''
as $$
declare
  v_fixed bigint := (p_day - date '1970-01-01') + 719163;
  v_rest bigint;
  v_lengths integer[];
begin
  h_year := floor((v_fixed + 1373427) / 365.25)::integer + 1;
  while app.hebrew_new_year(h_year) > v_fixed loop
    h_year := h_year - 1;
  end loop;
  while app.hebrew_new_year(h_year + 1) <= v_fixed loop
    h_year := h_year + 1;
  end loop;
  v_rest := v_fixed - app.hebrew_new_year(h_year);
  v_lengths := app.hebrew_month_lengths(h_year);
  h_month := 1;
  while v_rest >= v_lengths[h_month] loop
    v_rest := v_rest - v_lengths[h_month];
    h_month := h_month + 1;
  end loop;
  h_day := v_rest + 1;
end;
$$;

-- The occasions of a day, by key and kind (holidaysOn(), names left out).
-- Months from Tishrei: 1 Tishrei, 3 Kislev, 4 Tevet, 5 Shevat, 7 Adar (Adar II
-- in a leap year), 8 Nisan, 9 Iyar, 10 Sivan, 12 Av, 13 Elul.
create or replace function app.israel_occasions(p_day date, out key text, out kind text) returns setof record
language plpgsql immutable
set search_path = ''
as $$
declare
  v_h record;
  v_m integer;
  v_d integer;
  v_w integer := extract(dow from p_day)::integer;
begin
  if p_day is null then
    return;
  end if;
  select * into v_h from app.hebrew_date(p_day);
  v_m := v_h.h_month;
  v_d := v_h.h_day;

  if v_m = 1 then
    if v_d in (1, 2) then key := 'rosh_hashana'; kind := 'rest'; return next;
    elsif v_d = 9 then key := 'yom_kippur_eve'; kind := 'erev'; return next;
    elsif v_d = 10 then key := 'yom_kippur'; kind := 'rest'; return next;
    elsif v_d = 14 then key := 'sukkot_eve'; kind := 'erev'; return next;
    elsif v_d = 15 then key := 'sukkot'; kind := 'rest'; return next;
    elsif v_d between 16 and 20 then key := 'chol_hamoed_sukkot'; kind := 'observance'; return next;
    elsif v_d = 21 then key := 'hoshana_raba'; kind := 'erev'; return next;
    elsif v_d = 22 then key := 'simchat_torah'; kind := 'rest'; return next;
    end if;
  elsif v_m = 3 then
    if v_d >= 25 then key := 'chanukah'; kind := 'observance'; return next; end if;
  elsif v_m = 4 then
    -- eight days from 25 Kislev
    if (app.hebrew_month_lengths(v_h.h_year))[3] - 24 + v_d <= 8 then
      key := 'chanukah'; kind := 'observance'; return next;
    end if;
  elsif v_m = 5 then
    if v_d = 15 then key := 'tu_bishvat'; kind := 'observance'; return next; end if;
  elsif v_m = 7 then
    if v_d = 14 then key := 'purim'; kind := 'observance'; return next;
    elsif v_d = 15 then key := 'shushan_purim'; kind := 'observance'; return next;
    end if;
  elsif v_m = 8 then
    if v_d = 14 then key := 'pesach_eve'; kind := 'erev'; return next;
    elsif v_d = 15 then key := 'pesach'; kind := 'rest'; return next;
    elsif v_d between 16 and 19 then key := 'chol_hamoed_pesach'; kind := 'observance'; return next;
    elsif v_d = 20 then key := 'pesach_7_eve'; kind := 'erev'; return next;
    elsif v_d = 21 then key := 'pesach_7'; kind := 'rest'; return next;
    elsif (v_d = 22 and v_w <> 6) or (v_d = 23 and v_w = 0) then key := 'mimouna'; kind := 'observance'; return next;
    end if;
    if (v_d = 27 and v_w not in (5, 0)) or (v_d = 26 and v_w = 4) or (v_d = 28 and v_w = 1) then
      key := 'yom_hashoah'; kind := 'observance'; return next;
    end if;
  elsif v_m = 9 then
    if (v_d = 5 and v_w = 3) or (v_d = 4 and v_w = 4) or (v_d = 3 and v_w = 4) or (v_d = 6 and v_w = 2) then
      key := 'yom_haatzmaut'; kind := 'rest'; return next;
    end if;
    if (v_d = 4 and v_w = 2) or (v_d = 3 and v_w = 3) or (v_d = 2 and v_w = 3) or (v_d = 5 and v_w = 1) then
      key := 'yom_hazikaron'; kind := 'short'; return next;
    end if;
    if v_d = 18 then key := 'lag_baomer'; kind := 'observance'; return next; end if;
    if v_d = 28 then key := 'yom_yerushalayim'; kind := 'observance'; return next; end if;
  elsif v_m = 10 then
    if v_d = 5 then key := 'shavuot_eve'; kind := 'erev'; return next;
    elsif v_d = 6 then key := 'shavuot'; kind := 'rest'; return next;
    end if;
  elsif v_m = 12 then
    if v_d = 9 and v_w <> 6 then key := 'tisha_bav'; kind := 'observance'; return next;
    elsif v_d = 10 and v_w = 0 then key := 'tisha_bav'; kind := 'observance'; return next;
    end if;
  elsif v_m = 13 then
    if v_d = 29 then key := 'rosh_hashana_eve'; kind := 'erev'; return next; end if;
  end if;
  return;
end;
$$;

-- Is a day a day off for the business (restReason() of holidays.ts): an occasion
-- it closes on, or a weekly rest day. No settings row = the defaults.
create or replace function app.org_rest_day(p_org uuid, p_day date) returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_weekdays smallint[] := '{5,6}';
  v_holidays boolean := true;
  v_eves boolean := false;
  v_occasions text[] := '{}';
  v_row record;
begin
  select c.rest_weekdays, c.holidays_rest, c.holiday_eves_rest, c.rest_occasions into v_row
    from public.org_calendar_settings c
   where c.organization_id = p_org;
  if found then
    v_weekdays := v_row.rest_weekdays;
    v_holidays := v_row.holidays_rest;
    v_eves := v_row.holiday_eves_rest;
    v_occasions := v_row.rest_occasions;
  end if;
  if exists (select 1 from app.israel_occasions(p_day) o
              where (o.kind = 'rest' and v_holidays) or (o.kind = 'erev' and v_eves) or o.key = any (v_occasions)) then
    return true;
  end if;
  -- the app keeps a business working at least one day (restDays())
  if cardinality(v_weekdays) >= 7 then
    v_weekdays := '{5,6}';
  end if;
  return extract(dow from p_day)::smallint = any (v_weekdays);
end;
$$;

-- ----------------------------------------------------------------------------
-- The call-back choice
-- ----------------------------------------------------------------------------

-- A short working day: a Friday, a holiday eve or Yom HaZikaron (the calendar's
-- shortened day) whose next day is a rest day of the business. Slots and "now"
-- end at 15:00 then.
create or replace function app.short_work_day(p_org uuid, p_day date) returns boolean
language sql stable
set search_path = ''
as $$
  select (extract(dow from p_day)::int = 5
          or exists (select 1 from app.israel_occasions(p_day) o where o.kind in ('erev', 'short')))
         and app.org_rest_day(p_org, p_day + 1);
$$;

-- Every candidate slot of today and of the next working day, in order, with
-- whether the form may offer it (switched on, and not past 15:00 on a short day)
-- and whether it has ended. value: '<business date>-<09|12|15|18>'
-- ('2026-10-15-09'); day_label: the group on the form ('היום', 'מחר', 'יום ראשון');
-- phrase: the words of the task and the notification ('מחר בין 09:00 ל-12:00').
create or replace function app.intake_callback_options(p_org uuid, p_slots_off text[], p_now timestamptz)
returns table (value text, day_label text, slot_label text, phrase text,
               starts_at timestamptz, ends_at timestamptz, allowed boolean, ended boolean)
language plpgsql stable
set search_path = ''
as $$
declare
  v_zone text;
  v_today date;
  v_next date;
  v_day date;
  v_key text;
  v_short boolean;
  v_dow integer;
  v_slot record;
  v_names text[] := array['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
  v_on_names text[] := array['ביום ראשון', 'ביום שני', 'ביום שלישי', 'ביום רביעי', 'ביום חמישי', 'ביום שישי', 'בשבת'];
  v_closed boolean;
begin
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_today := (p_now at time zone v_zone)::date;
  for i in 1..31 loop
    if not app.org_rest_day(p_org, v_today + i) then
      v_next := v_today + i;
      exit;
    end if;
  end loop;
  v_next := coalesce(v_next, v_today + 1);
  -- the business rests today: nothing of today is offered (a short day after
  -- 15:00 needs no rule here: its allowed slots have ended)
  v_closed := app.org_rest_day(p_org, v_today);

  foreach v_key in array array['today', 'tomorrow'] loop
    v_day := case when v_key = 'today' then v_today else v_next end;
    v_dow := extract(dow from v_day)::integer;
    -- a Friday or a holiday eve before a rest day: only the slots that end by 15:00
    v_short := app.short_work_day(p_org, v_day);
    day_label := case when v_key = 'today' then 'היום' when v_day = v_today + 1 then 'מחר' else v_names[v_dow + 1] end;
    for v_slot in
      select s.h_from, s.h_to from (values (9, 12), (12, 15), (15, 18), (18, 20)) s(h_from, h_to) order by s.h_from
    loop
      value := to_char(v_day, 'YYYY-MM-DD') || '-' || to_char(v_slot.h_from, 'FM00');
      slot_label := to_char(v_slot.h_from, 'FM00') || ':00–' || to_char(v_slot.h_to, 'FM00') || ':00';
      phrase := case when v_key = 'today' then 'היום' when v_day = v_today + 1 then 'מחר' else v_on_names[v_dow + 1] end
                || ' בין ' || to_char(v_slot.h_from, 'FM00') || ':00 ל-' || to_char(v_slot.h_to, 'FM00') || ':00';
      starts_at := (v_day + make_time(v_slot.h_from, 0, 0)) at time zone v_zone;
      ends_at := (v_day + make_time(v_slot.h_to, 0, 0)) at time zone v_zone;
      allowed := not (to_char(v_slot.h_from, 'FM00') = any (coalesce(p_slots_off, '{}'))) and not (v_short and v_slot.h_to > 15)
                 and not (v_key = 'today' and v_closed);
      ended := ends_at <= p_now;
      return next;
    end loop;
  end loop;
end;
$$;

-- "Now" is offered from 08:00 to 20:00 in the business's time zone, to 15:00
-- on a short day (and not on a rest day: app.intake_callback_closed_today()).
create or replace function app.intake_callback_now_open(p_org uuid, p_now timestamptz) returns boolean
language sql stable
set search_path = ''
as $$
  select t.local::time >= time '08:00'
         and t.local::time < case when app.short_work_day(p_org, t.local::date) then time '15:00' else time '20:00' end
    from (select p_now at time zone coalesce((select app.intake_zone(o.timezone) from public.organizations o where o.id = p_org),
                                             'Asia/Jerusalem') as local) t;
$$;

-- Is the business closed for the rest of today (its zone): a rest day, or a
-- short day from 15:00.
create or replace function app.intake_callback_closed_today(p_org uuid, p_now timestamptz) returns boolean
language sql stable
set search_path = ''
as $$
  select app.org_rest_day(p_org, t.local::date)
         or (t.local::time >= time '15:00' and app.short_work_day(p_org, t.local::date))
    from (select p_now at time zone coalesce((select app.intake_zone(o.timezone) from public.organizations o where o.id = p_org),
                                             'Asia/Jerusalem') as local) t;
$$;

-- Is today (its zone) a rest day of the business.
create or replace function app.intake_callback_rest_today(p_org uuid, p_now timestamptz) returns boolean
language sql stable
set search_path = ''
as $$
  select app.org_rest_day(p_org, (p_now at time zone coalesce((select app.intake_zone(o.timezone) from public.organizations o where o.id = p_org),
                                                              'Asia/Jerusalem'))::date);
$$;

-- What the hosted form offers: {now, closed_line, groups: [{label, options: [{value, label}]}]}.
-- closed_line: on a rest day, the line above the next working day's slots.
create or replace function app.intake_callback_offer(p_org uuid, p_slots_off text[], p_now timestamptz) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'now', app.intake_callback_now_open(p_org, p_now) and not app.intake_callback_closed_today(p_org, p_now),
    'closed_line', case when app.intake_callback_closed_today(p_org, p_now) then
      'היום אנחנו סגורים. מתי נוח שנחזור אליך ביום '
      || (array['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'])[
           extract(dow from (select max(left(o.value, 10))::date from app.intake_callback_options(p_org, p_slots_off, p_now) o))::int + 1]
      || '?' end,
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('label', g.day_label, 'options', g.options) order by g.first_start)
        from (select min(o.day_label) as day_label, min(o.starts_at) as first_start,
                     jsonb_agg(jsonb_build_object('value', o.value, 'label', o.slot_label) order by o.starts_at) as options
                from app.intake_callback_options(p_org, p_slots_off, p_now) o
               where o.allowed and not o.ended
               group by left(o.value, 10)) g), '[]'::jsonb));
$$;

-- A choice as a time and its words, or a refusal: not offered on this form
-- (22023 callback:invalid), or ended, of a day that has passed, or "now" outside
-- the hours (callback:past). A slot is booked on its own date or not at all.
create or replace function app.intake_callback_pick(p_org uuid, p_slots_off text[], p_choice text, p_now timestamptz,
                                                    out at timestamptz, out phrase text)
language plpgsql stable
set search_path = ''
as $$
declare
  v_option record;
  v_day date;
  v_today date;
begin
  if p_choice = 'now' then
    -- a rest day: "now" is not on the list
    if app.intake_callback_rest_today(p_org, p_now) then
      raise exception 'invalid callback time' using errcode = '22023', hint = 'callback:invalid';
    end if;
    -- outside the hours, or a short day from 15:00: the time has passed
    if not app.intake_callback_now_open(p_org, p_now) then
      raise exception 'callback time has passed' using errcode = '22023', hint = 'callback:past';
    end if;
    at := p_now;
    phrase := 'עכשיו';
    return;
  end if;
  if p_choice is null or p_choice !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-(09|12|15|18)$' then
    raise exception 'invalid callback time' using errcode = '22023', hint = 'callback:invalid';
  end if;
  begin
    v_day := to_date(left(p_choice, 10), 'YYYY-MM-DD');
  exception when others then
    v_day := null;
  end;
  if v_day is null or to_char(v_day, 'YYYY-MM-DD') <> left(p_choice, 10) then
    raise exception 'invalid callback time' using errcode = '22023', hint = 'callback:invalid';
  end if;
  select * into v_option from app.intake_callback_options(p_org, p_slots_off, p_now) o where o.value = p_choice;
  if v_option.value is null then
    -- a day that has passed in the business's zone (the page was made before midnight)
    select (p_now at time zone coalesce((select app.intake_zone(o.timezone) from public.organizations o where o.id = p_org),
                                        'Asia/Jerusalem'))::date into v_today;
    if v_day < v_today then
      raise exception 'callback time has passed' using errcode = '22023', hint = 'callback:past';
    end if;
    raise exception 'invalid callback time' using errcode = '22023', hint = 'callback:invalid';
  end if;
  if not v_option.allowed then
    raise exception 'invalid callback time' using errcode = '22023', hint = 'callback:invalid';
  end if;
  if v_option.ended then
    raise exception 'callback time has passed' using errcode = '22023', hint = 'callback:past';
  end if;
  at := greatest(v_option.starts_at, p_now);
  phrase := v_option.phrase;
end;
$$;

-- The call task of a call-back request (as app.intake_callback_task() of 0119,
-- with the words given). Runs inside public.intake_submit() (security definer).
-- The task's "assigned" notification is left out for an owner this request
-- already told about the lead or record (new-lead or repeat-inquiry
-- notification); it carries the time as body otherwise.
create or replace function app.intake_call_task(
  p_org uuid, p_owner uuid, p_lead uuid, p_contact uuid,
  p_is_now boolean, p_at timestamptz, p_phrase text, p_who text, p_form_name text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_task uuid;
  v_told boolean;
begin
  -- notifications of this request carry this transaction's now()
  v_told := p_owner is not null and exists (
    select 1 from public.notifications n
     where n.organization_id = p_org and n.user_id = p_owner and n.created_at = now()
       and n.type in ('lead_new', 'assigned', 'inquiry')
       and ((n.entity_type = 'lead' and n.entity_id = p_lead) or (n.entity_type = 'contact' and n.entity_id = p_contact)));
  perform set_config('app.intake_quiet_task', case when v_told then p_owner::text else '' end, true);

  insert into public.tasks (organization_id, title, description, task_type, due_at, remind_at, priority,
                            owner_id, lead_id, contact_id)
  values (p_org,
          left('שיחה חוזרת: ' || coalesce(nullif(btrim(p_who), ''), 'פנייה מטופס'), 300),
          left('ביקשו בטופס "' || coalesce(p_form_name, '') || '" שנחזור אליהם ' || p_phrase || '.', 2000),
          'call', p_at,
          -- a slot still ahead reminds at its start; "now" is due at once
          case when p_at > now() then p_at end,
          case when p_is_now then 1 else 2 end,
          p_owner, p_lead, p_contact)
  returning id into v_task;

  perform set_config('app.intake_quiet_task', '', true);

  update public.notifications n set body = 'ביקשו שנחזור אליהם ' || p_phrase
   where n.organization_id = p_org and n.entity_type = 'task' and n.entity_id = v_task and n.body is null;
  return v_task;
end;
$$;

revoke all on function app.hebrew_elapsed_days(integer) from public, anon, authenticated;
revoke all on function app.hebrew_new_year(integer) from public, anon, authenticated;
revoke all on function app.hebrew_month_lengths(integer) from public, anon, authenticated;
revoke all on function app.hebrew_date(date) from public, anon, authenticated;
revoke all on function app.israel_occasions(date) from public, anon, authenticated;
revoke all on function app.org_rest_day(uuid, date) from public, anon, authenticated;
revoke all on function app.intake_callback_options(uuid, text[], timestamptz) from public, anon, authenticated;
revoke all on function app.intake_callback_now_open(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.intake_callback_closed_today(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.intake_callback_rest_today(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.short_work_day(uuid, date) from public, anon, authenticated;
revoke all on function app.intake_callback_offer(uuid, text[], timestamptz) from public, anon, authenticated;
revoke all on function app.intake_callback_pick(uuid, text[], text, timestamptz) from public, anon, authenticated;
revoke all on function app.intake_call_task(uuid, uuid, uuid, uuid, boolean, timestamptz, text, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- notify_assignment: the body of 0024 plus the quiet call task, marked SPD-05
-- ----------------------------------------------------------------------------
create or replace function app.notify_assignment() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_title text := tg_argv[1];
begin
  if new.owner_id is null or new.owner_id is not distinct from auth.uid() then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.owner_id is not distinct from old.owner_id then
    return null;
  end if;
  -- an imported file is not "assigned to you" one record at a time
  if tg_op = 'INSERT' and to_jsonb(new) ->> 'import_job_id' is not null then
    return null;
  end if;
  -- neither is a handover of someone's records (one summary notification instead)
  if current_setting('app.bulk_transfer', true) = 'on' then
    return null;
  end if;
  -- SPD-05: the call task of a form's call-back request, for the person this
  -- request has just told about the lead (app.intake_call_task())
  if v_entity = 'task' and tg_op = 'INSERT' and new.owner_id::text = current_setting('app.intake_quiet_task', true) then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  values (new.organization_id, new.owner_id, 'assigned', v_title, v_entity, new.id);
  return null;
end;
$$;

-- ----------------------------------------------------------------------------
-- intake_form: the body of 0119 (callback_time); the call-back part now carries
-- the offer
-- ----------------------------------------------------------------------------
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
  v_whatsapp text;
  -- SPD-05
  v_callback jsonb;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
  end if;

  select coalesce(jsonb_agg(x.field order by x.ord), '[]'::jsonb) into v_fields
    from (
      select a.ord,
             jsonb_build_object(
               'key', a.item ->> 'key',
               'required', coalesce(a.item -> 'required' = 'true'::jsonb, false),
               'help', coalesce(nullif(btrim(a.item ->> 'help'), ''), d.help_text),
               'show_if', case when jsonb_typeof(a.item -> 'show_if') = 'object' then a.item -> 'show_if' end,
               'label', d.label,
               'type', d.field_type,
               'options', d.options) as field
        from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end)
               with ordinality as a(item, ord)
        left join public.field_definitions d
          on (a.item ->> 'key') like 'cf:%'
         and d.organization_id = v_form.organization_id
         and d.object_type = 'lead'
         and d.key = substr(a.item ->> 'key', 4)
         and d.is_active
         and d.field_type <> 'user'
       where (a.item ->> 'key') in ('full_name', 'phone', 'email', 'company_name', 'message')
          or d.id is not null
    ) x;

  -- FLD-04: only the logo's object name and the colour; nothing else of the organization
  select jsonb_build_object('logo', o.logo_path, 'color', o.brand_color) into v_brand
    from public.organizations o
   where o.id = v_form.organization_id;

  -- CAP-05: the WhatsApp number of the thank-you page, only when the form turns it on:
  -- the form's own number, else the business phone; only a valid E.164 number leaves
  if v_form.whatsapp_button then
    select app.normalize_phone(coalesce(nullif(btrim(v_form.whatsapp_phone), ''), o.phone)) into v_whatsapp
      from public.organizations o
     where o.id = v_form.organization_id;
    if v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
      v_whatsapp := null;
    end if;
  end if;

  -- SPD-05: the call-back choice: the business's time zone, whether "now" is
  -- offered, and the slots still open today and on the next working day
  if v_form.callback_choice then
    select jsonb_build_object('time_zone', app.intake_zone(o.timezone))
           || app.intake_callback_offer(v_form.organization_id, v_form.callback_slots_off, now())
      into v_callback
      from public.organizations o
     where o.id = v_form.organization_id;
  end if;

  return jsonb_build_object(
    'callback', v_callback,
    'title', coalesce(nullif(btrim(v_form.title), ''), v_form.name),
    'intro', v_form.intro,
    'submit_label', v_form.submit_label,
    'fields', v_fields,
    'brand', coalesce(v_brand, jsonb_build_object('logo', null, 'color', null)),
    'thanks', jsonb_build_object(
      'whatsapp', v_whatsapp,
      'whatsapp_text', case when v_whatsapp is not null then nullif(btrim(v_form.whatsapp_text), '') end));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;
grant execute on function public.intake_form(text) to service_role;

-- ----------------------------------------------------------------------------
-- intake_submit: the body of 0119 (callback_time); the choice is resolved by
-- app.intake_callback_pick() and the task made by app.intake_call_task()
-- ----------------------------------------------------------------------------
create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_phone_e164 text;
  -- matched lead (and the contact it became) or matched contact
  v_lead_match uuid;
  v_lead_owner uuid;
  v_lead_contact uuid;
  v_contact_match uuid;
  v_contact_owner uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
  -- CAP-02 / ADS-01: where the visit came from (cleaned, known keys only)
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  -- CAP-01: custom values as sent, and what is kept of them
  v_custom_in jsonb := case when jsonb_typeof(p_payload -> 'custom') = 'object' then p_payload -> 'custom' else '{}'::jsonb end;
  v_custom jsonb := '{}'::jsonb;
  -- values of the shown fields by form key, for the conditions of later fields
  v_values jsonb := '{}'::jsonb;
  v_shown text[] := '{}';
  v_value jsonb;
  v_cond jsonb;
  v_type text;
  v_options jsonb;
  -- SPD-05: when the person asked to be called back ('now' or a slot 'YYYY-MM-DD-HH', its business date and start hour)
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_phrase text;
  v_callback_note text;
  v_task_owner uuid;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam', coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  -- CAP-01: the form's fields in order. A hidden field loses its value and is
  -- never required; a shown custom field must hold a valid value.
  if v_form.kind = 'form' then
    for v_field in
      select a.value from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end) a
    loop
      continue when jsonb_typeof(v_field) <> 'object';
      v_key := v_field ->> 'key';
      continue when v_key is null or v_key = any (v_shown);
      v_type := null;
      v_options := null;
      if v_key like 'cf:%' then
        select d.field_type, d.options into v_type, v_options
          from public.field_definitions d
         where d.organization_id = v_form.organization_id and d.object_type = 'lead'
           and d.key = substr(v_key, 4) and d.is_active;
        -- a field that is gone, switched off or picks a team member is not on the form
        continue when v_type is null or v_type = 'user';
        v_value := v_custom_in -> substr(v_key, 4);
      elsif v_key = 'full_name' then v_value := to_jsonb(v_full_name);
      elsif v_key = 'phone' then v_value := to_jsonb(v_phone);
      elsif v_key = 'email' then v_value := to_jsonb(v_email);
      elsif v_key = 'company_name' then v_value := to_jsonb(v_company);
      elsif v_key = 'message' then v_value := to_jsonb(v_message);
      else
        continue;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;

      v_cond := v_field -> 'show_if';
      if jsonb_typeof(v_cond) = 'object'
         and not coalesce((v_cond ->> 'field') = any (v_shown)
                          and app.intake_condition_met(v_values -> (v_cond ->> 'field'), v_cond ->> 'value'), false) then
        -- hidden: whatever was sent for it is dropped
        if v_key = 'full_name' then v_full_name := null;
        elsif v_key = 'phone' then v_phone := null;
        elsif v_key = 'email' then v_email := null;
        elsif v_key = 'company_name' then v_company := null;
        elsif v_key = 'message' then v_message := null;
        end if;
        continue;
      end if;

      v_shown := v_shown || v_key;
      if v_type is not null and app.intake_has_value(v_value) then
        if not app.custom_value_ok(v_type, v_options, v_value) then
          raise exception 'invalid custom field: %', substr(v_key, 4) using errcode = '22023';
        end if;
        v_custom := v_custom || jsonb_build_object(substr(v_key, 4), v_value);
      end if;
      if app.intake_has_value(v_value) then
        v_values := v_values || jsonb_build_object(v_key, v_value);
      end if;
      if v_field -> 'required' = 'true'::jsonb and not app.intake_has_value(v_value) then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  -- (SPD-05 follow-ups: the slots this form offers now, app.intake_callback_pick())
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select p.at, p.phrase into v_callback_at, v_callback_phrase
      from app.intake_callback_pick(v_form.organization_id, v_form.callback_slots_off, v_callback, now()) p;
    v_callback_note := 'ביקשו שנחזור אליהם ' || v_callback_phrase;
  else
    v_callback := null;
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
    from public.leads l
   where l.organization_id = v_form.organization_id and l.deleted_at is null
     and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
          or (v_email is not null and lower(l.email) = v_email))
   order by l.created_at desc
   limit 1;
  if v_lead_match is null then
    -- CON-01: the contact's primary phone or email, or any of its other ones
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and c2.phone_e164 = v_phone_e164)
                 or (v_email is not null and lower(c2.email) = v_email))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and ch.value_e164 = v_phone_e164)
                 or (v_email is not null and ch.kind = 'email' and ch.value = v_email)))
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead_match is not null or v_contact_match is not null then
    -- first touch wins: the lead keeps its attribution and custom fields;
    -- this visit's are kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end);
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      -- SPD-05: the requested call-back time, when there is one, in the body
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים', v_callback_note,
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    -- SPD-05: a call task for the record's owner, else the form's owner
    if v_callback_at is not null then
      -- the record's owner while an active member who is not a viewer, else the form's owner, same check
      select m.user_id into v_task_owner from public.memberships m
       where m.organization_id = v_form.organization_id and m.user_id = v_owner
         and m.status = 'active' and m.role <> 'viewer';
      if v_task_owner is null then
        select m.user_id into v_task_owner from public.memberships m
         where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
           and m.status = 'active' and m.role <> 'viewer';
      end if;
      perform app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                   coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                   v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  select s.id into v_status from public.lead_statuses s
   where s.organization_id = v_form.organization_id and s.kind = 'open'
   order by s.is_default desc, s.position
   limit 1;
  if v_status is null then
    raise exception 'the organization has no open lead status' using errcode = 'P0001';
  end if;

  if v_form.assign_mode = 'round_robin' then
    v_owner := app.next_lead_owner(v_form.organization_id, v_form.team_id);
  end if;
  if v_owner is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
  end if;

  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_form.team_id,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content',
            -- CAP-02: the extra parameters of the closed list, in one place
            'extra', v_attr -> 'extra')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid',
          v_custom)
  returning id into v_lead;

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    perform app.intake_call_task(v_form.organization_id, v_owner, v_lead, null, v_callback = 'now', v_callback_at,
                                 v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    update public.notifications n set body = v_callback_note
     where n.organization_id = v_form.organization_id and n.entity_type = 'lead' and n.entity_id = v_lead
       and n.body is null;
  end if;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;

revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;
