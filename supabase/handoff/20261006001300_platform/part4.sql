-- 20261006001300_platform: part 4 of 11. Run the parts in order.
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
             where m.organization_id = o.id and m.role = 'owner' limit 1) as owner_email
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.org_usage u on u.organization_id = o.id
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
