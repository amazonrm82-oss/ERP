-- CAP-02 (owner, 12 October 2026): the referrer (the page the visitor came from)
-- is stored as site and path only. The query, the fragment and any user info
-- (user:pass@) are removed, so a search phrase, a token or an email in the
-- address of the referring page never lands in the CRM.
--
-- The app strips it before it calls intake_submit()
-- (src/features/intake/attribution.ts, siteAndPathUrl()), and the database does it
-- again here, so a caller of the function cannot bypass it. The two follow the same
-- plain text rules; keep them in step.
--
-- Only app.intake_attribution() changes (create or replace, same signature, same
-- grants; otherwise as in migration more_campaign_params), plus the new helper
-- app.site_and_path_url(). intake_submit() is unchanged. Referrers already stored
-- are not rewritten. Safe to run twice.

create or replace function app.site_and_path_url(p text) returns text
language sql immutable
set search_path = ''
as $$
  -- the fragment, then the query, then any user info (scheme://user:pass@)
  select regexp_replace(split_part(split_part(p, '#', 1), '?', 1), '^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@', '\1')
$$;

revoke all on function app.site_and_path_url(text) from public, anon, authenticated;

create or replace function app.intake_attribution(p jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_extra jsonb := '{}'::jsonb;
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
  -- CAP-02: the closed list of extra parameters, kept together under 'extra'
  foreach v_key in array array['utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic'] loop
    if jsonb_typeof(p -> v_key) = 'string' then
      v_value := nullif(btrim(left(btrim(regexp_replace(p ->> v_key, '[[:cntrl:]]', '', 'g')), 200)), '');
      if v_value is not null then
        v_extra := v_extra || jsonb_build_object(v_key, v_value);
      end if;
    end if;
  end loop;
  foreach v_key in array array['msclkid', 'ttclid', 'li_fat_id', 'gbraid', 'wbraid'] loop
    if jsonb_typeof(p -> v_key) = 'string' then
      v_value := btrim(p ->> v_key);
      if char_length(v_value) between 1 and 500 and v_value ~ '^[A-Za-z0-9._~-]+$' then
        v_extra := v_extra || jsonb_build_object(v_key, v_value);
      end if;
    end if;
  end loop;
  if v_extra <> '{}'::jsonb then
    v_out := v_out || jsonb_build_object('extra', v_extra);
  end if;
  foreach v_key in array array['referrer_url', 'landing_url'] loop
    if jsonb_typeof(p -> v_key) = 'string' then
      v_value := btrim(p ->> v_key);
      -- CAP-02: the landing page keeps only its campaign parameters
      if v_key = 'landing_url' then
        v_value := app.campaign_only_url(v_value);
      end if;
      -- CAP-02: the referrer keeps only site and path
      if v_key = 'referrer_url' then
        v_value := app.site_and_path_url(v_value);
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
