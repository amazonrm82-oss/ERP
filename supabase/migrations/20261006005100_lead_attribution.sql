-- =============================================================================
-- 0051 Where a lead came from: UTM, referrer, landing page, ad click ids
--      (CAP-02, ADS-01)
-- =============================================================================
-- The public form and the webhook now send what they know about the visit
-- (utm_*, gclid / fbclid / ctwa_clid, the referring page and the landing page)
-- inside p_payload as an object under the key 'attribution'. intake_submit()
-- cleans it with app.intake_attribution() and stores it on a new lead:
-- * the five utm_* values in the existing leads.utm (jsonb), utm_campaign also
--   in the existing leads.campaign;
-- * the page addresses and the click ids in new columns.
-- meta_lead_id is the Meta Lead Ads id (CAP-11, wave 3); the column exists now
-- so it is there before anything reports back to the ad platforms (ADS-02/03).
--
-- First touch wins: a repeat inquiry (an existing lead or contact) never changes
-- the lead's attribution; what that visit brought is kept on the inquiry
-- activity (metadata.attribution) instead.
--
-- The new columns are written by the intake only: no insert/update grant to
-- authenticated (select stays table-wide, so members read them as before).
-- form_submissions.payload still keeps only the five fields (migration 0036).
--
-- The signature of intake_submit() is unchanged, so its grants (service_role
-- only) carry over; they are set again below anyway. Every statement is safe
-- to run twice.

alter table public.leads add column if not exists referrer_url text;
alter table public.leads add column if not exists landing_url  text;
alter table public.leads add column if not exists gclid        text;
alter table public.leads add column if not exists fbclid       text;
alter table public.leads add column if not exists ctwa_clid    text;
alter table public.leads add column if not exists meta_lead_id text;

alter table public.leads drop constraint if exists leads_attribution_lengths;
alter table public.leads add constraint leads_attribution_lengths check (
  coalesce(char_length(referrer_url), 0) <= 2000
  and coalesce(char_length(landing_url), 0) <= 2000
  and coalesce(char_length(gclid), 0) <= 500
  and coalesce(char_length(fbclid), 0) <= 500
  and coalesce(char_length(ctwa_clid), 0) <= 500
  and coalesce(char_length(meta_lead_id), 0) <= 100
);

-- The attribution object as stored: known keys only, strings only, trimmed and
-- capped; page addresses must be http(s) URLs and click ids plain tokens,
-- anything else is dropped. Mirrors parseAttribution() in
-- src/features/intake/attribution.ts; keep the two in step.
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

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;
  if v_form.kind = 'form' then
    for v_field in select * from jsonb_array_elements(v_form.fields) loop
      v_key := v_field ->> 'key';
      if coalesce((v_field ->> 'required')::boolean, false)
         and nullif(btrim(coalesce(p_payload ->> v_key, '')), '') is null then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
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
    -- first touch wins: the lead keeps its attribution; this visit's is kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end);
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
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_form.team_id,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid')
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
