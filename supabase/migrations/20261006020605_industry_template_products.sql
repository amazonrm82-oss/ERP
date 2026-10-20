-- FLD-05, wave 2: industry templates add sample products too, when the business has the product catalog in its plan.
-- * app.industry_template_products(key): the sample products per industry key, as data (name, kind, price before VAT
--   in agorot, billing). It mirrors TEMPLATE_PRODUCTS in src/features/industry-templates/templates.ts;
--   tests/db/65-industry-templates.test.ts keeps the two equal. app.industry_template() is not changed.
-- * public.apply_industry_template(org, industry): the body of 010700 plus one step before the industry is recorded:
--   with the 'products' flag, each sample product whose name no product of the business has (btrim, archived ones
--   included) is added as taxable, price before VAT; the max_products quota trigger's refusal is reported in "limits"
--   like the other limits (and the template is then not recorded, so it stays offered). Without the flag nothing is
--   added and nothing is reported. The answer's "added" gains "products".
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.industry_template_products(p_industry text) returns jsonb
language sql immutable
set search_path = ''
as $fn$
  select case p_industry
    when 'services' then $tpl$[{"name": "פגישת ייעוץ", "kind": "service", "price_agorot": 45000, "billing": "one_time"}, {"name": "ליווי חודשי", "kind": "service", "price_agorot": 250000, "billing": "monthly"}, {"name": "סדנה", "kind": "service", "price_agorot": 350000, "billing": "one_time"}]$tpl$::jsonb
    when 'real_estate' then $tpl$[{"name": "דמי תיווך בשכירות", "kind": "service", "price_agorot": 500000, "billing": "one_time"}, {"name": "צילום ושיווק נכס", "kind": "service", "price_agorot": 150000, "billing": "one_time"}, {"name": "ייעוץ השקעות נדל\"ן", "kind": "service", "price_agorot": 80000, "billing": "one_time"}]$tpl$::jsonb
    when 'insurance_finance' then $tpl$[{"name": "בדיקת תיק ביטוחי", "kind": "service", "price_agorot": 40000, "billing": "one_time"}, {"name": "ייעוץ פנסיוני", "kind": "service", "price_agorot": 60000, "billing": "one_time"}, {"name": "ליווי פיננסי חודשי", "kind": "service", "price_agorot": 50000, "billing": "monthly"}]$tpl$::jsonb
    when 'construction' then $tpl$[{"name": "ביקור ומדידה", "kind": "service", "price_agorot": 30000, "billing": "one_time"}, {"name": "שעת עבודה", "kind": "service", "price_agorot": 18000, "billing": "one_time"}, {"name": "שיפוץ חדר רחצה", "kind": "service", "price_agorot": 2500000, "billing": "one_time"}]$tpl$::jsonb
    when 'retail' then $tpl$[{"name": "מוצר לדוגמה", "kind": "product", "price_agorot": 10000, "billing": "one_time"}, {"name": "כרטיס מתנה", "kind": "product", "price_agorot": 20000, "billing": "one_time"}, {"name": "משלוח עד הבית", "kind": "service", "price_agorot": 3000, "billing": "one_time"}]$tpl$::jsonb
    when 'health' then $tpl$[{"name": "פגישת היכרות", "kind": "service", "price_agorot": 15000, "billing": "one_time"}, {"name": "טיפול", "kind": "service", "price_agorot": 30000, "billing": "one_time"}, {"name": "סדרת 10 טיפולים", "kind": "service", "price_agorot": 270000, "billing": "one_time"}]$tpl$::jsonb
    when 'education' then $tpl$[{"name": "שיעור פרטי", "kind": "service", "price_agorot": 18000, "billing": "one_time"}, {"name": "קורס", "kind": "service", "price_agorot": 120000, "billing": "one_time"}, {"name": "מנוי חודשי לחוגים", "kind": "service", "price_agorot": 45000, "billing": "monthly"}]$tpl$::jsonb
    when 'marketing' then $tpl$[{"name": "ניהול רשתות חברתיות", "kind": "service", "price_agorot": 350000, "billing": "monthly"}, {"name": "ניהול קמפיין ממומן", "kind": "service", "price_agorot": 250000, "billing": "monthly"}, {"name": "בניית דף נחיתה", "kind": "service", "price_agorot": 400000, "billing": "one_time"}]$tpl$::jsonb
    when 'technology' then $tpl$[{"name": "שעת פיתוח", "kind": "service", "price_agorot": 35000, "billing": "one_time"}, {"name": "הטמעה והדרכה", "kind": "service", "price_agorot": 300000, "billing": "one_time"}, {"name": "מנוי תוכנה", "kind": "service", "price_agorot": 20000, "billing": "monthly"}]$tpl$::jsonb
    when 'tourism_events' then $tpl$[{"name": "הפקת אירוע", "kind": "service", "price_agorot": 1500000, "billing": "one_time"}, {"name": "חבילת צילום", "kind": "service", "price_agorot": 450000, "billing": "one_time"}, {"name": "יום טיול מאורגן", "kind": "service", "price_agorot": 25000, "billing": "one_time"}]$tpl$::jsonb
    when 'nonprofit' then $tpl$[{"name": "תרומה חודשית", "kind": "service", "price_agorot": 10000, "billing": "monthly"}, {"name": "חסות לאירוע", "kind": "service", "price_agorot": 500000, "billing": "one_time"}, {"name": "סדנה לקהילה", "kind": "service", "price_agorot": 5000, "billing": "one_time"}]$tpl$::jsonb
    when 'other' then '[]'::jsonb
    else null
  end
