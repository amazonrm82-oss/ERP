-- =============================================================================
-- 0047 New businesses get the lead status "מתאים" instead of "מוסמך" (FXU-08)
-- =============================================================================
-- create_organization is re-created unchanged except for that one name.
-- Businesses that already exist keep their statuses; renaming those rows is the
-- owner's decision, and each business can rename its own in the settings.
-- Every statement is safe to run twice.

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

  return v_org;
end;
$$;
revoke all on function public.create_organization(text, text, text, text) from public, anon;
grant execute on function public.create_organization(text, text, text, text) to authenticated, service_role;
