-- 20261006001300_platform: part 5 of 11. Run the parts in order.
-- account and usage data of one organization (no customer records)
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
                         where g.organization_id = o.id and g.revoked_at is null and g.expires_at > now()))
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.plans p on p.key = s.plan_key
     where o.id = p_org);
end;
$$;
