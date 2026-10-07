-- 20261006002600_custom_field_checks: part 2 of 2. Run the parts in order.
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
