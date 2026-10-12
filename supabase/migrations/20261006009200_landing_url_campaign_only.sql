-- CAP-02 (owner, 12 October 2026): the landing page address of a lead is stored
-- only with its campaign parameters (utm_* and the click ids gclid, fbclid,
-- ctwa_clid). Every other query parameter, the fragment and any user info
-- (user:pass@) are removed, so a credential, a token, an email or a session id
-- in a customer's page address never lands in the CRM.
--
-- The app strips the address before it calls intake_submit()
-- (src/features/intake/attribution.ts, campaignOnlyUrl()), and the database does it
-- again here, so a caller of the function cannot bypass it. The two follow the same
-- plain text rules; keep them in step.
--
-- Only app.intake_attribution() changes (create or replace, same signature, same
-- grants); intake_submit() calls it and is unchanged. Addresses already stored are
-- not rewritten. Safe to run twice.

create or replace function app.campaign_only_url(p text) returns text
language sql immutable
set search_path = ''
as $$
  with parts as (
    -- the fragment and any user info (scheme://user:pass@) go first
    select regexp_replace(split_part(p, '#', 1), '^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@', '\1') as base
  )
  select case
    when p is null then null
    when position('?' in parts.base) = 0 then parts.base
    else split_part(parts.base, '?', 1) || coalesce('?' || (
      select string_agg(t.part, '&' order by t.n)
        from regexp_split_to_table(substr(parts.base, position('?' in parts.base) + 1), '&') with ordinality as t(part, n)
       where split_part(t.part, '=', 1) = any (array[
         'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ctwa_clid'
       ])
    ), '')
  end
  from parts
$$;

revoke all on function app.campaign_only_url(text) from public, anon, authenticated;

create or replace function app.intake_attribution(p jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_value text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return v_out;
  end if;
  foreach v_key in array array['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] loop
    if jsonb_typeof(p -> v_key) = 'string' then
      v_value := nullif(btrim(left(btrim(regexp_replace(p ->> v_key, '[[:cntrl:]]', '', 'g')), 200)), '');
      if v_value is not null then
        v_out := v_out || jsonb_build_object(v_key, v_value);
      end if;
    end if;
  end loop;
  foreach v_key in array array['gclid', 'fbclid', 'ctwa_clid'] loop
    if jsonb_typeof(p -> v_key) = 'string' then
      v_value := btrim(p ->> v_key);
      if char_length(v_value) between 1 and 500 and v_value ~ '^[A-Za-z0-9._~-]+$' then
        v_out := v_out || jsonb_build_object(v_key, v_value);
      end if;
    end if;
  end loop;
  foreach v_key in array array['referrer_url', 'landing_url'] loop
    if jsonb_typeof(p -> v_key) = 'string' then
      v_value := btrim(p ->> v_key);
      -- CAP-02: the landing page keeps only its campaign parameters
      if v_key = 'landing_url' then
        v_value := app.campaign_only_url(v_value);
      end if;
      if char_length(v_value) <= 2000 and v_value ~* '^https?://[^[:space:][:cntrl:]]+$' then
        v_out := v_out || jsonb_build_object(v_key, v_value);
      end if;
    end if;
  end loop;
  return v_out;
end;
$$;

revoke all on function app.intake_attribution(jsonb) from public, anon, authenticated;
