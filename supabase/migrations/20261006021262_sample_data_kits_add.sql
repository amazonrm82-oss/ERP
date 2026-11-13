-- VRT-03: sample data by industry, part 2 of 2: adding the records. Needs part 1 (sample_data_kits).
-- * app.sample_kit_add(org, kit, tag, status, source, pipeline, stage, currency) (definer, no grants; called only by
--   public.sample_data_add after its rights check, business lock and "already there" check): adds the kit's set from
--   app.sample_kit_content(kit), all owned by the caller, every name with " (דוגמה)" and the tag "דוגמה", exactly as the
--   generic set: two contacts, three leads, one deal (when the business has an open stage) and two tasks. A lead's status
--   and source, and the deal's pipeline and stage, are the kit's by name (btrim) when the business has them (an open
--   status, an active source, a live pipeline and an open stage of it), else the generic set's choices passed in. Custom
--   field values through app.sample_kit_fields. With the plan key punch_cards, a seller (app.punch_card_seller) and the
--   kit's punch card product offerable, one card is opened active by hand on the named contact through
--   public.punch_card_open (no payment, no timeline entry) and noted in app.sample_punch_cards; a refusal there skips the
--   card, never the set. Automations do not react (app.automation_running, as the generic set) and nobody is notified.
--   Every record is noted in app.sample_records with its snapshot (USR-04's removal rule unchanged). Answers
--   {created, kit, punch_cards}.
-- * public.sample_data_add(org): 010500's body (same signature, rights and checks; the generic set unchanged) with one
--   step after the tag: a business with a kit (app.sample_kit) gets app.sample_kit_add instead.
-- Every statement is safe to run twice. No drop statement, no row removal.

create or replace function app.sample_kit_add(
  p_org uuid, p_kit text, p_tag uuid, p_status uuid, p_source uuid, p_pipeline uuid, p_stage uuid, p_currency text
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_content  jsonb := app.sample_kit_content(p_kit);
  v_suffix   constant text := ' (דוגמה)';
  v_prev_automation text := current_setting('app.automation_running', true);
  v_item     jsonb;
  v_keys     jsonb := '{}'::jsonb;
  v_id       uuid;
  v_status   uuid;
  v_source   uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_deal     uuid;
  v_deal_contact uuid;
  v_contacts uuid[] := '{}';
  v_leads    uuid[] := '{}';
  v_tasks    uuid[] := '{}';
  v_product  uuid;
  v_card     uuid;
begin
  if v_uid is null or v_content is null then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;

  perform set_config('app.automation_running', 'on', true);

  for v_item in select value from jsonb_array_elements(v_content -> 'contacts') loop
    insert into public.contacts (organization_id, first_name, last_name, email, city, source_id, owner_id, tag_ids, custom_fields)
    values (p_org, v_item ->> 'first_name', (v_item ->> 'last_name') || v_suffix, v_item ->> 'email', v_item ->> 'city',
            p_source, v_uid, array[p_tag], app.sample_kit_fields(p_org, 'contact', v_item -> 'custom_fields'))
    returning id into v_id;
    v_keys := v_keys || jsonb_build_object(v_item ->> 'key', v_id);
    v_contacts := v_contacts || v_id;
  end loop;

  for v_item in select value from jsonb_array_elements(v_content -> 'leads') loop
    v_status := null;
    v_source := null;
    select s.id into v_status from public.lead_statuses s
     where s.organization_id = p_org and s.kind = 'open' and btrim(s.name) = btrim(v_item ->> 'status')
     order by s.position, s.created_at limit 1;
    select s.id into v_source from public.lead_sources s
     where s.organization_id = p_org and s.is_active and btrim(s.name) = btrim(v_item ->> 'source')
     order by s.created_at limit 1;
    insert into public.leads (organization_id, full_name, email, status_id, source_id, message, owner_id, tag_ids, custom_fields)
    values (p_org, (v_item ->> 'full_name') || v_suffix, v_item ->> 'email', coalesce(v_status, p_status),
            coalesce(v_source, p_source), v_item ->> 'message', v_uid, array[p_tag],
            app.sample_kit_fields(p_org, 'lead', v_item -> 'custom_fields'))
    returning id into v_id;
    v_keys := v_keys || jsonb_build_object(v_item ->> 'key', v_id);
    v_leads := v_leads || v_id;
  end loop;

  -- the deal: the kit's process and stage by name, else the generic choice
  select p.id into v_pipeline from public.pipelines p
   where p.organization_id = p_org and p.deleted_at is null and btrim(p.name) = btrim(v_content #>> '{deal,pipeline}')
   order by p.position, p.created_at limit 1;
  if v_pipeline is not null then
    select st.id into v_stage from public.stages st
     where st.organization_id = p_org and st.pipeline_id = v_pipeline and st.kind = 'open'
     order by (btrim(st.name) = btrim(v_content #>> '{deal,stage}')) desc, st.position, st.created_at limit 1;
  end if;
  if v_stage is null then
    v_pipeline := p_pipeline;
    v_stage := p_stage;
  end if;
  v_deal_contact := (v_keys ->> (v_content #>> '{deal,contact}'))::uuid;
  if v_stage is not null then
    insert into public.deals (organization_id, name, amount_agorot, currency, pipeline_id, stage_id,
                              contact_id, source_id, owner_id, tag_ids, custom_fields)
    values (p_org, (v_content #>> '{deal,name}') || v_suffix, (v_content #>> '{deal,amount_agorot}')::bigint, p_currency,
            v_pipeline, v_stage, v_deal_contact, p_source, v_uid, array[p_tag],
            app.sample_kit_fields(p_org, 'deal', v_content #> '{deal,custom_fields}'))
    returning id into v_deal;
  end if;

  for v_item in select value from jsonb_array_elements(v_content -> 'tasks') loop
    insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id, deal_id, contact_id)
    values (p_org, (v_item ->> 'title') || v_suffix, v_item ->> 'task_type',
            now() + make_interval(mins => (v_item ->> 'due_minutes')::integer), v_uid,
            (v_keys ->> (v_item ->> 'lead'))::uuid,
            case when (v_item ->> 'deal')::boolean then v_deal end,
            case when (v_item ->> 'deal')::boolean and v_deal is null then v_deal_contact end)
    returning id into v_id;
    v_tasks := v_tasks || v_id;
  end loop;

  -- the punch card: only with the key, a seller and the kit's product in the catalog
  if jsonb_typeof(v_content -> 'punch_card') = 'object'
     and app.org_has_feature(p_org, 'punch_cards') and app.punch_card_seller(p_org) then
    select p.id into v_product from public.products p
     where p.organization_id = p_org and p.kind = 'punch_card' and p.is_active and p.archived_at is null
       and p.punch_entries is not null and btrim(p.name) = btrim(v_content #>> '{punch_card,product}')
     order by p.created_at, p.id limit 1;
    if v_product is not null then
      begin
        v_card := public.punch_card_open(p_org, (v_keys ->> (v_content #>> '{punch_card,contact}'))::uuid, v_product, null, true);
      exception when sqlstate 'P0001' or sqlstate '42501' then
        v_card := null;
      end;
    end if;
  end if;

  perform set_config('app.automation_running', coalesce(v_prev_automation, ''), true);

  insert into app.sample_records (organization_id, contact_id, snapshot)
  select p_org, c, app.sample_row(p_org, 'contact', c) from unnest(v_contacts) c;
  insert into app.sample_records (organization_id, lead_id, snapshot)
  select p_org, l, app.sample_row(p_org, 'lead', l) from unnest(v_leads) l;
  if v_deal is not null then
    insert into app.sample_records (organization_id, deal_id, snapshot) values (p_org, v_deal, app.sample_row(p_org, 'deal', v_deal));
  end if;
  insert into app.sample_records (organization_id, task_id, snapshot)
  select p_org, t, app.sample_row(p_org, 'task', t) from unnest(v_tasks) t;
  if v_card is not null then
    insert into app.sample_punch_cards (organization_id, punch_card_id, snapshot)
    values (p_org, v_card, app.sample_punch_card_row(p_org, v_card));
  end if;

  return jsonb_build_object(
    'created', cardinality(v_contacts) + cardinality(v_leads) + cardinality(v_tasks) + case when v_deal is null then 0 else 1 end,
    'kit', p_kit,
    'punch_cards', case when v_card is null then 0 else 1 end);
end;
$$;
revoke all on function app.sample_kit_add(uuid, text, uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- public.sample_data_add: 010500's body, the kit step after the tag
-- ----------------------------------------------------------------------------
create or replace function public.sample_data_add(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_tag      uuid;
  v_status   uuid;
  v_source   uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_currency text;
  v_company  uuid;
  v_contact1 uuid;
  v_contact2 uuid;
  v_lead1    uuid;
  v_lead2    uuid;
  v_lead3    uuid;
  v_deal     uuid;
  v_task1    uuid;
  v_task2    uuid;
  v_suffix   constant text := ' (דוגמה)';
  v_prev_automation text := current_setting('app.automation_running', true);
  v_kit      text;
begin
  if v_uid is null or p_org is null or not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;
  -- one at a time per business, so a double click cannot add two sets
  perform 1 from public.organizations o where o.id = p_org for no key update;
  if exists (select 1 from app.sample_records s
              where s.organization_id = p_org
                and app.sample_untouched(p_org, app.sample_note_type(s), coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id), s.snapshot)) then
    raise exception 'sample data already exists' using errcode = 'P0001', hint = 'sample:exists';
  end if;

  select o.currency into v_currency from public.organizations o where o.id = p_org;

  -- the lists every business starts with; a business that removed them gets what is left
  select s.id into v_status from public.lead_statuses s
   where s.organization_id = p_org and s.kind = 'open'
   order by s.is_default desc, s.position, s.created_at limit 1;
  if v_status is null then
    raise exception 'no open lead status' using errcode = 'P0001', hint = 'sample:no_status';
  end if;
  select s.id into v_source from public.lead_sources s
   where s.organization_id = p_org and s.is_active
   order by (s.kind = 'manual') desc, s.created_at limit 1;
  select p.id into v_pipeline from public.pipelines p
   where p.organization_id = p_org and p.deleted_at is null
   order by p.is_default desc, p.position, p.created_at limit 1;
  if v_pipeline is not null then
    select st.id into v_stage from public.stages st
     where st.organization_id = p_org and st.pipeline_id = v_pipeline and st.kind = 'open'
     order by st.position, st.created_at limit 1;
  end if;

  insert into public.tags (organization_id, name, created_by)
  values (p_org, 'דוגמה', v_uid)
  on conflict (organization_id, lower(name)) do nothing;
  select t.id into v_tag from public.tags t where t.organization_id = p_org and lower(t.name) = lower('דוגמה');

  -- VRT-03: a business with an industry kit gets that industry's records (same tag, suffix, notes and fallbacks)
  v_kit := app.sample_kit(p_org);
  if v_kit is not null then
    return app.sample_kit_add(p_org, v_kit, v_tag, v_status, v_source, v_pipeline, v_stage, coalesce(v_currency, 'ILS'));
  end if;

  -- what this creates is not news for automations (like a handover of records)
  perform set_config('app.automation_running', 'on', true);

  insert into public.companies (organization_id, name, industry, email, city, owner_id, tag_ids)
  values (p_org, 'סטודיו כרמל' || v_suffix, 'עיצוב', 'office@example.com', 'חיפה', v_uid, array[v_tag])
  returning id into v_company;

  insert into public.contacts (organization_id, first_name, last_name, email, job_title, company_id, source_id, owner_id, tag_ids)
  values (p_org, 'נועה', 'כרמלי' || v_suffix, 'noa@example.com', 'מנהלת', v_company, v_source, v_uid, array[v_tag])
  returning id into v_contact1;
  insert into public.contacts (organization_id, first_name, last_name, email, city, source_id, owner_id, tag_ids)
  values (p_org, 'אבי', 'שגיא' || v_suffix, 'avi@example.com', 'תל אביב', v_source, v_uid, array[v_tag])
  returning id into v_contact2;

  insert into public.leads (organization_id, full_name, email, company_name, status_id, source_id, message, owner_id, tag_ids)
  values (p_org, 'דנה לוי' || v_suffix, 'dana@example.com', null, v_status, v_source,
          'ליד לדוגמה. אפשר למחוק את כל נתוני הדוגמה בלחיצה מרשימת ההקמה.', v_uid, array[v_tag])
  returning id into v_lead1;
  insert into public.leads (organization_id, full_name, email, company_name, status_id, source_id, message, owner_id, tag_ids)
  values (p_org, 'יוסי אברהם' || v_suffix, 'yossi@example.com', 'אברהם שיפוצים', v_status, v_source,
          'מבקש הצעת מחיר. ליד לדוגמה.', v_uid, array[v_tag])
  returning id into v_lead2;
  insert into public.leads (organization_id, full_name, email, status_id, source_id, owner_id, tag_ids)
  values (p_org, 'מיכל דהן' || v_suffix, 'michal@example.com', v_status, v_source, v_uid, array[v_tag])
  returning id into v_lead3;

  if v_stage is not null then
    insert into public.deals (organization_id, name, amount_agorot, currency, pipeline_id, stage_id,
                              contact_id, company_id, source_id, owner_id, tag_ids)
    values (p_org, 'עיצוב אתר לסטודיו כרמל' || v_suffix, 1250000, coalesce(v_currency, 'ILS'), v_pipeline, v_stage,
            v_contact1, v_company, v_source, v_uid, array[v_tag])
    returning id into v_deal;
  end if;

  insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id)
  values (p_org, 'להתקשר לדנה לוי' || v_suffix, 'call', now() + interval '2 hours', v_uid, v_lead1)
  returning id into v_task1;
  insert into public.tasks (organization_id, title, task_type, due_at, owner_id, deal_id, contact_id)
  values (p_org, 'לשלוח הצעת מחיר' || v_suffix, 'todo', now() + interval '1 day', v_uid, v_deal,
          case when v_deal is null then v_contact1 end)
  returning id into v_task2;

  perform set_config('app.automation_running', coalesce(v_prev_automation, ''), true);

  insert into app.sample_records (organization_id, company_id, snapshot) values (p_org, v_company, app.sample_row(p_org, 'company', v_company));
  insert into app.sample_records (organization_id, contact_id, snapshot) values
    (p_org, v_contact1, app.sample_row(p_org, 'contact', v_contact1)),
    (p_org, v_contact2, app.sample_row(p_org, 'contact', v_contact2));
  insert into app.sample_records (organization_id, lead_id, snapshot) values
    (p_org, v_lead1, app.sample_row(p_org, 'lead', v_lead1)),
    (p_org, v_lead2, app.sample_row(p_org, 'lead', v_lead2)),
    (p_org, v_lead3, app.sample_row(p_org, 'lead', v_lead3));
  if v_deal is not null then
    insert into app.sample_records (organization_id, deal_id, snapshot) values (p_org, v_deal, app.sample_row(p_org, 'deal', v_deal));
  end if;
  insert into app.sample_records (organization_id, task_id, snapshot) values
    (p_org, v_task1, app.sample_row(p_org, 'task', v_task1)),
    (p_org, v_task2, app.sample_row(p_org, 'task', v_task2));

  return jsonb_build_object('created', case when v_deal is null then 8 else 9 end);
end;
$$;
revoke all on function public.sample_data_add(uuid) from public, anon;
grant execute on function public.sample_data_add(uuid) to authenticated;
