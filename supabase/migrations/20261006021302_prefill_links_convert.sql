-- =============================================================================
-- Owner (401) א, 17 November 2026 (RVW-108, BIZ-05): a converted lead's prefill links move to its contact
-- =============================================================================
-- app.prefill_record_live counted a lead as live only while unconverted, so a prefill link sent to a lead answered "not
-- found" from the moment the lead was converted. Now, as LIB-02's library links (021268, leads_library_links_convert):
-- * trigger leads_prefill_links_convert (app.convert_prefill_links, definer, no grants), after converted_at /
--   converted_contact_id are set: every link of the lead moves to the contact the conversion made (lead_id cleared and
--   contact_id set in one update, so prefill_links_one_record holds). The link keeps its token, expiry, submission state and
--   its copied field list. The page and the submit already judge a link by the record it names
--   (app.prefill_record_live / app.prefill_link_usable take a contact link while the contact is live, unchanged), and they
--   judge every copied key against the CONTACT's fields (app.prefill_field_problem with record type 'contact', unchanged):
--   a lead-only key (full_name, company_name, a custom field the contacts do not have) is not shown and not accepted, the
--   existing rule for a key no longer allowed; keys both types have (phone, email, job_title, a custom field of the same key
--   and type on contacts, see below) keep working. Links of leads converted before this migration stay on the lead (no backfill: a bulk rewrite
--   of rows needs the owner's go-ahead).
-- * app.prefill_link_fields (021264's body; review): a moved link (its template's record type is not the record's) keeps
--   a copied custom key only while the contact's field of that key has the SAME TYPE as the lead field it was copied from;
--   a key the two types share with different types is another field: left out of the page, and so refused by the submit
--   (which accepts only the keys this function answers). A lead field deleted since = left out (fail closed).
-- * app.merge_prefill_links (021265's body): a lead merge sends the duplicate's links to the kept lead, and on to its contact
--   when the kept lead is converted (app.merge_library_links' branch, 021268).
-- Safe to run twice. No drop statement, no delete.

create or replace function app.convert_prefill_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.converted_at is null or new.converted_contact_id is null then
    return null;
  end if;
  update app.prefill_links l set contact_id = new.converted_contact_id, lead_id = null
   where l.organization_id = new.organization_id and l.lead_id = new.id;
  return null;
end;
$$;
revoke all on function app.convert_prefill_links() from public, anon, authenticated, service_role;

create or replace trigger leads_prefill_links_convert
  after update of converted_at, converted_contact_id on public.leads
  for each row
  when (new.converted_at is not null and new.converted_contact_id is not null)
  execute function app.convert_prefill_links();

-- app.merge_prefill_links: 021265's body plus the converted kept lead's branch
create or replace function app.merge_prefill_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_contact uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.lead_id is not null and v_merged <> new.lead_id then
    select l.converted_contact_id into v_contact
      from public.leads l
     where l.organization_id = new.organization_id and l.id = new.lead_id and l.converted_at is not null;
    if v_contact is not null then
      update app.prefill_links l set contact_id = v_contact, lead_id = null
       where l.organization_id = new.organization_id and l.lead_id = v_merged;
    else
      update app.prefill_links l set lead_id = new.lead_id
       where l.organization_id = new.organization_id and l.lead_id = v_merged;
    end if;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update app.prefill_links l set contact_id = new.contact_id
     where l.organization_id = new.organization_id and l.contact_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_prefill_links() from public, anon, authenticated, service_role;

-- app.prefill_link_fields: 021264's body plus the type rule for a moved link
create or replace function app.prefill_link_fields(p_link app.prefill_links) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.prefill_forms;
  v_type text := case when p_link.lead_id is not null then 'lead' else 'contact' end;
  v_row jsonb;
  v_custom jsonb;
  v_key text;
  v_def public.field_definitions;
  v_value jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  select * into v_form from public.prefill_forms f where f.organization_id = p_link.organization_id and f.id = p_link.prefill_form_id;
  if p_link.lead_id is not null then
    select to_jsonb(r) into v_row from public.leads r where r.organization_id = p_link.organization_id and r.id = p_link.lead_id;
  else
    select to_jsonb(r) into v_row from public.contacts r where r.organization_id = p_link.organization_id and r.id = p_link.contact_id;
  end if;
  v_custom := case when jsonb_typeof(v_row -> 'custom_fields') = 'object' then v_row -> 'custom_fields' else '{}'::jsonb end;
  -- the link's copy of the fields, in its order, only those still on the template and still allowed
  foreach v_key in array coalesce(p_link.fields, array[]::text[]) loop
    continue when not (v_key = any (coalesce(v_form.fields, array[]::text[])));
    continue when app.prefill_field_problem(p_link.organization_id, v_type, v_key) is not null;
    -- owner (401) א review: a link moved from a converted lead keeps a custom key only while the contact's field of that key
    -- has the type of the lead field it was copied from (else it is another field that shares the key: left out, so the
    -- submit refuses it too); built-in keys keep the rule above
    if v_key like 'cf:%' and v_form.record_type is distinct from v_type
       and not exists (select 1 from public.field_definitions ld
                         join public.field_definitions cd
                           on cd.organization_id = ld.organization_id and cd.object_type = v_type and cd.key = ld.key
                        where ld.organization_id = p_link.organization_id and ld.object_type = v_form.record_type
                          and ld.key = substr(v_key, 4) and ld.field_type = cd.field_type) then
      continue;
    end if;
    if v_key like 'cf:%' then
      select * into v_def from public.field_definitions d
       where d.organization_id = p_link.organization_id and d.object_type = v_type and d.key = substr(v_key, 4);
      v_value := v_custom -> v_def.key;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', v_key,
        'label', v_def.label,
        'type', v_def.field_type,
        'options', case when jsonb_typeof(v_def.options) = 'array' then v_def.options else '[]'::jsonb end,
        'help', v_def.help_text,
        'required', v_def.is_required,
        'read_only', v_def.is_read_only and v_value is not null,
        'value', v_value));
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', v_key,
        'label', app.prefill_builtin_label(v_key),
        'type', app.prefill_builtin_type(v_key),
        'options', '[]'::jsonb,
        'help', null,
        'required', false,
        -- the email and phone are filled only when the record holds none (review of 13 November 2026)
        'read_only', v_key in ('email', 'phone') and coalesce(btrim(v_row ->> v_key), '') <> '',
        'value', case when v_row ->> v_key is null or btrim(v_row ->> v_key) = '' then null else to_jsonb(v_row ->> v_key) end));
    end if;
  end loop;
  return v_out;
end;
$$;
revoke all on function app.prefill_link_fields(app.prefill_links) from public, anon, authenticated, service_role;
