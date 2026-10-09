-- =============================================================================
-- 0046 Plan and usage, read-only, for the "חבילה ושימוש" settings page (FXU-04)
-- =============================================================================
-- Until there is billing, a business sees its plan, the days left in its trial
-- and how much of each limit it uses. The effective limit is the plan's, or the
-- business's override (app.org_limit). Usage is counted over the whole business,
-- whatever the caller may see of it, so the function is security definer and
-- answers members only. It reads; it changes nothing.
-- Every statement is safe to run twice.

create or replace function public.org_plan_usage(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not app.is_member(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'plan_key', s.plan_key,
    'plan_name', p.name_he,
    'status', s.status,
    'trial_ends_at', s.trial_ends_at,
    'seats', s.seats,
    'usage', jsonb_build_array(
      jsonb_build_object('key', 'max_users', 'limit', app.org_limit(p_org, 'max_users'),
        'used', (select count(*) from public.memberships m
                  where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full')),
      jsonb_build_object('key', 'max_records', 'limit', app.org_limit(p_org, 'max_records'),
        'used', coalesce((select u.records_count from public.org_usage u where u.organization_id = p_org), 0)),
      jsonb_build_object('key', 'max_pipelines', 'limit', app.org_limit(p_org, 'max_pipelines'),
        'used', (select count(*) from public.pipelines pl where pl.organization_id = p_org and pl.deleted_at is null)),
      jsonb_build_object('key', 'max_forms', 'limit', app.org_limit(p_org, 'max_forms'),
        'used', (select count(*) from public.forms f where f.organization_id = p_org and f.kind = 'form')),
      jsonb_build_object('key', 'max_active_automations', 'limit', app.org_limit(p_org, 'max_active_automations'),
        'used', (select count(*) from public.automations a where a.organization_id = p_org and a.is_active)),
      jsonb_build_object('key', 'storage_gb', 'limit', app.org_limit(p_org, 'storage_gb'),
        'used', round(coalesce((select sum(fl.size_bytes) from public.files fl where fl.organization_id = p_org), 0) / 1073741824.0, 3))
    )
  )
  into v_result
  from public.subscriptions s
  join public.plans p on p.key = s.plan_key
  where s.organization_id = p_org;

  return v_result;
end;
$$;
revoke all on function public.org_plan_usage(uuid) from public, anon;
grant execute on function public.org_plan_usage(uuid) to authenticated;
