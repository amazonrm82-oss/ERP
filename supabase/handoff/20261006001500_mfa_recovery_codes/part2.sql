-- 20261006001500_mfa_recovery_codes: part 2 of 2. Run the parts in order.
-- when the user turns two-step verification off, their codes go with it
create or replace function public.mfa_recovery_codes_clear() returns void
language sql volatile security definer
set search_path = ''
as $$
  delete from app.mfa_recovery_codes where user_id = auth.uid();
$$;

create or replace function public.mfa_recover(p_code text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_hash text;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not app.has_verified_factor() then
    return jsonb_build_object('ok', false, 'reason', 'no_factor');
  end if;

  -- answers (not exceptions), so the counted attempt is kept
  delete from app.mfa_recovery_attempts where user_id = v_user and attempted_at < now() - interval '1 day';
  if (select count(*) from app.mfa_recovery_attempts a
       where a.user_id = v_user and a.attempted_at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  insert into app.mfa_recovery_attempts (user_id) values (v_user);

  v_hash := app.recovery_code_hash(v_user, p_code);
  update app.mfa_recovery_codes set used_at = now()
   where user_id = v_user and code_hash = v_hash and used_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'wrong');
  end if;

  -- the lost authenticator is removed (its challenges go with it); the remaining
  -- codes belonged to it and are removed too
  delete from auth.mfa_factors where user_id = v_user;
  delete from app.mfa_recovery_codes where user_id = v_user;
  delete from app.mfa_recovery_attempts where user_id = v_user;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  select m.organization_id, v_user, 'mfa_recovery', 'memberships', m.id, '{}'::jsonb
    from public.memberships m
   where m.user_id = v_user and m.status = 'active';

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function app.recovery_code_hash(uuid, text) from public, anon, authenticated;
revoke all on function public.mfa_recovery_codes_create() from public, anon;
revoke all on function public.mfa_recovery_codes_status() from public, anon;
revoke all on function public.mfa_recovery_codes_clear() from public, anon;
revoke all on function public.mfa_recover(text) from public, anon;
grant execute on function public.mfa_recovery_codes_create() to authenticated;
grant execute on function public.mfa_recovery_codes_status() to authenticated;
grant execute on function public.mfa_recovery_codes_clear() to authenticated;
grant execute on function public.mfa_recover(text) to authenticated;
