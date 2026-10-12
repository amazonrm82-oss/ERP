-- =============================================================================
-- Check digit of Israeli ID and company numbers (CON-04)
-- =============================================================================
-- An Israeli ID number (ת"ז) and a company or dealer number (ח.פ., ע.מ.) are 9
-- digits whose last digit is a check digit (shorter numbers are padded with
-- leading zeros). The app checks them in every form (src/lib/israeli-id.ts);
-- the database now checks them too:
-- * app.valid_israeli_id(text): immutable; true for 5 to 9 digits (no spaces or
--   dashes) whose check digit is right after padding to 9, and not all zeros. Mirrors
--   israeliIdNumber() in src/lib/israeli-id.ts.
-- * Custom fields of type il_id / il_company_id: app.custom_value_ok() now asks
--   app.valid_israeli_id() instead of only a length. As before, only values a
--   browser session adds or changes are checked (check_custom_fields), so values
--   stored earlier stay until someone edits them; lead conversion leaves out an
--   invalid one instead of copying it (app.carry_custom_fields).
-- * companies.tax_id: trigger companies_tax_id_check. When a browser session
--   (authenticated / anon) sets or changes a company's number, it must be valid
--   (hint 'tax_id:invalid'); it is stored as 9 digits. A company outside Israel
--   (country <> 'IL') is not checked. This is a trigger and not a CHECK
--   constraint on purpose: a constraint, even NOT VALID, is checked again on
--   every later update of the row, so a company saved before this migration with
--   a number that does not pass would block unrelated changes to it (handover of
--   records, recycle bin, owner changes by automations). The trigger checks only
--   a number that is being written. Server writes (merge, imports' lookups,
--   security definer functions) are trusted, as with custom fields.
-- Every statement is safe to run twice.

create or replace function app.valid_israeli_id(p_value text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_padded text;
  v_sum integer := 0;
  v_step integer;
begin
  if p_value is null or p_value !~ '^[0-9]{5,9}$' then
    return false;
  end if;
  v_padded := lpad(p_value, 9, '0');
  -- all zeros passes the check digit but is never a real number
  if v_padded = '000000000' then
    return false;
  end if;
  for i in 1..9 loop
    v_step := substr(v_padded, i, 1)::integer * (case when i % 2 = 1 then 1 else 2 end);
    v_sum := v_sum + (case when v_step > 9 then v_step - 9 else v_step end);
  end loop;
  return v_sum % 10 = 0;
end;
$$;

revoke all on function app.valid_israeli_id(text) from public, anon;
grant execute on function app.valid_israeli_id(text) to authenticated, service_role;

-- Same as migration 0026, except il_id / il_company_id.
create or replace function app.custom_value_ok(p_type text, p_options jsonb, p_value jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_text text;
  v_item jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return true;
  end if;
  if p_type in ('number', 'currency', 'percent', 'rating') then
    return jsonb_typeof(p_value) = 'number';
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

-- ----------------------------------------------------------------------------
-- companies.tax_id
-- ----------------------------------------------------------------------------
create or replace function app.check_company_tax_id() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user not in ('authenticated', 'anon') or new.tax_id is null or new.country is distinct from 'IL' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.tax_id is not distinct from old.tax_id and new.country is not distinct from old.country then
    return new;
  end if;
  if not app.valid_israeli_id(new.tax_id) then
    raise exception 'invalid company number' using errcode = 'P0001', hint = 'tax_id:invalid';
  end if;
  new.tax_id := lpad(new.tax_id, 9, '0');
  return new;
end;
$$;
revoke all on function app.check_company_tax_id() from public, anon, authenticated;

create or replace trigger companies_tax_id_check before insert or update of tax_id, country on public.companies
  for each row execute function app.check_company_tax_id();
