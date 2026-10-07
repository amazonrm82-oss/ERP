-- 20261006001300_platform: part 9 of 11. Run the parts in order.
-- the internal team (owner only)
create or replace function public.platform_staff_list() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array[]::text[]);
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'role', s.role, 'email', u.email,
                                                       'name', p.full_name, 'created_at', s.created_at) order by s.created_at)
                     from app.platform_staff s join auth.users u on u.id = s.user_id
                     left join public.profiles p on p.id = s.user_id), '[]'::jsonb);
end;
$$;

-- add or change a team member by email; role null removes them. The last owner cannot leave.
create or replace function public.platform_set_staff(p_email text, p_role text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  perform app.require_platform(array[]::text[]);
  if p_role is not null and p_role not in ('owner', 'support', 'finance', 'readonly') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'no user with this email; they must sign up first' using errcode = 'P0002';
  end if;
  if (p_role is null or p_role <> 'owner')
     and exists (select 1 from app.platform_staff s where s.user_id = v_user and s.role = 'owner')
     and (select count(*) from app.platform_staff s where s.role = 'owner') = 1 then
    raise exception 'the last platform owner cannot be removed' using errcode = 'P0001', hint = 'platform:last_owner';
  end if;
  if p_role is null then
    delete from app.platform_staff where user_id = v_user;
  else
    insert into app.platform_staff (user_id, role, created_by) values (v_user, p_role, auth.uid())
    on conflict (user_id) do update set role = excluded.role;
  end if;
  perform app.log_platform('staff.set', null, jsonb_build_object('email', lower(btrim(p_email)), 'role', p_role));
end;
$$;

create or replace function public.platform_log_list(p_org uuid default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return coalesce((
    select jsonb_agg(x order by x.id desc) from (
      select l.id, l.action, l.organization_id, o.name as organization_name, l.details, l.created_at, u.email as actor_email
        from app.platform_log l
        left join auth.users u on u.id = l.actor_id
        left join public.organizations o on o.id = l.organization_id
       where p_org is null or l.organization_id = p_org
       order by l.id desc
       limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end;
$$;
