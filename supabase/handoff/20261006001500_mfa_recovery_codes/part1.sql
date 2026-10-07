-- 20261006001500_mfa_recovery_codes: part 1 of 2. Run the parts in order.
-- =============================================================================
-- 0015 Backup codes for two-step verification
-- =============================================================================
-- Supabase MFA has no recovery codes, so a user who lost their authenticator app
-- was locked out for good. Here:
-- * public.mfa_recovery_codes_create(): 10 one-time codes, shown once. Only a
--   session that has passed two-step verification may create them; new codes
--   replace the old ones.
-- * public.mfa_recover(code): with the password (any signed-in session) plus one
--   unused code, the user's authenticator is removed, so they can get in and set
--   up a new one (an organization that requires it sends them straight to setup).
--   Five wrong codes in 15 minutes block further tries for a while.
-- * Codes are stored only as SHA-256 hashes, in schema app (not reachable from
--   the API). Each use is written to the audit log of the user's organizations.
-- Every statement is safe to run twice.

create table if not exists app.mfa_recovery_codes (
  user_id    uuid not null references auth.users (id) on delete cascade,
  code_hash  text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  primary key (user_id, code_hash)
);

create table if not exists app.mfa_recovery_attempts (
  user_id      uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists mfa_recovery_attempts_user_idx on app.mfa_recovery_attempts (user_id, attempted_at);

revoke all on app.mfa_recovery_codes, app.mfa_recovery_attempts from public, anon, authenticated;

-- 12 hex digits (48 random bits), compared without dashes, spaces or case
create or replace function app.recovery_code_hash(p_user uuid, p_code text) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_user::text || ':' || regexp_replace(lower(coalesce(p_code, '')), '[^0-9a-f]', '', 'g'), 'UTF8')), 'hex');
$$;

create or replace function public.mfa_recovery_codes_create() returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_codes text[] := '{}';
  v_raw   text;
begin
  if v_user is null or app.session_aal() <> 'aal2' or not app.has_verified_factor() then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa:aal2_required';
  end if;
  delete from app.mfa_recovery_codes where user_id = v_user;
  for i in 1..10 loop
    -- the first 12 hex digits of a v4 UUID are all random
    v_raw := left(replace(gen_random_uuid()::text, '-', ''), 12);
    v_codes := v_codes || (substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4) || '-' || substr(v_raw, 9, 4));
    insert into app.mfa_recovery_codes (user_id, code_hash) values (v_user, app.recovery_code_hash(v_user, v_raw))
      on conflict do nothing;
  end loop;
  return to_jsonb(v_codes);
end;
$$;

create or replace function public.mfa_recovery_codes_status() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'remaining', case when app.has_verified_factor()
                   then (select count(*) from app.mfa_recovery_codes c where c.user_id = auth.uid() and c.used_at is null)
                   else 0 end,
    'created_at', (select max(c.created_at) from app.mfa_recovery_codes c where c.user_id = auth.uid()));
$$;
