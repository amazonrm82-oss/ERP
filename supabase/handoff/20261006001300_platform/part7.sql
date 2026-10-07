-- 20261006001300_platform: part 7 of 11. Run the parts in order.
-- suspend, restore, make read-only... (owner only)
create or replace function public.platform_set_org_status(p_org uuid, p_status public.org_status, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.org_status;
begin
  perform app.require_platform(array[]::text[]);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select o.status into v_old from public.organizations o where o.id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  update public.organizations set status = p_status where id = p_org;
  perform app.log_platform('organization.status', p_org,
    jsonb_build_object('old', v_old, 'new', p_status, 'reason', left(p_reason, 500)));
end;
$$;

-- edit a plan without a deploy (owner only)
create or replace function public.platform_update_plan(
  p_key text, p_name_he text, p_price_monthly_agorot integer, p_price_annual_agorot integer,
  p_limits jsonb, p_features jsonb, p_is_public boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
begin
  perform app.require_platform(array[]::text[]);
  if coalesce(btrim(p_name_he), '') = '' or p_price_monthly_agorot < 0 or p_price_annual_agorot < 0
     or jsonb_typeof(p_limits) <> 'object' or jsonb_typeof(p_features) <> 'object' then
    raise exception 'invalid plan' using errcode = '22023';
  end if;
  select to_jsonb(p) into v_old from public.plans p where p.key = p_key;
  if v_old is null then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
  update public.plans
     set name_he = btrim(p_name_he), price_monthly_agorot = p_price_monthly_agorot, price_annual_agorot = p_price_annual_agorot,
         limits = p_limits, features = p_features, is_public = coalesce(p_is_public, true)
   where key = p_key;
  perform app.log_platform('plan.update', null, jsonb_build_object('key', p_key, 'old', v_old));
end;
$$;
