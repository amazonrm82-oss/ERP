-- =============================================================================
-- 0026 Custom field values checked in the database
-- =============================================================================
-- custom_fields of leads, contacts, companies and deals were checked only by
-- the app's forms. Now a trigger checks each value a browser session
-- (authenticated / anon) adds or changes: the key must be a field defined for
-- that organization and record type (hidden ones too), and the value must match
-- the field's type (text length, number, true/false, date, email, phone, link,
-- select options; null is fine). Unchanged values are not checked again.
-- "Required" stays app-only (intake, imports, older records). Server writes
-- (security definer functions, service role) are trusted; current_user tells
-- them apart, so the trigger is security invoker. Error: P0001, hint
-- 'custom_field:invalid'. Every statement is safe to run twice.

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
    else
      -- text, il_id, il_company_id
      return char_length(v_text) <= 500;
  end case;
end;
$$;

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
  end loop;
  return new;
end;
$$;

revoke all on function app.custom_value_ok(text, jsonb, jsonb) from public, anon;
grant execute on function app.custom_value_ok(text, jsonb, jsonb) to authenticated;
revoke all on function app.check_custom_fields() from public, anon, authenticated;

drop trigger if exists leads_custom_fields_check on public.leads;
create trigger leads_custom_fields_check before insert or update of custom_fields on public.leads
  for each row execute function app.check_custom_fields('lead');
drop trigger if exists contacts_custom_fields_check on public.contacts;
create trigger contacts_custom_fields_check before insert or update of custom_fields on public.contacts
  for each row execute function app.check_custom_fields('contact');
drop trigger if exists companies_custom_fields_check on public.companies;
create trigger companies_custom_fields_check before insert or update of custom_fields on public.companies
  for each row execute function app.check_custom_fields('company');
drop trigger if exists deals_custom_fields_check on public.deals;
create trigger deals_custom_fields_check before insert or update of custom_fields on public.deals
  for each row execute function app.check_custom_fields('deal');
