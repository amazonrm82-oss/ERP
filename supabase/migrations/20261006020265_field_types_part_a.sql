-- =============================================================================
-- FLD-06 part A: three new custom field types
-- =============================================================================
-- * rich_text: REC-04's cleaned Markdown (bold, lists, links to http(s)/mailto/tel), up to 5,000
--   characters. Stored as text; the app renders it as React elements and never as HTML.
-- * duration: whole minutes, 0 to 525,600 (a year), shown as hours and minutes.
-- * status: one choice from the field's options, like select, each option with a colour from the
--   design system's palette keys (field_definitions.option_colors, {option: key}; a missing key
--   shows neutral).
-- app.custom_value_ok() mirrors parseCustomFields() in src/features/custom-fields/values.ts (test 42
-- and the field type tests). Every other place that switches on field_type made its choice for the
-- new types (src/features/custom-fields/type-decisions.ts, unit test field-type-switches): the
-- database lists of FLD-07 unique types, FLD-09 "equals" controllers, LEAD-05 score operators and
-- CAP-08 routing fields stay as they are, so the new types are left out of them on purpose (only
-- "filled" / "empty" conditions and score rules; never unique; not a routing field).
-- New fields count against the existing max_custom_fields_per_object quota; no new plan key.
-- Every statement is safe to run twice.

alter table public.field_definitions drop constraint if exists field_definitions_field_type_check;
alter table public.field_definitions add constraint field_definitions_field_type_check check (field_type in (
  'text', 'long_text', 'number', 'currency', 'percent', 'rating',
  'select', 'multi_select', 'checkbox', 'date', 'datetime',
  'phone', 'email', 'url', 'il_id', 'il_company_id', 'user',
  'rich_text', 'duration', 'status'));

-- FLD-06: the colour of each option of a status field, by palette key (src/features/custom-fields/status-colors.ts)
alter table public.field_definitions add column if not exists option_colors jsonb not null default '{}'::jsonb;

-- Whether option_colors fits the field: empty for every type but status; for status, keys among the
-- options and values among the palette keys. Pure, so it can back a check constraint.
create or replace function app.field_option_colors_ok(p_type text, p_options jsonb, p_colors jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_colors is null or jsonb_typeof(p_colors) <> 'object' then false
    when p_type is distinct from 'status' then p_colors = '{}'::jsonb
    else not exists (
      select 1 from jsonb_each(p_colors) e
       where not (coalesce(p_options, '[]'::jsonb) @> jsonb_build_array(e.key))
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') not in ('accent', 'success', 'warning', 'danger', 'neutral'))
  end
$$;
revoke all on function app.field_option_colors_ok(text, jsonb, jsonb) from public, anon;
grant execute on function app.field_option_colors_ok(text, jsonb, jsonb) to authenticated, service_role;

alter table public.field_definitions drop constraint if exists field_definitions_option_colors_check;
alter table public.field_definitions add constraint field_definitions_option_colors_check
  check (app.field_option_colors_ok(field_type, options, option_colors));

-- 0075's check, plus the three new types
create or replace function app.custom_value_ok(p_type text, p_options jsonb, p_value jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_text text;
  v_item jsonb;
  v_number numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return true;
  end if;
  if p_type in ('number', 'currency', 'percent') then
    return jsonb_typeof(p_value) = 'number';
  end if;
  if p_type = 'duration' then
    -- FLD-06: whole minutes, from 0 to a year (values.ts MAX_DURATION_MINUTES)
    if jsonb_typeof(p_value) <> 'number' then
      return false;
    end if;
    v_number := (p_value #>> '{}')::numeric;
    return v_number between 0 and 525600 and v_number = trunc(v_number);
  end if;
  if p_type = 'rating' then
    -- a whole number from 1 to 5, as values.ts (RVW-14)
    if jsonb_typeof(p_value) <> 'number' then
      return false;
    end if;
    v_number := (p_value #>> '{}')::numeric;
    return v_number between 1 and 5 and v_number = trunc(v_number);
  end if;
  if p_type = 'checkbox' then
    return jsonb_typeof(p_value) = 'boolean';
  end if;
  if p_type = 'multi_select' then
    if jsonb_typeof(p_value) <> 'array' then
      return false;
    end if;
    for v_item in select a.value from jsonb_array_elements(p_value) a loop
      if jsonb_typeof(v_item) <> 'string' or not coalesce(p_options, '[]'::jsonb) @> jsonb_build_array(v_item) then
        return false;
      end if;
    end loop;
    return true;
  end if;

  if jsonb_typeof(p_value) <> 'string' then
    return false;
  end if;
  v_text := p_value #>> '{}';
  case p_type
    when 'long_text', 'rich_text' then
      -- rich_text (FLD-06): REC-04's cleaned Markdown, as typed; rendered as React elements, never as HTML
      return char_length(v_text) <= 5000;
    when 'select', 'status' then
      return coalesce(p_options, '[]'::jsonb) @> jsonb_build_array(v_text);
    when 'email' then
      return char_length(v_text) <= 254 and v_text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
    when 'phone' then
      return v_text ~ '^\+?[0-9[:space:]().*-]{3,24}$';
    when 'url' then
      return char_length(v_text) <= 2000 and v_text ~* '^https?://[^[:space:]/]+\.[^[:space:]]+$';
    when 'date' then
      if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
        return false;
      end if;
      begin
        return to_char(v_text::date, 'YYYY-MM-DD') = v_text;
      exception when others then
        return false;
      end;
    when 'datetime' then
      if char_length(v_text) > 40 then
        return false;
      end if;
      begin
        perform v_text::timestamptz;
        return true;
      exception when others then
        return false;
      end;
    when 'user' then
      return v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    when 'il_id', 'il_company_id' then
      return app.valid_israeli_id(v_text);
    else
      -- text
      return char_length(v_text) <= 500;
  end case;
end;
$$;

revoke all on function app.custom_value_ok(text, jsonb, jsonb) from public, anon;
grant execute on function app.custom_value_ok(text, jsonb, jsonb) to authenticated;
