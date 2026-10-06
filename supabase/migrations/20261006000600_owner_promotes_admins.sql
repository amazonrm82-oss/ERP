-- =============================================================================
-- 0006 Only the owner promotes a member to admin
-- =============================================================================
-- create_invitation() already lets only the owner invite an admin, but a direct
-- UPDATE of memberships let an admin promote any member to admin. This brings
-- the two paths in line. Same function as in 0001 plus one check.

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

  return new;
end;
$$;
