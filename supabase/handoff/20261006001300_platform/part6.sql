-- 20261006001300_platform: part 6 of 11. Run the parts in order.
-- plan, seats and trial end of one organization (finance)
create or replace function public.platform_update_subscription(
  p_org uuid, p_plan_key text, p_seats integer, p_trial_ends_at timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
begin
  perform app.require_platform(array['finance']);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.plans p where p.key = p_plan_key) then
    raise exception 'unknown plan' using errcode = '22023';
  end if;
  select jsonb_build_object('plan_key', s.plan_key, 'seats', s.seats, 'trial_ends_at', s.trial_ends_at)
    into v_old from public.subscriptions s where s.organization_id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  update public.subscriptions
     set plan_key = p_plan_key, seats = p_seats, trial_ends_at = p_trial_ends_at, updated_at = now()
   where organization_id = p_org;
  perform app.log_platform('subscription.update', p_org, jsonb_build_object(
    'old', v_old, 'new', jsonb_build_object('plan_key', p_plan_key, 'seats', p_seats, 'trial_ends_at', p_trial_ends_at),
    'reason', left(p_reason, 500)));
end;
$$;

-- per-organization limit and feature overrides (owner only). {} clears them.
create or replace function public.platform_set_overrides(p_org uuid, p_limits jsonb, p_features jsonb, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_key text;
  v_old jsonb;
begin
  perform app.require_platform(array[]::text[]);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_limits, '{}')) <> 'object' or jsonb_typeof(coalesce(p_features, '{}')) <> 'object' then
    raise exception 'overrides must be objects' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(coalesce(p_limits, '{}')) loop
    if jsonb_typeof(p_limits -> v_key) not in ('number', 'null') then
      raise exception 'limit % must be a number or null', v_key using errcode = '22023';
    end if;
  end loop;
  for v_key in select jsonb_object_keys(coalesce(p_features, '{}')) loop
    if jsonb_typeof(p_features -> v_key) <> 'boolean' then
      raise exception 'feature % must be true or false', v_key using errcode = '22023';
    end if;
  end loop;
  select jsonb_build_object('limits', s.limit_overrides, 'features', s.feature_overrides)
    into v_old from public.subscriptions s where s.organization_id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  update public.subscriptions
     set limit_overrides = coalesce(p_limits, '{}'), feature_overrides = coalesce(p_features, '{}'), updated_at = now()
   where organization_id = p_org;
  perform app.log_platform('subscription.overrides', p_org, jsonb_build_object(
    'old', v_old, 'new', jsonb_build_object('limits', p_limits, 'features', p_features), 'reason', left(p_reason, 500)));
end;
$$;