$fn$;
revoke all on function app.industry_template_products(text) from public, anon, authenticated;

create or replace function public.apply_industry_template(p_org uuid, p_industry text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_t jsonb;
  v_item jsonb;
  v_name text;
  v_pipeline uuid;
  v_pos integer;
  v_hint text;
  v_open jsonb;
  v_closed jsonb;
  v_names text[];
  v_limits text[] := '{}';
  v_pipelines integer := 0;
  v_stages integer := 0;
  v_statuses integer := 0;
  v_sources integer := 0;
  v_fields integer := 0;
  v_automations integer := 0;
  v_products integer := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_t := app.industry_template(p_industry);
  if v_t is null then
    raise exception 'unknown industry template' using errcode = 'P0001', hint = 'template:unknown';
  end if;

  -- one apply at a time per organization, so two at once cannot both add a name
  perform 1 from public.organizations o where o.id = p_org for no key update;

  -- pipeline and stages
  if jsonb_typeof(v_t -> 'pipeline') = 'object' then
    v_name := v_t -> 'pipeline' ->> 'name';
    select p.id into v_pipeline
      from public.pipelines p
     where p.organization_id = p_org and p.deleted_at is null
       and btrim(p.name) = btrim(v_name)
     order by p.position, p.created_at
     limit 1;
    if v_pipeline is null then
      begin
        insert into public.pipelines (organization_id, name, position, is_default, created_by)
        values (
          p_org, v_name,
          coalesce((select max(p.position) + 1 from public.pipelines p where p.organization_id = p_org), 0),
          false, v_uid)
        returning id into v_pipeline;
        v_pipelines := 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') not like 'limit:%' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end if;

    if v_pipeline is not null then
      -- what is missing, in template order: open stages, then a won / lost stage of a kind the pipeline lacks
      select coalesce(jsonb_agg(e.value order by e.n) filter (where e.value ->> 'kind' = 'open'), '[]'::jsonb),
             coalesce(jsonb_agg(e.value order by e.n) filter (where e.value ->> 'kind' <> 'open'), '[]'::jsonb)
        into v_open, v_closed
        from jsonb_array_elements(v_t -> 'pipeline' -> 'stages') with ordinality as e(value, n)
       where not exists (
               select 1 from public.stages s
                where s.organization_id = p_org and s.pipeline_id = v_pipeline
                  and (btrim(s.name) = btrim(e.value ->> 'name')
                       or (e.value ->> 'kind' <> 'open' and s.kind::text = e.value ->> 'kind')));

      if jsonb_array_length(v_open) > 0 then
        select min(s.position) into v_pos from public.stages s
         where s.organization_id = p_org and s.pipeline_id = v_pipeline and s.kind <> 'open';
        if v_pos is not null then
          -- one update for all of them: the won / lost stages (and anything after) move down
          update public.stages s set position = s.position + jsonb_array_length(v_open)
           where s.organization_id = p_org and s.pipeline_id = v_pipeline and s.position >= v_pos;
        else
          select coalesce(max(s.position) + 1, 0) into v_pos from public.stages s
           where s.organization_id = p_org and s.pipeline_id = v_pipeline;
        end if;
        for v_item in select e.value from jsonb_array_elements(v_open) as e loop
          insert into public.stages (organization_id, pipeline_id, name, position, kind, probability, rot_days)
          values (p_org, v_pipeline, v_item ->> 'name', v_pos, 'open',
                  (v_item ->> 'probability')::smallint, (v_item ->> 'rot_days')::integer);
          v_pos := v_pos + 1;
          v_stages := v_stages + 1;
        end loop;
      end if;

      for v_item in select e.value from jsonb_array_elements(v_closed) as e loop
        insert into public.stages (organization_id, pipeline_id, name, position, kind, probability, rot_days)
        values (p_org, v_pipeline, v_item ->> 'name',
                coalesce((select max(s.position) + 1 from public.stages s
                           where s.organization_id = p_org and s.pipeline_id = v_pipeline), 0),
                (v_item ->> 'kind')::public.stage_kind,
                (v_item ->> 'probability')::smallint, (v_item ->> 'rot_days')::integer);
        v_stages := v_stages + 1;
      end loop;
    end if;
  end if;

  -- lead statuses (open), before the first converted / not relevant one
  select coalesce(array_agg(e.value order by e.n), '{}')
    into v_names
    from jsonb_array_elements_text(v_t -> 'statuses') with ordinality as e(value, n)
   where not exists (
           select 1 from public.lead_statuses s
            where s.organization_id = p_org and btrim(s.name) = btrim(e.value));
  if cardinality(v_names) > 0 then
    select min(s.position) into v_pos from public.lead_statuses s
     where s.organization_id = p_org and s.kind <> 'open';
    if v_pos is not null then
      update public.lead_statuses s set position = s.position + cardinality(v_names)
       where s.organization_id = p_org and s.position >= v_pos;
    else
      select coalesce(max(s.position) + 1, 0) into v_pos from public.lead_statuses s where s.organization_id = p_org;
    end if;
    foreach v_name in array v_names loop
      insert into public.lead_statuses (organization_id, name, kind, position, is_default)
      values (p_org, v_name, 'open', v_pos, false);
      v_pos := v_pos + 1;
      v_statuses := v_statuses + 1;
    end loop;
  end if;

  -- lead sources
  for v_name in select e.value from jsonb_array_elements_text(v_t -> 'sources') as e loop
    continue when exists (
      select 1 from public.lead_sources s
       where s.organization_id = p_org and btrim(s.name) = btrim(v_name));
    insert into public.lead_sources (organization_id, name, kind) values (p_org, v_name, 'other');
    v_sources := v_sources + 1;
  end loop;

  -- custom fields (the plan limit per object type is the table's trigger)
  for v_item in select e.value from jsonb_array_elements(v_t -> 'fields') as e loop
    continue when exists (
      select 1 from public.field_definitions f
       where f.organization_id = p_org and f.object_type = v_item ->> 'object_type'
         and (f.key = v_item ->> 'key' or btrim(f.label) = btrim(v_item ->> 'label')));
    begin
      insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, position, created_by)
      values (
        p_org, v_item ->> 'object_type', v_item ->> 'key', v_item ->> 'label', v_item ->> 'field_type',
        v_item -> 'options',
        coalesce((select max(f.position) + 1 from public.field_definitions f
                   where f.organization_id = p_org and f.object_type = v_item ->> 'object_type'), 0),
        v_uid);
      v_fields := v_fields + 1;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_hint = pg_exception_hint;
      if coalesce(v_hint, '') not like 'limit:%' then
        raise;
      end if;
      v_limits := v_limits || v_hint;
    end;
  end loop;

  -- automations, switched off: the business turns on what it wants
  for v_item in select e.value from jsonb_array_elements(v_t -> 'automations') as e loop
    continue when exists (
      select 1 from public.automations a
       where a.organization_id = p_org
         and (a.template_key = 'industry:' || p_industry || ':' || (v_item ->> 'key')
              or btrim(a.name) = btrim(v_item ->> 'name')));
    insert into public.automations
      (organization_id, name, template_key, is_active, entity_type, trigger_type, trigger_config, conditions, actions, created_by)
    values (
      p_org, v_item ->> 'name', 'industry:' || p_industry || ':' || (v_item ->> 'key'), false,
      v_item ->> 'entity_type', v_item ->> 'trigger_type', v_item -> 'trigger_config', '[]'::jsonb,
      v_item -> 'actions', v_uid);
    v_automations := v_automations + 1;
  end loop;

  -- FLD-05 (wave 2): sample products, only with the product catalog in the plan (otherwise none, and no limit is
  -- reported); a name any product of the business has, archived ones too, is skipped; max_products is the table's
  -- quota trigger (products_quota), reported like the other limits
  if app.org_has_feature(p_org, 'products') then
    for v_item in select e.value from jsonb_array_elements(app.industry_template_products(p_industry)) as e loop
      continue when exists (
        select 1 from public.products pr
         where pr.organization_id = p_org and btrim(pr.name) = btrim(v_item ->> 'name'));
      begin
        insert into public.products (organization_id, name, kind, price_agorot, price_includes_vat, vat_kind, billing)
        values (p_org, v_item ->> 'name', v_item ->> 'kind', (v_item ->> 'price_agorot')::bigint, false, 'taxable', v_item ->> 'billing');
        v_products := v_products + 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') not like 'limit:%' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end loop;
  end if;

  -- recorded only when complete: a template that a limit cut short is still offered
  if cardinality(v_limits) = 0 then
    update public.organizations o
       set industry_templates = o.industry_templates || p_industry
     where o.id = p_org and not (p_industry = any (o.industry_templates));
  end if;

  return jsonb_build_object(
    'added', jsonb_build_object(
      'pipelines', v_pipelines, 'stages', v_stages, 'statuses', v_statuses,
      'sources', v_sources, 'fields', v_fields, 'automations', v_automations, 'products', v_products),
    'limits', (select coalesce(jsonb_agg(distinct l), '[]'::jsonb) from unnest(v_limits) as l));
end;
$$;
revoke all on function public.apply_industry_template(uuid, text) from public, anon;
grant execute on function public.apply_industry_template(uuid, text) to authenticated;
