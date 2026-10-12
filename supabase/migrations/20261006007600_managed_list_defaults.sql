-- =============================================================================
-- Managed lists start with default values (owner's rule, 12 October 2026)
-- =============================================================================
-- Every list an organization manages starts filled; the business renames,
-- hides or deletes what it does not need. There is no "add the suggested
-- values" button any more.
-- * app.seed_list_defaults(org): inserts the default contact types, company
--   types (CON-02) and "not relevant" reasons (LEAD-03) of one organization,
--   each list only while it has no rows at all (per object type for the
--   types). Insert only. The names mirror src/features/record-type-options/
--   schema.ts (DEFAULT_TYPES) and src/features/disqualify-reasons/schema.ts
--   (DEFAULT_REASONS); tests/db/56-managed-list-defaults.test.ts keeps them equal.
-- * create_organization is re-created as in 0047, plus a call to the seed.
--   Lead statuses, lead sources and the default pipeline were already seeded.
-- * Existing organizations: the seed runs once for each of them (approved by
--   the owner). A list that already has rows, even hidden ones, is left alone.
--   The inserts run through the tables' triggers: the caps (an empty list is far
--   below 50) and the audit trigger, which writes one 'insert' entry per row with
--   no actor (auth.uid() is null in a migration).
-- Every statement is safe to run twice.

create or replace function app.seed_list_defaults(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_types constant text[] := array['לקוח', 'לקוח פוטנציאלי', 'ספק', 'שותף', 'מתחרה', 'אחר'];
  v_reasons constant text[] := array['לא עונה', 'המחיר גבוה מדי', 'קנה אצל מתחרה', 'לא מתאים לשירות', 'פרטים לא נכונים', 'אחר'];
  v_object text;
begin
  foreach v_object in array array['contact', 'company'] loop
    insert into public.record_type_options (organization_id, object_type, name, position)
    select p_org, v_object, d.name, (d.n - 1)::integer
      from unnest(v_types) with ordinality as d(name, n)
     where not exists (select 1 from public.record_type_options r
                        where r.organization_id = p_org and r.object_type = v_object)
     order by d.n;
  end loop;

  insert into public.disqualify_reasons (organization_id, name, position)
  select p_org, d.name, (d.n - 1)::integer
    from unnest(v_reasons) with ordinality as d(name, n)
   where not exists (select 1 from public.disqualify_reasons r where r.organization_id = p_org)
   order by d.n;
end;
$$;
revoke all on function app.seed_list_defaults(uuid) from public, anon, authenticated;

create or replace function public.create_organization(
  p_name      text,
  p_industry  text default null,
  p_team_size text default null,
  p_phone     text default null
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_pipeline uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'organization name is required' using errcode = '22023';
  end if;
  if (select count(*) from public.memberships m where m.user_id = v_uid and m.role = 'owner') >= 5 then
    raise exception 'a user can own at most 5 organizations' using errcode = 'P0001', hint = 'limit:owned_organizations';
  end if;

  insert into public.organizations (name, slug, industry, team_size, phone, created_by)
  values (
    btrim(p_name),
    'org-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    nullif(btrim(p_industry), ''),
    nullif(btrim(p_team_size), ''),
    nullif(btrim(p_phone), ''),
    v_uid
  )
  returning id into v_org;

  insert into public.subscriptions (organization_id, plan_key, status, trial_ends_at)
  values (v_org, 'pro', 'trialing', now() + interval '14 days');

  insert into public.org_usage (organization_id) values (v_org);

  insert into public.memberships (organization_id, user_id, role, seat_type)
  values (v_org, v_uid, 'owner', 'full');

  insert into public.pipelines (organization_id, name, position, is_default)
  values (v_org, 'מכירות', 0, true)
  returning id into v_pipeline;

  insert into public.stages (organization_id, pipeline_id, name, position, kind, probability, rot_days) values
    (v_org, v_pipeline, 'פנייה ראשונית', 0, 'open', 10, 7),
    (v_org, v_pipeline, 'שיחת היכרות',   1, 'open', 25, 7),
    (v_org, v_pipeline, 'הצעת מחיר',     2, 'open', 50, 14),
    (v_org, v_pipeline, 'משא ומתן',      3, 'open', 75, 14),
    (v_org, v_pipeline, 'נסגר בהצלחה',   4, 'won', 100, null),
    (v_org, v_pipeline, 'אבוד',          5, 'lost', 0, null);

  insert into public.lead_statuses (organization_id, name, kind, position, is_default) values
    (v_org, 'חדש',         'open',         0, true),
    (v_org, 'נוצר קשר',    'open',         1, false),
    (v_org, 'בטיפול',      'open',         2, false),
    (v_org, 'לא ענה',      'open',         3, false),
    (v_org, 'מתאים',       'open',         4, false),
    (v_org, 'הומר',        'converted',    5, false),
    (v_org, 'לא רלוונטי',  'disqualified', 6, false);

  insert into public.lead_sources (organization_id, name, kind) values
    (v_org, 'הזנה ידנית', 'manual'),
    (v_org, 'טופס באתר',  'form'),
    (v_org, 'פייסבוק',    'facebook'),
    (v_org, 'WhatsApp',   'whatsapp'),
    (v_org, 'טלפון',      'phone'),
    (v_org, 'המלצה',      'other'),
    (v_org, 'ייבוא',      'import');

  -- contact types, company types and "not relevant" reasons (CON-02, LEAD-03)
  perform app.seed_list_defaults(v_org);

  return v_org;
end;
$$;
revoke all on function public.create_organization(text, text, text, text) from public, anon;
grant execute on function public.create_organization(text, text, text, text) to authenticated, service_role;

-- organizations that exist today: only their empty lists are filled
do $$
declare
  v_org uuid;
begin
  for v_org in select o.id from public.organizations o order by o.created_at loop
    perform app.seed_list_defaults(v_org);
  end loop;
end;
$$;
