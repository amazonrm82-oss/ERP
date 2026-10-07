-- 20261006001600_mfa_reset_and_agreement: part 2 of 5. Run the parts in order.
-- members of the organization who have two-step verification on (admins only)
create or replace function public.org_members_mfa(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not app.is_admin(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(distinct m.user_id)
      from public.memberships m
      join auth.mfa_factors f on f.user_id = m.user_id and f.status::text = 'verified'
     where m.organization_id = p_org), '[]'::jsonb);
end;
$$;

create or replace function public.org_reset_member_mfa(p_org uuid, p_user uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_me     public.membership_role := app.membership_role(p_org);
  v_target public.membership_role;
begin
  if v_me is null or v_me not in ('owner', 'admin') then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if app.session_aal() <> 'aal2' then
    raise exception 'turn on two-step verification for yourself first' using errcode = 'P0001', hint = 'mfa:self_first';
  end if;
  if p_user = auth.uid() then
    raise exception 'use your own account page' using errcode = '42501';
  end if;
  select m.role into v_target from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_target is null or v_target = 'owner' or (v_target = 'admin' and v_me <> 'owner') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if exists (select 1 from public.memberships m
              where m.user_id = p_user and m.status = 'active' and m.organization_id <> p_org) then
    raise exception 'the user belongs to other organizations' using errcode = 'P0001', hint = 'mfa_reset:other_orgs';
  end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status::text = 'verified') then
    raise exception 'two-step verification is not on' using errcode = 'P0001', hint = 'mfa_reset:none';
  end if;
  perform app.reset_user_mfa(p_user, 'admin');
end;
$$;
