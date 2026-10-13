-- =============================================================================
-- "When should we call you back?" on the public form (SPD-05, wave 1)
-- =============================================================================
-- * forms.callback_choice: the hosted form asks when to call back: "now", or a
--   slot today or tomorrow. Off by default. Written by owners and admins like the
--   other form settings (column grants; policies forms_insert / forms_update
--   unchanged); audited as a form change.
-- * The slots, in the business's time zone (organizations.timezone, else
--   Asia/Jerusalem): 09-12, 12-15, 15-18, 18-20, today or tomorrow. The choice
--   travels as 'now' or '<today|tomorrow>-<09|12|15|18>' (payload key 'callback');
--   src/features/intake/callback.ts holds the same list (a unit test compares).
--   app.intake_callback_at() turns it into a time: now for 'now', the slot's start,
--   or now for a slot that has started and not ended. A slot that has ended, or
--   anything else, is refused (22023, hint callback:past / callback:invalid), so
--   the person picks again; the form keeps what was typed.
--   Business hours are wave 2 (CAP-09): "now" at night is still "now".
-- * public.intake_form(): the body of 0106 plus 'callback': {time_zone} when the
--   form offers the choice, else null. Service role only.
-- * public.intake_submit(): the body of 0108 plus, when the form offers the choice
--   and the person made one (a choice sent to a form without it, or to a webhook,
--   is ignored):
--   - a call task (app.intake_callback_task) due at that time, for the new lead's
--     owner, or on a repeat inquiry for the existing lead's or contact's owner,
--     else the form's owner; either only while an active member who is not a
--     viewer; else nobody;
--     linked to the lead and/or the contact; high priority for "now"; a future slot
--     also reminds at its start (task reminders, migration 0010);
--   - the time in the body of the notifications: the new-lead one (whatever trigger
--     sends it), the repeat-inquiry one, and the task's "assigned" one. The
--     notification kinds are unchanged;
--   - on a repeat inquiry, callback_at in the inquiry's metadata.
--   The raw choice stays in form_submissions.payload, like every other field.
-- Every statement is safe to run twice.

alter table public.forms add column if not exists callback_choice boolean not null default false;

comment on column public.forms.callback_choice is
  'SPD-05: the hosted form asks when to call back (now, or a slot today or tomorrow); the choice creates a call task.';

grant insert (callback_choice), update (callback_choice) on public.forms to authenticated;

-- The business's time zone, or Asia/Jerusalem when it is missing or unknown.
-- Only an IANA area/location name (the shape of profiles_timezone_check) or UTC
-- passes, so 'localtime', 'Factory' or a POSIX rule never reach the app's Intl;
-- a well-shaped name Postgres does not know falls back too.
create or replace function app.intake_zone(p_zone text) returns text
language plpgsql stable
set search_path = ''
as $$
begin
  if p_zone is null or char_length(p_zone) > 64
     or p_zone !~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$' then
    return 'Asia/Jerusalem';
  end if;
  perform now() at time zone p_zone;
  return p_zone;
exception when others then
  return 'Asia/Jerusalem';
end;
$$;
revoke all on function app.intake_zone(text) from public, anon, authenticated;

