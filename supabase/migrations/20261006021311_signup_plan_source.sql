-- WEB-02 (lead's choices, built before the owner's answers): sign-up from the price list with the chosen plan, and the
-- sign-up source kept on the new business and shown in the platform panel.
--
-- * The landing page's plan button goes through /go/signup (LND-14 counts it) to /signup?src=…&plan=…. The sign-up action
--   writes the chosen plan and the folded source into the person's OWN Auth user metadata (`signup_plan`, `signup_source`),
--   so they survive the email confirmation without a cookie, a visitor id or anything in the confirmation link.
-- * public.create_organization (redefined from 007600 with every line kept) reads that metadata for the person's FIRST own
--   business only. Nothing is trusted: the plan counts only while public.plans says it is 'available' now, else the trial
--   is today's 'pro' trial, silently; the source is folded again by app.landing_event_source (LND-14). The trial is the
--   same 14 days in status 'trialing'. No metadata = exactly today's behaviour.
-- * app.org_signup_origins keeps the source and the honoured plan, set once at creation (no grants: no client reads or
--   writes it; cascades with the business). The platform panel reads it through platform_list_orgs() and platform_org(),
--   redefined from 011600 with every line kept.
-- Every statement is safe to run twice.

create table if not exists app.org_signup_origins (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  -- LND-14's folded utm_source: direct | other | [a-z0-9_.-]{1,40}; null = a plan was chosen with no source carried
  source      text check (source is null or source ~ '^[a-z0-9_.-]{1,40}$'),
  -- the plan chosen on the price list, only when it was available at creation
  plan_key    text references public.plans (key) on delete set null,
  recorded_at timestamptz not null default now()
);

-- RVW-15: every app table has RLS on (no policies, not forced); clients have no grants
-- FXD-06: every foreign key has a covering index (test 130)
create index if not exists org_signup_origins_plan_idx on app.org_signup_origins (plan_key) where plan_key is not null;

alter table app.org_signup_origins enable row level security;
revoke all on app.org_signup_origins from public, anon, authenticated;

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

  -- WEB-02: the plan and the source chosen at sign-up apply to the person's FIRST own business only. Never trusted: the
  -- plan counts only while it is available now (anything else = today's 'pro' trial, silently), the source is folded
  -- again by LND-14's rule. No choice = exactly today's trial.
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

  insert into public.subscriptions (organization_id, plan_key, status, trial_ends_at)
  values (v_org, coalesce(v_plan, 'pro'), 'trialing', now() + interval '14 days');

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

create or replace function public.platform_list_orgs(
  p_search text default null, p_status text default null, p_plan text default null,
  p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  with base as (
    select o.id, o.name, o.slug, o.status::text as status, o.created_at, o.deleted_at,
           s.plan_key, s.status::text as subscription_status, s.seats, s.trial_ends_at,
           (select count(*) from public.memberships m where m.organization_id = o.id and m.status = 'active') as members,
           coalesce(u.records_count, 0) as records,
           (select au.email from public.memberships m join auth.users au on au.id = m.user_id
             where m.organization_id = o.id and m.role = 'owner' limit 1) as owner_email,
           act.activated_at,
           -- WEB-02: where the business signed up from, and the plan chosen on the price list
           so.source as signup_source, so.plan_key as signup_plan
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.org_usage u on u.organization_id = o.id
      left join app.org_activation act on act.organization_id = o.id
      left join app.org_signup_origins so on so.organization_id = o.id
  ), filtered as (
    select * from base b
     where (p_status is null or b.status = p_status)
       and (p_plan is null or b.plan_key = p_plan)
       and (p_search is null or b.name ilike '%' || p_search || '%' or b.slug ilike '%' || p_search || '%'
            or b.owner_email ilike '%' || p_search || '%')
  )
  select jsonb_build_object(
           'total', (select count(*) from filtered),
           'rows', coalesce((select jsonb_agg(f order by f.created_at desc)
                               from (select * from filtered order by created_at desc
                                     limit least(greatest(coalesce(p_limit, 50), 1), 200)
                                     offset greatest(coalesce(p_offset, 0), 0)) f), '[]'::jsonb))
    into v_result;
  return v_result;
end;
$$;

create or replace function public.platform_org(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return (
    select jsonb_build_object(
      'org', jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status, 'industry', o.industry,
                                'team_size', o.team_size, 'created_at', o.created_at, 'deleted_at', o.deleted_at),
      'subscription', to_jsonb(s) - 'provider_customer_ref' - 'provider_subscription_ref',
      'plan', jsonb_build_object('name_he', p.name_he, 'limits', p.limits, 'features', p.features),
      'records', coalesce((select u.records_count from public.org_usage u where u.organization_id = o.id), 0),
      'members', (select jsonb_object_agg(r.role, r.n) from (
                    select m.role::text as role, count(*) as n from public.memberships m
                     where m.organization_id = o.id and m.status = 'active' group by m.role) r),
      'owner', (select jsonb_build_object('email', au.email, 'name', pr.full_name, 'last_sign_in_at', au.last_sign_in_at)
                  from public.memberships m join auth.users au on au.id = m.user_id
                  left join public.profiles pr on pr.id = m.user_id
                 where m.organization_id = o.id and m.role = 'owner' limit 1),
      'last_sign_in_at', (select max(au.last_sign_in_at) from public.memberships m join auth.users au on au.id = m.user_id
                           where m.organization_id = o.id),
      'counts', jsonb_build_object(
        'automations', (select count(*) from public.automations a where a.organization_id = o.id and a.is_active),
        'forms', (select count(*) from public.forms f where f.organization_id = o.id),
        'pipelines', (select count(*) from public.pipelines pl where pl.organization_id = o.id and pl.deleted_at is null)),
      'support_until', (select max(g.expires_at) from public.support_access_grants g
                         where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now()),
      -- GAP-06: null until the first real lead got an answer within 24 hours
      'activation', (select jsonb_build_object('activated_at', act.activated_at, 'lead_created_at', act.lead_created_at)
                       from app.org_activation act where act.organization_id = o.id),
      -- WEB-02: null when the business was not made after a sign-up that carried a source or a plan
      'signup', (select jsonb_build_object('source', so.source, 'plan_key', so.plan_key, 'recorded_at', so.recorded_at)
                   from app.org_signup_origins so where so.organization_id = o.id))
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.plans p on p.key = s.plan_key
     where o.id = p_org);
end;
$$;

revoke all on function public.platform_list_orgs(text, text, text, integer, integer) from public, anon;
revoke all on function public.platform_org(uuid) from public, anon;
grant execute on function public.platform_list_orgs(text, text, text, integer, integer) to authenticated;
grant execute on function public.platform_org(uuid) to authenticated;
