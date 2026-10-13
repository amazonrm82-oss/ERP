-- =============================================================================
-- Hide the free plan (owner's decision of 8 October 2026, carried out 13 October)
-- =============================================================================
-- The free plan is cancelled: new businesses get a trial and then choose a paid
-- plan. The row stays (businesses and history may point at it) and keeps its
-- features; it is only hidden, and no business may be moved onto a hidden plan.
-- A business already on a hidden plan may keep it (seats or trial can still
-- change). The plans screen in the admin panel still edits the hidden row.
-- Every statement is safe to run twice.

update public.plans set is_public = false where key = 'free' and is_public;

-- platform_update_subscription: the body of 0013 (platform), plus the hidden-plan check
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
  -- a hidden plan (is_public = false) cannot be chosen; a business already on it may keep it
  if p_plan_key is distinct from (v_old ->> 'plan_key')
     and not exists (select 1 from public.plans p where p.key = p_plan_key and p.is_public) then
    raise exception 'this plan is no longer offered' using errcode = 'P0001', hint = 'plan:hidden';
  end if;
  update public.subscriptions
     set plan_key = p_plan_key, seats = p_seats, trial_ends_at = p_trial_ends_at, updated_at = now()
   where organization_id = p_org;
  perform app.log_platform('subscription.update', p_org, jsonb_build_object(
    'old', v_old, 'new', jsonb_build_object('plan_key', p_plan_key, 'seats', p_seats, 'trial_ends_at', p_trial_ends_at),
    'reason', left(p_reason, 500)));
end;
$$;
