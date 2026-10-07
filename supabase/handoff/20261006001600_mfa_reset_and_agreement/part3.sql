-- 20261006001600_mfa_reset_and_agreement: part 3 of 5. Run the parts in order.
-- platform support: look a user up by email, to check who is asking
create or replace function public.platform_find_user(p_email text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
begin
  perform app.require_platform(array['support', 'readonly']);
  select * into v_user from auth.users u where lower(u.email) = lower(trim(p_email));
  if v_user.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_user.id,
    'email', v_user.email,
    'name', (select p.full_name from public.profiles p where p.id = v_user.id),
    'created_at', v_user.created_at,
    'last_sign_in_at', v_user.last_sign_in_at,
    'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = v_user.id and f.status::text = 'verified'),
    'codes_left', (select count(*) from app.mfa_recovery_codes c where c.user_id = v_user.id and c.used_at is null),
    'platform_role', (select s.role from app.platform_staff s where s.user_id = v_user.id),
    'orgs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'name', o.name, 'role', m.role, 'status', m.status, 'require_mfa', o.require_mfa,
               'owner_email', (select ou.email from public.memberships om join auth.users ou on ou.id = om.user_id
                                where om.organization_id = o.id and om.role = 'owner' limit 1))
             order by o.name)
        from public.memberships m join public.organizations o on o.id = m.organization_id
       where m.user_id = v_user.id), '[]'::jsonb),
    'signed_version', (select s.version from app.agreement_signatures s where s.user_id = v_user.id order by s.signed_at desc limit 1));
end;
$$;

create or replace function public.platform_reset_mfa(p_user uuid, p_reason text, p_check text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role text := app.require_platform(array['support']);
  v_email text;
begin
  if coalesce(trim(p_reason), '') = '' or p_check is null
     or p_check not in ('org_admin_confirmed', 'account_email_and_details', 'video_id') then
    raise exception 'a reason and an identity check are required' using errcode = '22023';
  end if;
  select u.email into v_email from auth.users u where u.id = p_user;
  if v_email is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  if p_user = auth.uid() then
    raise exception 'not for your own account' using errcode = '42501';
  end if;
  -- the platform's own owners are reset only by another owner
  if exists (select 1 from app.platform_staff s where s.user_id = p_user and s.role = 'owner') and v_role <> 'owner' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status::text = 'verified') then
    raise exception 'two-step verification is not on' using errcode = 'P0001', hint = 'mfa_reset:none';
  end if;
  perform app.reset_user_mfa(p_user, 'support');
  perform app.log_platform('user.mfa_reset', null,
    jsonb_build_object('user_id', p_user, 'email', v_email, 'reason', trim(p_reason), 'check', p_check));
end;
$$;
