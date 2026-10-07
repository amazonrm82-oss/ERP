-- =============================================================================
-- 0029 A lead's custom fields follow it when it is converted
-- =============================================================================
-- When a lead is converted (converted_at set for the first time), each of its
-- custom field values is copied to the new contact and deal when they have a
-- field with the same label (spaces and case ignored) and the same type, and the
-- value fits that field (app.custom_value_ok: a select needs the same option).
-- What the contact or deal already holds is kept. Runs as a trigger, so
-- public.convert_lead() itself is unchanged.
-- Every statement is safe to run twice.

create or replace function app.carry_custom_fields(p_org uuid, p_from jsonb, p_type text) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(t.key, v.value), '{}'::jsonb)
    from jsonb_each(p_from) v
    join public.field_definitions s
      on s.organization_id = p_org and s.object_type = 'lead' and s.key = v.key
    join lateral (
      select d.key, d.field_type, d.options from public.field_definitions d
       where d.organization_id = p_org and d.object_type = p_type and d.is_active
         and lower(btrim(d.label)) = lower(btrim(s.label)) and d.field_type = s.field_type
       order by d.position, d.created_at
       limit 1
    ) t on true
   where jsonb_typeof(v.value) <> 'null' and app.custom_value_ok(t.field_type, t.options, v.value);
$$;

create or replace function app.convert_custom_fields() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.converted_at is not null or new.converted_at is null or new.custom_fields = '{}'::jsonb then
    return null;
  end if;
  if new.converted_contact_id is not null then
    update public.contacts c
       set custom_fields = app.carry_custom_fields(new.organization_id, new.custom_fields, 'contact') || c.custom_fields
     where c.organization_id = new.organization_id and c.id = new.converted_contact_id;
  end if;
  if new.converted_deal_id is not null then
    update public.deals d
       set custom_fields = app.carry_custom_fields(new.organization_id, new.custom_fields, 'deal') || d.custom_fields
     where d.organization_id = new.organization_id and d.id = new.converted_deal_id;
  end if;
  return null;
end;
$$;

revoke all on function app.carry_custom_fields(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function app.convert_custom_fields() from public, anon, authenticated;

drop trigger if exists leads_convert_custom_fields on public.leads;
create trigger leads_convert_custom_fields after update of converted_at on public.leads
  for each row execute function app.convert_custom_fields();