-- The Hebrew words for a call-back choice ('עכשיו', 'היום בין 09:00 ל-12:00').
-- Null for anything that is not a choice of the list.
create or replace function app.intake_callback_label(p_choice text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_choice = 'now' then 'עכשיו'
    when p_choice ~ '^(today|tomorrow)-(09|12|15|18)$' then
      case when split_part(p_choice, '-', 1) = 'today' then 'היום' else 'מחר' end
      || ' בין ' || split_part(p_choice, '-', 2) || ':00 ל-'
      || case split_part(p_choice, '-', 2) when '09' then '12' when '12' then '15' when '15' then '18' else '20' end
      || ':00'
  end;
$$;
revoke all on function app.intake_callback_label(text) from public, anon, authenticated;

-- When to call: p_now for 'now'; the slot's start in the business's zone, or
-- p_now when the slot has started. Raises for an unknown choice or an ended slot.
create or replace function app.intake_callback_at(p_choice text, p_zone text, p_now timestamptz)
returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_zone text := app.intake_zone(p_zone);
  v_day date;
  v_start int;
  v_end int;
  v_from timestamptz;
  v_until timestamptz;
begin
  if p_choice = 'now' then
    return p_now;
  end if;
  if p_choice is null or p_choice !~ '^(today|tomorrow)-(09|12|15|18)$' then
    raise exception 'invalid callback time' using errcode = '22023', hint = 'callback:invalid';
  end if;
  v_day := (p_now at time zone v_zone)::date + case when split_part(p_choice, '-', 1) = 'tomorrow' then 1 else 0 end;
  v_start := split_part(p_choice, '-', 2)::int;
  v_end := case v_start when 9 then 12 when 12 then 15 when 15 then 18 else 20 end;
  v_from := (v_day + make_time(v_start, 0, 0)) at time zone v_zone;
  v_until := (v_day + make_time(v_end, 0, 0)) at time zone v_zone;
  if v_until <= p_now then
    raise exception 'callback time has passed' using errcode = '22023', hint = 'callback:past';
  end if;
  return greatest(v_from, p_now);
end;
$$;
revoke all on function app.intake_callback_at(text, text, timestamptz) from public, anon, authenticated;

-- The call task of a call-back request. Runs inside public.intake_submit()
-- (security definer); the task's "assigned" notification gets the time as body.
create or replace function app.intake_callback_task(
  p_org uuid, p_owner uuid, p_lead uuid, p_contact uuid,
  p_choice text, p_at timestamptz, p_who text, p_form_name text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_label text := app.intake_callback_label(p_choice);
  v_task uuid;
begin
  insert into public.tasks (organization_id, title, description, task_type, due_at, remind_at, priority,
                            owner_id, lead_id, contact_id)
  values (p_org,
          left('שיחה חוזרת: ' || coalesce(nullif(btrim(p_who), ''), 'פנייה מטופס'), 300),
          left('ביקשו בטופס "' || coalesce(p_form_name, '') || '" שנחזור אליהם ' || v_label || '.', 2000),
          'call', p_at,
          -- a slot still ahead reminds at its start; "now" is due at once
          case when p_at > now() then p_at end,
          case when p_choice = 'now' then 1 else 2 end,
          p_owner, p_lead, p_contact)
  returning id into v_task;

  update public.notifications n set body = 'ביקשו שנחזור אליהם ' || v_label
   where n.organization_id = p_org and n.entity_type = 'task' and n.entity_id = v_task and n.body is null;
  return v_task;
end;
$$;
revoke all on function app.intake_callback_task(uuid, uuid, uuid, uuid, text, timestamptz, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- intake_form: the body of 0106 (form_thanks) plus 'callback'
-- ----------------------------------------------------------------------------
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
  v_whatsapp text;
  -- SPD-05
  v_callback jsonb;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
  end if;

  select coalesce(jsonb_agg(x.field order by x.ord), '[]'::jsonb) into v_fields
    from (
      select a.ord,
             jsonb_build_object(
               'key', a.item ->> 'key',
               'required', coalesce(a.item -> 'required' = 'true'::jsonb, false),
               'help', coalesce(nullif(btrim(a.item ->> 'help'), ''), d.help_text),
               'show_if', case when jsonb_typeof(a.item -> 'show_if') = 'object' then a.item -> 'show_if' end,
               'label', d.label,
               'type', d.field_type,
               'options', d.options) as field
        from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end)
               with ordinality as a(item, ord)
        left join public.field_definitions d
          on (a.item ->> 'key') like 'cf:%'
         and d.organization_id = v_form.organization_id
         and d.object_type = 'lead'
         and d.key = substr(a.item ->> 'key', 4)
         and d.is_active
         and d.field_type <> 'user'
       where (a.item ->> 'key') in ('full_name', 'phone', 'email', 'company_name', 'message')
          or d.id is not null
    ) x;

  -- FLD-04: only the logo's object name and the colour; nothing else of the organization
  select jsonb_build_object('logo', o.logo_path, 'color', o.brand_color) into v_brand
    from public.organizations o
   where o.id = v_form.organization_id;

  -- CAP-05: the WhatsApp number of the thank-you page, only when the form turns it on:
  -- the form's own number, else the business phone; only a valid E.164 number leaves
  if v_form.whatsapp_button then
    select app.normalize_phone(coalesce(nullif(btrim(v_form.whatsapp_phone), ''), o.phone)) into v_whatsapp
      from public.organizations o
     where o.id = v_form.organization_id;
    if v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
      v_whatsapp := null;
    end if;
  end if;

  -- SPD-05: the call-back choice, with the business's time zone for its time slots
  if v_form.callback_choice then
    select jsonb_build_object('time_zone', app.intake_zone(o.timezone)) into v_callback
      from public.organizations o
     where o.id = v_form.organization_id;
  end if;

  return jsonb_build_object(
    'callback', v_callback,
    'title', coalesce(nullif(btrim(v_form.title), ''), v_form.name),
    'intro', v_form.intro,
    'submit_label', v_form.submit_label,
    'fields', v_fields,
    'brand', coalesce(v_brand, jsonb_build_object('logo', null, 'color', null)),
    'thanks', jsonb_build_object(
      'whatsapp', v_whatsapp,
      'whatsapp_text', case when v_whatsapp is not null then nullif(btrim(v_form.whatsapp_text), '') end));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;
grant execute on function public.intake_form(text) to service_role;


-- ----------------------------------------------------------------------------
-- intake_submit: the body of 0108 (contact_channels) plus the call-back request,
-- every change marked SPD-05
-- ----------------------------------------------------------------------------
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
  -- SPD-05: when the person asked to be called back ('now' or '<today|tomorrow>-<hour>')
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_note text;
  v_task_owner uuid;
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

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select app.intake_callback_at(v_callback, o.timezone, now()) into v_callback_at
      from public.organizations o
     where o.id = v_form.organization_id;
    v_callback_note := 'ביקשו שנחזור אליהם ' || app.intake_callback_label(v_callback);
  else
    v_callback := null;
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
    -- CON-01: the contact's primary phone or email, or any of its other ones
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and c2.phone_e164 = v_phone_e164)
                 or (v_email is not null and lower(c2.email) = v_email))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and ch.value_e164 = v_phone_e164)
                 or (v_email is not null and ch.kind = 'email' and ch.value = v_email)))
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
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end);
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      -- SPD-05: the requested call-back time, when there is one, in the body
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים', v_callback_note,
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    -- SPD-05: a call task for the record's owner, else the form's owner
    if v_callback_at is not null then
      -- the record's owner while an active member who is not a viewer, else the form's owner, same check
      select m.user_id into v_task_owner from public.memberships m
       where m.organization_id = v_form.organization_id and m.user_id = v_owner
         and m.status = 'active' and m.role <> 'viewer';
      if v_task_owner is null then
        select m.user_id into v_task_owner from public.memberships m
         where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
           and m.status = 'active' and m.role <> 'viewer';
      end if;
      perform app.intake_callback_task(v_form.organization_id, v_task_owner, v_lead_match,
                                       coalesce(v_lead_contact, v_contact_match), v_callback, v_callback_at,
                                       coalesce(v_full_name, v_phone, v_email), v_form.name);
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

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    perform app.intake_callback_task(v_form.organization_id, v_owner, v_lead, null, v_callback, v_callback_at,
                                     coalesce(v_full_name, v_phone, v_email), v_form.name);
    update public.notifications n set body = v_callback_note
     where n.organization_id = v_form.organization_id and n.entity_type = 'lead' and n.entity_id = v_lead
       and n.body is null;
  end if;

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
