-- =============================================================================
-- 0020 Merging duplicates
-- =============================================================================
-- public.merge_records(org, type, keep, merge, picks): two leads, contacts or
-- companies become one.
-- * picks: { "<column>": "merge" } takes that field from the duplicate; every other
--   field stays as it is on the kept record. Only the listed columns can be picked.
-- * Tags are joined; custom fields are joined, the kept record's values win.
-- * Everything that pointed at the duplicate moves to the kept record: timeline,
--   tasks, files, notifications, deals, deal participants, contacts of a company,
--   lead form submissions and conversion links.
-- * The duplicate is then deleted for good (it is in the audit log in full), and
--   a timeline entry on the kept record says what was merged.
-- * Allowed to whoever may edit the kept record and delete the duplicate
--   (team managers and admins), in a writable organization.
-- Every statement is safe to run twice.

create or replace function app.merge_columns(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['full_name', 'email', 'phone', 'company_name', 'job_title', 'status_id', 'source_id',
                           'campaign', 'message', 'budget_agorot', 'owner_id']
    when 'contact' then array['first_name', 'last_name', 'email', 'phone', 'job_title', 'company_id', 'source_id',
                              'address_line', 'city', 'birth_date', 'owner_id']
    when 'company' then array['name', 'tax_id', 'industry', 'website', 'email', 'phone', 'address_line', 'city', 'owner_id']
  end;
$$;

-- moves every reference from one record to another (same organization, same type)
create or replace function app.merge_move_links(p_org uuid, p_type text, p_keep uuid, p_merge uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_col text := p_type || '_id';
begin
  execute format('update public.activities set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.tasks set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.files set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  update public.notifications set entity_id = p_keep where organization_id = p_org and entity_id = p_merge;

  if p_type = 'lead' then
    update public.form_submissions set lead_id = p_keep where organization_id = p_org and lead_id = p_merge;
  elsif p_type = 'contact' then
    update public.deals set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
    insert into public.deal_contacts (organization_id, deal_id, contact_id, role)
      select organization_id, deal_id, p_keep, role from public.deal_contacts where organization_id = p_org and contact_id = p_merge
      on conflict do nothing;
    delete from public.deal_contacts where organization_id = p_org and contact_id = p_merge;
    update public.leads set converted_contact_id = p_keep where organization_id = p_org and converted_contact_id = p_merge;
  elsif p_type = 'company' then
    update public.contacts set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.deals set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.leads set converted_company_id = p_keep where organization_id = p_org and converted_company_id = p_merge;
    update public.companies set parent_company_id = case when id = p_keep then null else p_keep end
     where organization_id = p_org and parent_company_id = p_merge;
  end if;
end;
$$;

create or replace function public.merge_records(p_org uuid, p_type text, p_keep uuid, p_merge uuid, p_picks jsonb default '{}'::jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_table   text;
  v_keep    jsonb;
  v_merge   jsonb;
  v_allowed text[] := app.merge_columns(p_type);
  v_col     text;
  v_name    text;
begin
  if v_allowed is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  if p_keep = p_merge then
    raise exception 'a record cannot be merged with itself' using errcode = '22023';
  end if;
  v_table := case p_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end;
  execute format('select to_jsonb(t) from public.%I t where organization_id = $1 and id = $2 and deleted_at is null', v_table)
    into v_keep using p_org, p_keep;
  execute format('select to_jsonb(t) from public.%I t where organization_id = $1 and id = $2 and deleted_at is null', v_table)
    into v_merge using p_org, p_merge;
  if v_keep is null or v_merge is null
     or not app.org_writable(p_org)
     or not app.can_edit_record(p_org, (v_keep ->> 'owner_id')::uuid, (v_keep ->> 'team_id')::uuid)
     or not app.can_delete_record(p_org, (v_merge ->> 'owner_id')::uuid, (v_merge ->> 'team_id')::uuid) then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;
  if p_type = 'lead' and v_keep ->> 'converted_at' is not null and v_merge ->> 'converted_at' is not null then
    raise exception 'both leads were converted' using errcode = 'P0001', hint = 'merge:both_converted';
  end if;

  -- the fields picked from the duplicate (an owner comes with their team)
  for v_col in select key from jsonb_each_text(coalesce(p_picks, '{}'::jsonb)) where value = 'merge' loop
    if not v_col = any (v_allowed) then
      raise exception 'field % cannot be merged', v_col using errcode = '22023';
    end if;
    execute format('update public.%1$I k set %2$I = m.%2$I from public.%1$I m where k.id = $1 and m.id = $2', v_table, v_col)
      using p_keep, p_merge;
    if v_col = 'owner_id' then
      execute format('update public.%1$I k set team_id = m.team_id from public.%1$I m where k.id = $1 and m.id = $2', v_table)
        using p_keep, p_merge;
    end if;
  end loop;

  -- tags joined; custom fields joined, the kept record's values winning
  execute format(
    'update public.%1$I k set tag_ids = array(select distinct unnest(k.tag_ids || m.tag_ids)),
                             custom_fields = m.custom_fields || k.custom_fields
       from public.%1$I m where k.id = $1 and m.id = $2', v_table)
    using p_keep, p_merge;

  -- a converted duplicate passes its conversion to the kept lead
  if p_type = 'lead' and v_merge ->> 'converted_at' is not null then
    update public.leads k
       set converted_at = m.converted_at, converted_contact_id = m.converted_contact_id,
           converted_company_id = m.converted_company_id, converted_deal_id = m.converted_deal_id, status_id = m.status_id
      from public.leads m where k.id = p_keep and m.id = p_merge;
  end if;

  perform app.merge_move_links(p_org, p_type, p_keep, p_merge);

  v_name := coalesce(nullif(v_merge ->> 'full_name', ''), nullif(v_merge ->> 'name', ''), v_merge ->> 'email', v_merge ->> 'phone', '');
  execute format(
    'insert into public.activities (organization_id, type, body, metadata, %I, created_by)
     values ($1, ''system'', $2, $3, $4, $5)', p_type || '_id')
    using p_org, 'מוזג עם רשומה כפולה: ' || v_name, jsonb_build_object('merged_id', p_merge, 'merged', v_merge), p_keep, auth.uid();

  execute format('delete from public.%I where organization_id = $1 and id = $2', v_table) using p_org, p_merge;
end;
$$;

revoke all on function app.merge_columns(text) from public, anon;
grant execute on function app.merge_columns(text) to authenticated;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.merge_records(uuid, text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.merge_records(uuid, text, uuid, uuid, jsonb) to authenticated;
