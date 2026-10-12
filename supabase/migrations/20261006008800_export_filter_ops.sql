-- =============================================================================
-- RVW-4 (follow-up): a list export keeps a filter value only when it fits its
-- operator
-- =============================================================================
-- 0085 kept a value of an advanced filter by its shape alone (an id, a number,
-- a date or a lowercase code word), whatever the operator. So a run of digits
-- or a lowercase latin word typed under the wrong operator was still logged:
-- {op: "gt", value: "0501234567"}, {op: "last_days", value: "password_123"},
-- {field: "status", op: "is", value: "johnsmith"}.
--
-- app.export_filter_value() now checks the value against what its operator
-- takes (the operators of src/features/list-filters/model.ts):
-- * last_days / older_than_days / idle_days: a number of days, 1 to 4 digits;
-- * on_or_after / before: a date (yyyy-mm-dd);
-- * gt / lt: a number of at most 8 digits, no leading zero, up to 4 decimals
--   (an amount, a percent, a rating; a phone or an id number does not fit);
-- * is / is_not / has / has_not: an id, 'me', or one of the fixed values of the
--   built-in plain choice fields (deal and task status, task type, task
--   priority, company industry; app.export_choice_values()). A custom select
--   option is text the business typed and becomes true. An array is kept only
--   when every element fits.
-- * contains / not_contains / equals (typed text) and every other or unknown
--   operator, including those that take no value: true.
-- Still never raises. Existing export entries are not rewritten.
-- The app now sends only the conditions the list actually applied
-- (appliedFilter() in src/features/list-filters/server.ts) and the parsed sort
-- key, so this is the second line.
-- Every statement is safe to run twice.

-- the fixed values of the built-in plain choice fields; mirrored from
-- filterFields() (src/features/list-filters/server.ts), checked by
-- tests/unit/export-filter-values.test.ts
create or replace function app.export_choice_values() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- deal status, task status
    'open', 'won', 'lost', 'done', 'cancelled',
    -- task type
    'todo', 'call', 'meeting', 'follow_up',
    -- task priority
    '1', '2', '3',
    -- company industry
    'services', 'real_estate', 'insurance_finance', 'construction', 'retail', 'health',
    'education', 'marketing', 'technology', 'tourism_events', 'nonprofit', 'other'
  ];
$$;

-- one value (text) fits the operator
create or replace function app.export_op_value_ok(p_text text, p_op text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(case
    when p_op in ('last_days', 'older_than_days', 'idle_days') then p_text ~ '^\d{1,4}$'
    when p_op in ('on_or_after', 'before') then p_text ~ '^\d{4}-\d{2}-\d{2}$'
    when p_op in ('gt', 'lt') then p_text ~ '^-?(0|[1-9]\d{0,7})(\.\d{1,4})?$'
    when p_op in ('is', 'is_not', 'has', 'has_not') then
      p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_text = 'me'
      or p_text = any (app.export_choice_values())
    else false
  end, false);
$$;

create or replace function app.export_filter_value(p_value jsonb, p_op text) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then null
    when jsonb_typeof(p_value) = 'string' and app.export_op_value_ok(p_value #>> '{}', p_op) then p_value
    -- several choices: only for the choice operators, and only when every one fits
    when jsonb_typeof(p_value) = 'array' and p_op in ('is', 'is_not', 'has', 'has_not') then
      case when jsonb_array_length(p_value) between 1 and 20
                and not exists (select 1 from jsonb_array_elements(p_value) as v
                                 where jsonb_typeof(v) is distinct from 'string' or not app.export_op_value_ok(v #>> '{}', p_op))
           then p_value else 'true'::jsonb end
    else 'true'::jsonb
  end;
$$;

revoke all on function app.export_choice_values() from public, anon, authenticated;
revoke all on function app.export_op_value_ok(text, text) from public, anon, authenticated;
revoke all on function app.export_filter_value(jsonb, text) from public, anon, authenticated;
