-- CAP-02 (owner, 12 October 2026): more campaign parameters, from a closed list,
-- kept together in one general place.
--
-- The list: Google's newer UTM parameters (utm_id, utm_source_platform,
-- utm_creative_format, utm_marketing_tactic) and the ad click ids of Microsoft
-- (msclkid), TikTok (ttclid), LinkedIn (li_fat_id) and Google (gbraid, wbraid).
-- Nothing else is kept; an unknown key is dropped as before.
--
-- * The extra UTM values follow the rule of the five classic ones (control
--   characters removed, trimmed, at most 200 characters); the extra click ids
--   the rule of gclid / fbclid / ctwa_clid (1..500 characters of A-Z a-z 0-9 . _ ~ -).
-- * app.intake_attribution() returns them under one key, 'extra' (only when one
--   is there). On a new lead they are stored inside the existing jsonb column
--   leads.utm as utm.extra; on a repeat inquiry they travel inside the activity's
--   metadata.attribution like the rest. No new column, no grant change.
-- * They count as campaign parameters: app.campaign_only_url() keeps them on the
--   landing page address.
--
-- Mirrors src/features/intake/attribution.ts (EXTRA_UTM_KEYS, EXTRA_CLICK_ID_KEYS,
-- CAMPAIGN_KEYS, parseAttribution(), campaignOnlyUrl()); keep the lists identical.
--
-- create or replace only, same signatures, grants set again. intake_submit() is
-- the definition of migration 0054 with one change: the utm object gets 'extra'.
-- Leads already stored are not rewritten. Safe to run twice.

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
         'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ctwa_clid',
         'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
         'msclkid', 'ttclid', 'li_fat_id', 'gbraid', 'wbraid'
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
      if char_length(v_value) <= 2000 and v_value ~* '^https?://[^[:space:][:cntrl:]]+$' then
        v_out := v_out || jsonb_build_object(v_key, v_value);
      end if;
    end if;
  end loop;
  return v_out;
end;
$$;

revoke all on function app.intake_attribution(jsonb) from public, anon, authenticated;

create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_phone_e164 text;
  -- matched lead (and the contact it became) or matched contact
  v_lead_match uuid;
  v_lead_owner uuid;
  v_lead_contact uuid;
  v_contact_match uuid;
  v_contact_owner uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
  -- CAP-02 / ADS-01: where the visit came from (cleaned, known keys only)
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  -- CAP-01: custom values as sent, and what is kept of them
  v_custom_in jsonb := case when jsonb_typeof(p_payload -> 'custom') = 'object' then p_payload -> 'custom' else '{}'::jsonb end;
  v_custom jsonb := '{}'::jsonb;
  -- values of the shown fields by form key, for the conditions of later fields
  v_values jsonb := '{}'::jsonb;
  v_shown text[] := '{}';
  v_value jsonb;
  v_cond jsonb;
  v_type text;
  v_options jsonb;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam', coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  -- CAP-01: the form's fields in order. A hidden field loses its value and is
  -- never required; a shown custom field must hold a valid value.
  if v_form.kind = 'form' then
    for v_field in
      select a.value from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end) a
    loop
      continue when jsonb_typeof(v_field) <> 'object';
      v_key := v_field ->> 'key';
      continue when v_key is null or v_key = any (v_shown);
      v_type := null;
      v_options := null;
      if v_key like 'cf:%' then
        select d.field_type, d.options into v_type, v_options
          from public.field_definitions d
         where d.organization_id = v_form.organization_id and d.object_type = 'lead'
           and d.key = substr(v_key, 4) and d.is_active;
        -- a field that is gone, switched off or picks a team member is not on the form
        continue when v_type is null or v_type = 'user';
        v_value := v_custom_in -> substr(v_key, 4);
      elsif v_key = 'full_name' then v_value := to_jsonb(v_full_name);
      elsif v_key = 'phone' then v_value := to_jsonb(v_phone);
      elsif v_key = 'email' then v_value := to_jsonb(v_email);
      elsif v_key = 'company_name' then v_value := to_jsonb(v_company);
      elsif v_key = 'message' then v_value := to_jsonb(v_message);
      else
        continue;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;

      v_cond := v_field -> 'show_if';
      if jsonb_typeof(v_cond) = 'object'
         and not coalesce((v_cond ->> 'field') = any (v_shown)
                          and app.intake_condition_met(v_values -> (v_cond ->> 'field'), v_cond ->> 'value'), false) then
        -- hidden: whatever was sent for it is dropped
        if v_key = 'full_name' then v_full_name := null;
        elsif v_key = 'phone' then v_phone := null;
        elsif v_key = 'email' then v_email := null;
        elsif v_key = 'company_name' then v_company := null;
        elsif v_key = 'message' then v_message := null;
        end if;
        continue;
      end if;

      v_shown := v_shown || v_key;
      if v_type is not null and app.intake_has_value(v_value) then
        if not app.custom_value_ok(v_type, v_options, v_value) then
          raise exception 'invalid custom field: %', substr(v_key, 4) using errcode = '22023';
        end if;
        v_custom := v_custom || jsonb_build_object(substr(v_key, 4), v_value);
      end if;
      if app.intake_has_value(v_value) then
        v_values := v_values || jsonb_build_object(v_key, v_value);
      end if;
      if v_field -> 'required' = 'true'::jsonb and not app.intake_has_value(v_value) then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
    from public.leads l
   where l.organization_id = v_form.organization_id and l.deleted_at is null
     and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
          or (v_email is not null and lower(l.email) = v_email))
   order by l.created_at desc
   limit 1;
  if v_lead_match is null then
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and ((v_phone_e164 is not null and c.phone_e164 = v_phone_e164)
            or (v_email is not null and lower(c.email) = v_email))
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead_match is not null or v_contact_match is not null then
    -- first touch wins: the lead keeps its attribution and custom fields;
    -- this visit's are kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end);
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים',
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  select s.id into v_status from public.lead_statuses s
   where s.organization_id = v_form.organization_id and s.kind = 'open'
   order by s.is_default desc, s.position
   limit 1;
  if v_status is null then
    raise exception 'the organization has no open lead status' using errcode = 'P0001';
  end if;

  if v_form.assign_mode = 'round_robin' then
    v_owner := app.next_lead_owner(v_form.organization_id, v_form.team_id);
  end if;
  if v_owner is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
  end if;

  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_form.team_id,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content',
            -- CAP-02: the extra parameters of the closed list, in one place
            'extra', v_attr -> 'extra')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid',
          v_custom)
  returning id into v_lead;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;

revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;
