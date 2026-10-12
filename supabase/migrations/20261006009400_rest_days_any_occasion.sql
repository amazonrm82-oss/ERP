-- =============================================================================
-- 0094 Any occasion can be a rest day (CAL-03, owner's answers 12 October 2026)
-- =============================================================================
-- "A business may choose any occasion from the list as a rest day, including
-- chol hamoed, Mimouna and Purim. All off by default." Until now the only
-- choices were two groups (holidays by law, their eves), so the choice of
-- single occasions needs a place:
--   org_calendar_settings.rest_occasions  the keys of the occasions the business
--   does not work on, besides the groups (default none). The keys are the
--   app's (OCCASIONS in src/features/calendar-days/holidays.ts, where the dates
--   are computed); the database checks only their shape and number, the app
--   drops a key it does not know.
-- The other answers need no change here: Yom HaZikaron as an eve is a mark in
-- the app, and a business with no rest day at all was already allowed
-- (rest_weekdays may be empty; at most six days, so a business works at least
-- one weekday).
-- Owners and admins write it like the other columns (policies unchanged);
-- the column grants gain the new column. Audited by the existing trigger.
-- Every statement is safe to run twice.

alter table public.org_calendar_settings
  add column if not exists rest_occasions text[] not null default '{}'
    constraint org_calendar_settings_rest_occasions_check
    check (cardinality(rest_occasions) <= 60
           and array_position(rest_occasions, null) is null
           and array_position(rest_occasions, '') is null
           and array_to_string(rest_occasions, ',') ~ '^([a-z0-9_]{1,40}(,[a-z0-9_]{1,40})*)?$');

grant insert (rest_occasions), update (rest_occasions) on public.org_calendar_settings to authenticated;
