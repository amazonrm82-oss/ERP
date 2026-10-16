-- =============================================================================
-- View seats: the plan's allowance per paid seat (PRM-02)
-- =============================================================================
-- Owner's pricing of 13 October 2026 (DECISIONS.md): view seats are a capability from "מקצועי" up (flag
-- view_seats, already enforced since 0001) and are free up to view_seats_per_paid_seat for every paid seat
-- (0 / 0 / 1 / 1). A paid seat is an active full seat, as for max_booking_pages_per_user (CAL-10).
-- * app.view_seat_cap(org, exclude): view_seats_per_paid_seat x active full seats other than `exclude`; null = no
--   limit (a plan or override without the key keeps the fallback of app.org_limit). Internal, no grants: only the
--   two security definer functions below call it.
-- * app.assert_view_seat_available(org, membership): an active view seat is added (insert, invitation accepted,
--   a member made a viewer, a suspended viewer reactivated) only while active view seats other than this one are
--   below the cap; hint 'limit:view_seats_per_paid_seat'. It takes the same subscription row lock as
--   app.assert_seat_available, so two additions cannot both pass. Seats already over the cap (a paid seat removed
--   later) stay; nothing is suspended automatically.
-- * app.guard_membership() (body of owner_promotes_admins, 0006, plus the call above).
-- * public.org_plan_usage() (body of price_lists, 0164) lists 'view_seats' while the plan has the flag.
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.view_seat_cap(p_org uuid, p_exclude uuid) returns integer
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_per numeric := app.org_limit(p_org, 'view_seats_per_paid_seat');
  v_full integer;
begin
  if v_per is null then
    return null;
  end if;
  select count(*) into v_full
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full'
     and m.id is distinct from p_exclude;
  return floor(v_per * v_full)::integer;
end;
$$;
revoke all on function app.view_seat_cap(uuid, uuid) from public, anon, authenticated;

create or replace function app.assert_view_seat_available(p_org uuid, p_membership uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_cap integer;
  v_used integer;
begin
  -- serialize seat changes per organization (the lock app.assert_seat_available takes)
  perform 1 from public.subscriptions s where s.organization_id = p_org for update;
  v_cap := app.view_seat_cap(p_org, p_membership);
  if v_cap is null then
    return;
  end if;
  select count(*) into v_used
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'view'
     and m.id <> p_membership;
  if v_used + 1 > v_cap then
    raise exception 'no free view seats (% allowed)', v_cap using errcode = 'P0001', hint = 'limit:view_seats_per_paid_seat';
  end if;
end;
$$;
revoke all on function app.assert_view_seat_available(uuid, uuid) from public, anon;
-- app.guard_membership() is security invoker: a person's membership write calls this as the person
grant execute on function app.assert_view_seat_available(uuid, uuid) to authenticated, service_role;

-- body of owner_promotes_admins (0006), plus PRM-02's view seat allowance
create or replace function app.guard_membership() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'DELETE' then
    if v_client then
      -- the organization row is already gone when this fires from its cascade
      if old.role = 'owner' and app.org_exists(old.organization_id) then
        raise exception 'the owner cannot be removed; transfer ownership first' using errcode = '42501';
      end if;
      if old.role = 'admin' and old.user_id <> auth.uid()
         and app.role_in(old.organization_id) = 'admin' then
        raise exception 'only the owner can remove another admin' using errcode = '42501';
      end if;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'user_id cannot be changed' using errcode = '42501';
    end if;
    if v_client then
      -- ownership moves only through public.transfer_ownership()
      if (old.role = 'owner') <> (new.role = 'owner') then
        raise exception 'ownership changes only through transfer_ownership()' using errcode = '42501';
      end if;
      if old.role = 'owner' and new.status <> 'active' then
        raise exception 'the owner cannot be suspended' using errcode = '42501';
      end if;
      -- nobody changes their own role, seat or status
      if old.user_id = auth.uid()
         and (new.role is distinct from old.role or new.status is distinct from old.status
              or new.seat_type is distinct from old.seat_type) then
        raise exception 'you cannot change your own role, seat or status' using errcode = '42501';
      end if;
      if old.role = 'admin' and old.user_id <> auth.uid()
         and app.role_in(new.organization_id) = 'admin' then
        raise exception 'only the owner can change another admin' using errcode = '42501';
      end if;
      -- same rule as create_invitation(): only the owner adds admins
      if new.role = 'admin' and old.role <> 'admin'
         and app.role_in(new.organization_id) is distinct from 'owner' then
        raise exception 'only the owner can make someone an admin' using errcode = '42501';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' and v_client and new.role = 'owner' then
    raise exception 'an owner is created only with the organization' using errcode = '42501';
  end if;

  -- seat limit: counts active full seats
  if new.status = 'active' and new.seat_type = 'full'
     and (tg_op = 'INSERT' or old.status <> 'active' or old.seat_type <> 'full') then
    perform app.assert_seat_available(new.organization_id, new.id);
  end if;

  -- view seats need the feature
  if new.seat_type = 'view' and (tg_op = 'INSERT' or old.seat_type <> 'view')
     and not app.org_has_feature(new.organization_id, 'view_seats') then
    raise exception 'view-only seats are not included in this plan' using errcode = 'P0001', hint = 'feature:view_seats';
  end if;

  -- PRM-02: an active view seat needs room in the plan's allowance (view seats per paid seat)
  if new.status = 'active' and new.seat_type = 'view'
     and (tg_op = 'INSERT' or old.status <> 'active' or old.seat_type <> 'view') then
    perform app.assert_view_seat_available(new.organization_id, new.id);
  end if;

  return new;
end;
$$;

-- body of price_lists (0164), plus PRM-02's view seats
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
        'used', round(coalesce((select sum(fl.size_bytes) from public.files fl where fl.organization_id = p_org), 0) / 1073741824.0, 3)),
      jsonb_build_object('key', 'max_products', 'limit', app.org_limit(p_org, 'max_products'),
        'used', (select count(*) from public.products pr where pr.organization_id = p_org)),
      jsonb_build_object('key', 'max_price_lists', 'limit', app.org_limit(p_org, 'max_price_lists'),
        'used', (select count(*) from public.price_lists pli where pli.organization_id = p_org))
    )
    -- PRM-02: view seats, while the plan has them (limit = per paid seat x active paid seats; null = no limit)
    || case when app.org_has_feature(p_org, 'view_seats') then jsonb_build_array(
         jsonb_build_object('key', 'view_seats', 'limit', app.view_seat_cap(p_org, null),
           'used', (select count(*) from public.memberships m
                     where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'view')))
       else '[]'::jsonb end
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

notify pgrst, 'reload schema';
