-- WEB-02 follow-up (owner, answer (402) ב): a plan chosen on the price list whose price is zero starts ACTIVE, with no trial.
--
-- * "Price zero" is judged here, at business creation, from public.plans, never from the sign-up metadata: the plan's
--   price_monthly_agorot and price_annual_agorot are both 0 (both columns are NOT NULL, check >= 0, since 0001; the
--   coalesce only keeps the rule fail-safe). It applies only to a plan that create_organization already honours (the
--   person's first own business, the plan available now); every other case is exactly 021311: today's 'pro' trial, or the
--   chosen non-zero plan on a 14-day trial in status 'trialing'.
-- * Such a business is made with organizations.status = 'active' and a subscription in status 'active' with no
--   trial_ends_at (seats null, as a trial: not limited by purchase). So the BIL-08 trial-end rule never covers it
--   (app.trial_end_candidates needs 'trial' + 'trialing' + a trial end), trial_end_notice has no transition for it, the plan
--   badge shows "חבילת <name>", and app.show_built_with keeps the line unless the plan removes it.
-- * Answer (403) ב, in the same change: the plan and the source may also arrive through Google sign-in. The auth callback
--   writes them into the person's own metadata with their own session, for a brand-new account only and never over a value
--   already there. This function stays the only trust point and reads them exactly as before.
-- public.create_organization is redefined from 021311 with every line kept but the subscription insert and the two new
-- declarations. Same signature and grants. Safe to run twice.

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
  -- WEB-02: what the person chose on the landing page's price list, from their own sign-up metadata
  v_owned integer;
  v_meta jsonb;
  v_plan text;
  v_source text;
  -- WEB-02 (402) ב: the honoured plan costs nothing (both prices 0): the business starts active, with no trial
  v_free boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'organization name is required' using errcode = '22023';
  end if;
  v_owned := (select count(*) from public.memberships m where m.user_id = v_uid and m.role = 'owner');
  if v_owned >= 5 then
    raise exception 'a user can own at most 5 organizations' using errcode = 'P0001', hint = 'limit:owned_organizations';
  end if;

  -- WEB-02: the plan and the source chosen at sign-up apply to the person's FIRST own business only. Never trusted: the
  -- plan counts only while it is available now (anything else = today's 'pro' trial, silently), the source is folded
  -- again by LND-14's rule. No choice = exactly today's trial.
  -- (read before the business is made since 021312, so a zero-price plan can make it 'active' from the start)
  if v_owned = 0 then
    select u.raw_user_meta_data into v_meta from auth.users u where u.id = v_uid;
    if jsonb_typeof(v_meta) = 'object' then
      if jsonb_typeof(v_meta -> 'signup_plan') = 'string' then
        select p.key into v_plan from public.plans p
         where p.key = (v_meta ->> 'signup_plan') and p.availability = 'available';
      end if;
      if jsonb_typeof(v_meta -> 'signup_source') = 'string' then
        v_source := app.landing_event_source(v_meta ->> 'signup_source');
      end if;
    end if;
  end if;

  -- WEB-02 (402) ב: judged from public.plans, never from the metadata; only for a plan honoured above
  if v_plan is not null then
    v_free := exists (select 1 from public.plans p
                       where p.key = v_plan
                         and coalesce(p.price_monthly_agorot, 0) = 0
                         and coalesce(p.price_annual_agorot, 0) = 0);
  end if;

  insert into public.organizations (name, slug, industry, team_size, phone, created_by, status)
  values (
    btrim(p_name),
    'org-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    nullif(btrim(p_industry), ''),
    nullif(btrim(p_team_size), ''),
    nullif(btrim(p_phone), ''),
    v_uid,
    case when v_free then 'active' else 'trial' end::public.org_status
  )
  returning id into v_org;

  insert into public.subscriptions (organization_id, plan_key, status, trial_ends_at)
  values (v_org, coalesce(v_plan, 'pro'),
          case when v_free then 'active' else 'trialing' end::public.subscription_status,
          case when v_free then null else now() + interval '14 days' end);

  if v_plan is not null or v_source is not null then
    insert into app.org_signup_origins (organization_id, source, plan_key)
    values (v_org, v_source, v_plan)
    on conflict (organization_id) do nothing;
  end if;

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
