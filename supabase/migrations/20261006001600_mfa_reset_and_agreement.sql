-- =============================================================================
-- 0016 Two-step verification reset, and the signed agreement
-- =============================================================================
-- Reset, for a user who lost both the authenticator and the backup codes:
-- * public.org_reset_member_mfa(org, user): the organization's owner or an admin,
--   in a session that passed two-step verification, resets a member they manage
--   (only the owner resets an admin). Only when the member belongs to no other
--   organization: one business must not weaken a user's security in another.
-- * public.platform_reset_mfa(user, reason, check): platform support, for everyone
--   else (an owner, a user of several businesses), after checking identity by one
--   of the listed methods. Written to the permanent platform log.
-- * Both remove the authenticator and the backup codes, sign the user out of every
--   device, write to the audit log of each of the user's organizations, and notify
--   the user and the organizations' owners and admins.
-- Agreement:
-- * app.agreement_signatures: each user signs the terms, privacy policy and data
--   processing agreement before using the product, and again when they change.
--   The row keeps the full text that was signed, its SHA-256, the signature (drawn
--   image or typed name), time, IP and browser. It cannot be changed or deleted
--   through the API. public.sign_agreement() writes it; public.my_agreement() and
--   public.agreement_status() read it.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Two-step verification reset
-- ----------------------------------------------------------------------------
create or replace function app.reset_user_mfa(p_user uuid, p_by text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  delete from auth.mfa_factors where user_id = p_user;
  delete from app.mfa_recovery_codes where user_id = p_user;
  delete from app.mfa_recovery_attempts where user_id = p_user;
  -- signed out everywhere: whoever holds a session now must sign in again
  delete from auth.sessions where user_id = p_user;

  select coalesce(nullif(p.full_name, ''), u.email) into v_name
    from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  select m.organization_id, auth.uid(), 'mfa_reset', 'memberships', m.id, jsonb_build_object('by', p_by)
    from public.memberships m
   where m.user_id = p_user and m.status = 'active';

  -- the user, and the owners and admins of their organizations
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, a.user_id, 'system',
         case when a.user_id = p_user then 'האימות הדו-שלבי בחשבון שלך אופס'
              else 'האימות הדו-שלבי של ' || v_name || ' אופס' end,
         case when p_by = 'support' then 'האיפוס בוצע על ידי צוות התמיכה.' else 'האיפוס בוצע על ידי מנהל בעסק.' end
           || ' אם לא ביקשתם את זה, פנו מייד לתמיכה.'
    from public.memberships m
    join public.memberships a on a.organization_id = m.organization_id and a.status = 'active'
                              and (a.user_id = p_user or a.role in ('owner', 'admin'))
   where m.user_id = p_user and m.status = 'active'
     and a.user_id is distinct from auth.uid();
end;
$$;

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

-- ----------------------------------------------------------------------------
-- The signed agreement
-- ----------------------------------------------------------------------------
create table if not exists app.agreement_signatures (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  version      text not null check (char_length(version) between 1 and 40),
  -- the documents exactly as shown: [{ slug, title, text }]
  documents    jsonb not null check (jsonb_typeof(documents) = 'array'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  full_name    text not null check (char_length(trim(full_name)) between 2 and 120),
  method       text not null check (method in ('drawn', 'typed')),
  -- a PNG data URL for a drawn signature; null for a typed one
  signature    text check (signature is null or (signature like 'data:image/png;base64,%' and char_length(signature) <= 400000)),
  ip           text,
  user_agent   text,
  signed_at    timestamptz not null default now(),
  check ((method = 'drawn') = (signature is not null))
);
create index if not exists agreement_signatures_user_idx on app.agreement_signatures (user_id, signed_at desc);
revoke all on app.agreement_signatures from public, anon, authenticated;

-- the hash is computed here, from the text as stored, so it can be checked later
create or replace function public.sign_agreement(
  p_version text, p_documents jsonb, p_full_name text, p_method text, p_signature text
) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_id      uuid;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_documents is null or jsonb_typeof(p_documents) <> 'array' or jsonb_array_length(p_documents) = 0 then
    raise exception 'nothing to sign' using errcode = '22023';
  end if;
  insert into app.agreement_signatures (user_id, version, documents, content_hash, full_name, method, signature, ip, user_agent)
  values (v_user, p_version, p_documents, encode(sha256(convert_to(p_documents::text, 'UTF8')), 'hex'), trim(p_full_name), p_method,
          case when p_method = 'drawn' then p_signature end,
          left(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), 64),
          left(v_headers ->> 'user-agent', 400))
  returning id into v_id;
  return v_id;
end;
$$;

-- the version the caller signed last, or null
create or replace function public.agreement_status() returns text
language sql stable security definer
set search_path = ''
as $$
  select s.version from app.agreement_signatures s where s.user_id = auth.uid() order by s.signed_at desc limit 1;
$$;

-- the caller's last signed copy, in full
create or replace function public.my_agreement() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select to_jsonb(x) from (
    select s.id, s.version, s.documents, s.content_hash, s.full_name, s.method, s.signature, s.ip, s.user_agent, s.signed_at,
           (select u.email from auth.users u where u.id = s.user_id) as email
      from app.agreement_signatures s where s.user_id = auth.uid() order by s.signed_at desc limit 1) x;
$$;

revoke all on function app.reset_user_mfa(uuid, text) from public, anon, authenticated;
revoke all on function public.org_members_mfa(uuid) from public, anon;
revoke all on function public.org_reset_member_mfa(uuid, uuid) from public, anon;
revoke all on function public.platform_find_user(text) from public, anon;
revoke all on function public.platform_reset_mfa(uuid, text, text) from public, anon;
revoke all on function public.sign_agreement(text, jsonb, text, text, text) from public, anon;
revoke all on function public.agreement_status() from public, anon;
revoke all on function public.my_agreement() from public, anon;
grant execute on function public.org_members_mfa(uuid) to authenticated;
grant execute on function public.org_reset_member_mfa(uuid, uuid) to authenticated;
grant execute on function public.platform_find_user(text) to authenticated;
grant execute on function public.platform_reset_mfa(uuid, text, text) to authenticated;
grant execute on function public.sign_agreement(text, jsonb, text, text, text) to authenticated;
grant execute on function public.agreement_status() to authenticated;
grant execute on function public.my_agreement() to authenticated;
