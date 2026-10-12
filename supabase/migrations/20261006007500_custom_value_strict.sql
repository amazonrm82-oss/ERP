-- =============================================================================
-- Custom field values: rating and user checked as strictly as the app (RVW-14)
-- =============================================================================
-- values.ts accepts a rating only as a whole number from 1 to 5, and a "user"
-- field only as one of the business's members; the database accepted any number
-- and any uuid, so a direct API write could store "99 of 5" or a stranger's id.
-- * app.custom_value_ok(): rating must be an integer 1..5 (3.0 counts as 3).
--   Otherwise identical to the definition of migration 0064 (CON-04 il_id /
--   il_company_id check digits, the 254-character email cap).
-- * app.check_custom_fields(): a changed "user" value must be the user id of a
--   membership in the record's organization (any status, as the app offers).
--   custom_value_ok() has no organization argument and is also used by lead
--   conversion and the form intake (where "user" fields are left out), so the
--   check lives in the trigger. Otherwise identical to migration 0026.
-- As before only values a browser session adds or changes are checked; values
-- stored earlier stay until someone edits them, and lead conversion leaves an
-- invalid rating out instead of copying it (app.carry_custom_fields).
-- Every statement is safe to run twice.

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
    when 'long_text' then
      return char_length(v_text) <= 5000;
    when 'select' then
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

create or replace function app.check_custom_fields() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_object text := tg_argv[0];
  v_old jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_type text;
  v_options jsonb;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.custom_fields is not distinct from old.custom_fields then
      return new;
    end if;
    v_old := coalesce(old.custom_fields, '{}'::jsonb);
  end if;

  for v_key, v_value in select e.key, e.value from jsonb_each(new.custom_fields) e loop
    continue when v_old -> v_key is not distinct from v_value;
    select f.field_type, f.options into v_type, v_options
      from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = v_object and f.key = v_key;
    if v_type is null then
      raise exception 'unknown custom field %', v_key using errcode = 'P0001', hint = 'custom_field:invalid';
    end if;
    if not app.custom_value_ok(v_type, v_options, v_value) then
      raise exception 'invalid value for custom field %', v_key using errcode = 'P0001', hint = 'custom_field:invalid';
    end if;
    -- a "user" field holds a member of the record's organization (RVW-14); the app offers every
    -- membership, a deactivated one included. custom_value_ok has no organization, so it is checked here,
    -- with the caller's rights (members read their organization's memberships). The value is a uuid by now.
    if v_type = 'user' and jsonb_typeof(v_value) = 'string' and not exists (
      select 1 from public.memberships m
       where m.organization_id = new.organization_id and m.user_id = (v_value #>> '{}')::uuid
    ) then
      raise exception 'invalid value for custom field %', v_key using errcode = 'P0001', hint = 'custom_field:invalid';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function app.check_custom_fields() from public, anon, authenticated;
