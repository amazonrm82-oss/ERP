-- 20261006001600_mfa_reset_and_agreement: part 4 of 5. Run the parts in order.
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
