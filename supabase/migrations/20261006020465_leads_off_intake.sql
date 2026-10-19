-- =============================================================================
-- LEAD-08 part (b): with leads switched off, the public intake makes contacts
-- =============================================================================
-- Owner, 18 October 2026, answer (א): when a business has the leads module off (public.org_modules, part (a)), a public
-- inquiry becomes a contact, and someone is asked to call back with a "לחזור ללקוח" task, the way the call-back task works.
-- * app.org_leads_enabled(org): the switch (no row = on). Definer, no grants: only the intake functions read it.
-- * public.intake_submit (every web form, the site widget, the business card's form; QR codes lead to those forms):
--   the body of 019640, unchanged while leads are on. With leads off:
--   - only contacts are matched (CON-01: primary or further phone/email); a business's old leads stay as they are;
--   - a match: the repeat-inquiry path as before (timeline entry, the owner told), plus "לחזור ללקוח" for the contact's
--     owner, else the form's owner (active, not a viewer), else nobody and the SPD-01 recipients are told;
--   - no match: the owner pick of a new lead (the form's owner with HEB-08's deputy rule, or CAP-08's distribution with
--     its rules and the CAP-09 hours; the v_rotation_closed lines are kept) names the new contact's owner; the contact
--     takes name, phone, email, the form's source, the team, the preferred channel and language; the rest a lead would
--     hold and a contact has no field for (message, company name, campaign parameters, the form's lead custom fields,
--     the call-back time) is kept in an 'inquiry' entry on the contact's timeline; the owner is told ('inquiry'), or the
--     SPD-01 recipients when there is none; then a call-back task when the form asked for a time, else "לחזור ללקוח";
--   - nothing waits on a list: a contact has no rotation or absence waiting list (CAP-09/HEB-08 hand back leads only),
--     so an unowned contact is taken through its task;
--   - the form inquiry is stored as before; it has no contact link (form_submissions links leads only).
-- * public.booking_submit: the body of 020100, unchanged while leads are on. With leads off only contacts are matched
--   (by phone), and a new person becomes the rep's contact with the page's source; the meeting links the contact and is
--   the follow-up (no extra task).
-- * With companies off (part (a)), CON-09's trigger contacts_company_by_domain no longer links a new contact to a company
--   by its email domain: the body of 018200 with one check (invoker; the caller reads its own business's switch).
-- * A leads import while leads are off is refused when the job is made (trigger import_jobs_module_check, invoker:
--   another business's switch is not readable, so an outsider gets RLS's plain refusal; hint module:leads_off).
-- Additive only. Safe to run twice.

create or replace function app.org_leads_enabled(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select m.leads_enabled from public.org_modules m where m.organization_id = p_org), true)
$$;
revoke all on function app.org_leads_enabled(uuid) from public, anon, authenticated;

-- The person who should hear about a new contact from the intake: its owner, else whoever may take it (SPD-01).
create or replace function app.intake_contact_notice(p_org uuid, p_owner uuid, p_team uuid, p_contact uuid, p_body text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_owner is not null then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (p_org, p_owner, 'inquiry', 'פנייה חדשה מטופס', p_body, 'contact', p_contact);
  else
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    select p_org, r.user_id, 'inquiry', 'פנייה חדשה מחכה למי שייקח אותה', p_body, 'contact', p_contact
      from app.intake_unowned_recipients(p_org, p_team) r;
  end if;
end;
$$;
revoke all on function app.intake_contact_notice(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

-- "לחזור ללקוח" (owner, 18 October 2026): a call task due now on the contact, for the given owner when an active member
-- who is not a viewer, else the fallback owner under the same check, else nobody (the SPD-01 recipients are told).
-- p_new: a new contact (its owner hears about the inquiry here); a repeat inquiry was already told to the contact's owner.
-- Like app.intake_call_task, the task itself is quiet for someone this request already told.
create or replace function app.intake_contact_follow_up(
  p_org uuid, p_owner uuid, p_fallback uuid, p_team uuid, p_contact uuid, p_who text, p_form_name text, p_new boolean
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_told boolean;
  v_task uuid;
begin
  select m.user_id into v_owner from public.memberships m
   where m.organization_id = p_org and m.user_id = p_owner and m.status = 'active' and m.role <> 'viewer';
  if v_owner is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = p_org and m.user_id = p_fallback and m.status = 'active' and m.role <> 'viewer';
  end if;
  if p_new or v_owner is null then
    perform app.intake_contact_notice(p_org, v_owner, p_team, p_contact, 'פנייה בטופס "' || coalesce(p_form_name, '') || '"');
  end if;

  -- notifications of this request carry this transaction's now()
  v_told := v_owner is not null and exists (
    select 1 from public.notifications n
     where n.organization_id = p_org and n.user_id = v_owner and n.created_at = now()
       and n.type in ('assigned', 'inquiry') and n.entity_type = 'contact' and n.entity_id = p_contact);
  perform set_config('app.intake_quiet_task', case when v_told then v_owner::text else '' end, true);
  insert into public.tasks (organization_id, title, description, task_type, due_at, priority, owner_id, team_id, contact_id)
  values (p_org,
          left('לחזור ללקוח: ' || coalesce(nullif(btrim(p_who), ''), 'פנייה מטופס'), 300),
          left('פנייה בטופס "' || coalesce(p_form_name, '') || '". הפרטים בציר הזמן של איש הקשר.', 2000),
          'call', now(), 1, v_owner, p_team, p_contact)
  returning id into v_task;
  perform set_config('app.intake_quiet_task', '', true);
  return v_task;
end;
$$;
revoke all on function app.intake_contact_follow_up(uuid, uuid, uuid, uuid, uuid, text, text, boolean) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- public.intake_submit: the body of 019640 with the LEAD-08 lines
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
  -- SPD-05: when the person asked to be called back ('now' or a slot 'YYYY-MM-DD-HH', its business date and start hour)
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_phrase text;
  v_callback_note text;
  v_task_owner uuid;
  v_task uuid;
  -- CAP-09: the rotation has members, but none is in working hours (or all are on leave)
  v_rotation_closed boolean := false;
  -- CAP-08: the team the new lead belongs to and is distributed in (the form's, or a matching rule's)
  v_team uuid;
  -- HEB-08: the form's owner was away with no usable deputy
  v_absent uuid;
  -- CON-10: how the person likes to be contacted, when the form asks (one of the four, else none)
  v_channel text := case when p_payload ->> 'preferred_channel' in ('phone', 'whatsapp', 'email', 'sms')
                         then p_payload ->> 'preferred_channel' end;
  -- CAP-08: the person's language, when the form asks (one of the contacts' codes, else none)
  v_locale text := case when p_payload ->> 'preferred_locale' in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es')
                        then p_payload ->> 'preferred_locale' end;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
  -- LEAD-08 (owner, 18 October 2026, answer (א)): the business switched leads off; the inquiry becomes a contact
  v_leads_on boolean;
  v_contact uuid;
  v_name text;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  -- read-only and suspended businesses keep taking leads (owner, 8 and 13 October 2026)
  if not app.org_takes_leads(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  v_leads_on := app.org_leads_enabled(v_form.organization_id);

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

  -- CON-10: a channel counts only when the form asks
  if v_form.kind <> 'form' or not v_form.channel_choice then
    v_channel := null;
  end if;
  -- CAP-08: a language counts only when the form asks
  if v_form.kind <> 'form' or not v_form.locale_choice then
    v_locale := null;
  end if;

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  -- (SPD-05 follow-ups: the slots this form offers now, app.intake_callback_pick())
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select p.at, p.phrase into v_callback_at, v_callback_phrase
      from app.intake_callback_pick(v_form.organization_id, v_form.callback_slots_off, v_callback, now()) p;
    v_callback_note := 'ביקשו שנחזור אליהם ' || v_callback_phrase;
  else
    v_callback := null;
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  -- LEAD-08: with leads off only contacts are matched (the business's old leads stay as they are)
  if v_leads_on then
    select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
      from public.leads l
     where l.organization_id = v_form.organization_id and l.deleted_at is null
       and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
            or (v_email is not null and lower(l.email) = v_email))
     order by l.created_at desc
     limit 1;
  end if;
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
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end);
    -- CAP-08: the form's language fills an empty one only
    if v_locale is not null then
      if v_lead_match is not null then
        update public.leads l set preferred_locale = v_locale
         where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.preferred_locale is null;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c set preferred_locale = v_locale
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and c.preferred_locale is null;
      end if;
    end if;
    -- CON-10 (owner, 14 October 2026): the form's channel fills an empty one, or replaces one
    -- that came from a form; a channel a person set (or one older than its source) stays
    if v_channel is not null then
      if v_lead_match is not null then
        update public.leads l
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where l.organization_id = v_form.organization_id and l.id = v_lead_match
           and (l.preferred_channel is null or l.preferred_channel_source = 'form')
           and l.preferred_channel is distinct from v_channel;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and (c.preferred_channel is null or c.preferred_channel_source = 'form')
           and c.preferred_channel is distinct from v_channel;
      end if;
    end if;
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
      v_task := app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                     coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- SPD-01: the lead's call task follows "לקחתי"
      if v_lead_match is not null then
        insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
        values (v_task, v_form.organization_id, v_lead_match) on conflict do nothing;
      end if;
    end if;
    -- LEAD-08: with leads off a repeat inquiry from a contact also gets "לחזור ללקוח" (the call-back task does it when asked)
    if not v_leads_on and v_callback_at is null then
      -- the contact's own team (its task and, with no owner, who is told)
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, v_form.owner_id,
                                           (select c.team_id from public.contacts c
                                             where c.organization_id = v_form.organization_id and c.id = v_contact_match),
                                           v_contact_match, coalesce(v_full_name, v_phone, v_email), v_form.name, false);
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

  if v_leads_on then
    select s.id into v_status from public.lead_statuses s
     where s.organization_id = v_form.organization_id and s.kind = 'open'
     order by s.is_default desc, s.position
     limit 1;
    if v_status is null then
      raise exception 'the organization has no open lead status' using errcode = 'P0001';
    end if;
  end if;

  v_team := v_form.team_id;
  if v_form.assign_mode = 'round_robin' then
    -- CAP-08: the rules (source, language, list field; a team or one person), then the pick
    select p.owner_id, p.team_id, p.rule_user, p.absent_user into v_owner, v_team, v_rule_user, v_absent
      from app.lead_distribution_route(v_form.organization_id, v_form.team_id, now(),
                                       jsonb_build_object('source_id', v_form.source_id, 'locale', v_locale,
                                                          -- the values the lead will hold: with the
                                                          -- fields' defaults (FLD-07) the insert adds
                                                          'custom_fields', (select d.p_result from app.custom_field_defaults_apply(
                                                                              v_form.organization_id, 'lead', v_custom) d)),
                                       '{}'::uuid[]) p;
    -- CAP-09 (owner, 13 October 2026): nobody of the rotation in hours: the lead waits
    -- with no owner for a "לקחתי"; nobody available at all keeps the form owner's fallback
    v_rotation_closed := v_owner is null and v_rule_user is null and app.rotation_has_members(v_form.organization_id, v_team);
  end if;
  -- CAP-08: a rule's person (HEB-08 already applied) never falls back to the form's owner
  if v_owner is null and not v_rotation_closed and v_rule_user is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
    -- HEB-08: an absent form owner's new lead goes to their deputy; with no usable
    -- deputy it has no owner and takes the SPD-01 route (no chain)
    -- (app.auto_lead_owner: the rule every automatic assigner of a fixed person uses)
    if v_owner is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent
        from app.auto_lead_owner(v_form.organization_id, v_owner, now()) a;
    end if;
  end if;

  -- LEAD-08 (owner, 18 October 2026, answer (א)): leads are off: the same owner pick made a contact's owner, the
  -- inquiry is a contact with the details on its timeline, and someone is asked to call back ("לחזור ללקוח").
  -- With no owner (the rotation closed, an absent owner with no deputy) the contact waits for whoever takes the
  -- task: there is no waiting list for contacts, so nobody is handed it later.
  if not v_leads_on then
    v_name := coalesce(v_full_name, '');
    insert into public.contacts (organization_id, first_name, last_name, phone, email, source_id, owner_id, team_id,
                                 preferred_channel, preferred_channel_source, preferred_locale)
    values (v_form.organization_id,
            case when position(' ' in v_name) > 0 then split_part(v_name, ' ', 1) else nullif(v_name, '') end,
            case when position(' ' in v_name) > 0 then btrim(substr(v_name, position(' ' in v_name) + 1)) end,
            v_phone, v_email, v_form.source_id, v_owner, v_team,
            v_channel, case when v_channel is not null then 'form' end, v_locale)
    returning id into v_contact;
    -- what a lead would have held and a contact has no field for (message, company name, campaign, the form's own
    -- fields) is kept on the contact's timeline
    insert into public.activities (organization_id, type, body, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_contact,
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end);
    if v_callback_at is not null then
      -- SPD-05: the requested time is the follow-up; told first, so the task itself is quiet for the owner
      perform app.intake_contact_notice(v_form.organization_id, v_owner, v_team, v_contact, v_callback_note);
      v_task := app.intake_call_task(v_form.organization_id, v_owner, null, v_contact, v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- the call task takes the contact's team, as "לחזור ללקוח" does (intake_call_task finds a team on a lead only)
      update public.tasks t set team_id = v_team
       where t.organization_id = v_form.organization_id and t.id = v_task and v_team is not null
         and t.team_id is distinct from v_team;
    else
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, null, v_team, v_contact,
                                           coalesce(v_full_name, v_phone, v_email), v_form.name, true);
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'accepted', null, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'accepted',
      'contact_id', v_contact,
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  -- SPD-01: the owner is told as 'lead_new' (app.notify_assignment())
  perform set_config('app.intake', 'on', true);
  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields, preferred_channel, preferred_channel_source, preferred_locale)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_team,
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
          v_custom, v_channel, case when v_channel is not null then 'form' end, v_locale)
  returning id into v_lead;
  perform set_config('app.intake', '', true);

  -- CAP-09: if nobody takes it, the rotation gives it to the first member back in hours
  if v_rotation_closed then
    insert into app.rotation_waiting_leads (lead_id, organization_id, team_id)
    values (v_lead, v_form.organization_id, v_team) on conflict do nothing;
  end if;

  -- HEB-08: back from the absence, the form's owner gets it if nobody took it (app.return_absence_leads())
  if v_owner is null and v_absent is not null then
    perform app.lead_waits_for_absent(v_form.organization_id, v_lead, v_form.id, v_absent);
  end if;

  -- SPD-01: nobody owns it: whoever may take it is told, and the first "לקחתי" wins
  if v_owner is null then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    select v_form.organization_id, r.user_id, 'lead_new', 'ליד חדש מחכה למי שייקח אותו', 'lead', v_lead
      from app.intake_unowned_recipients(v_form.organization_id, v_team) r;
  end if;

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    v_task := app.intake_call_task(v_form.organization_id, v_owner, v_lead, null, v_callback = 'now', v_callback_at,
                                   v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    -- SPD-01: the lead's call task follows "לקחתי"
    insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
    values (v_task, v_form.organization_id, v_lead) on conflict do nothing;
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

-- ----------------------------------------------------------------------------
-- public.booking_submit: the body of 020100 with the LEAD-08 lines
-- ----------------------------------------------------------------------------
create or replace function public.booking_submit(
  p_token      text,
  p_starts_at  timestamptz,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_page public.booking_pages;
  v_state text;
  v_type public.meeting_types;
  v_zone text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_answers_in jsonb := case when jsonb_typeof(p_payload -> 'answers') = 'object' then p_payload -> 'answers' else '{}'::jsonb end;
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  v_phone_e164 text;
  v_question jsonb;
  v_answer text;
  v_lines text[] := '{}';
  v_lead uuid;
  v_contact uuid;
  v_status uuid;
  v_meeting uuid;
  v_ends_at timestamptz;
  v_rep text;
  v_new_lead boolean := false;
  v_source uuid;
  v_refusal jsonb;
  -- LEAD-08: the business switched leads off; a new person becomes a contact
  v_leads_on boolean := true;
  v_name text;
begin
  select * into v_page from public.booking_pages b where b.token = coalesce(p_token, '');
  p_ip_hash := app.booking_sender(v_page.id, p_ip_hash);
  v_state := app.booking_page_state(v_page);
  if v_state = 'not_found' then
    raise exception 'booking page not found' using errcode = 'P0002';
  end if;
  if v_state = 'unavailable' then
    raise exception 'booking is not available' using errcode = 'P0001', hint = 'booking:unavailable';
  end if;

  -- one attempt at a time per page, so a burst in parallel meets the counts (review of 15 October 2026)
  perform pg_advisory_xact_lock(hashtextextended('booking_submit:' || v_page.id::text, 0));
  -- closed for an hour after too many failed attempts (owner, 15 October 2026)
  if exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
    raise exception 'the page is closed for now' using errcode = 'P0001', hint = 'booking:closed';
  end if;
  -- per sender 5 attempts in 10 minutes (spam included)
  if p_ip_hash is not null and (
    select count(*) from app.booking_requests r
     where r.page_id = v_page.id and r.ip_hash = p_ip_hash and r.created_at > now() - interval '10 minutes'
  ) >= 5 then
    raise exception 'too many attempts' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
    values (v_page.id, v_page.organization_id, p_ip_hash, 'spam');
    return jsonb_build_object('status', 'spam');
  end if;

  -- the person and the answers
  v_phone_e164 := app.normalize_phone(v_phone);
  if v_full_name is null then
    raise exception 'a name is required' using errcode = '22023', hint = 'booking:full_name';
  end if;
  if v_phone_e164 is null then
    raise exception 'a valid phone is required' using errcode = '22023', hint = 'booking:phone';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023', hint = 'booking:email';
  end if;
  for v_question in select value from jsonb_array_elements(v_page.questions) loop
    v_answer := case when jsonb_typeof(v_answers_in -> (v_question ->> 'id')) = 'string'
                     then nullif(left(btrim(v_answers_in ->> (v_question ->> 'id')), 1000), '') end;
    if v_answer is null and (v_question -> 'required') = 'true'::jsonb then
      raise exception 'an answer is required' using errcode = '22023', hint = 'booking:answer';
    end if;
    if v_answer is not null then
      v_lines := v_lines || ((v_question ->> 'label') || ': ' || v_answer);
    end if;
  end loop;

  -- one booking at a time per rep, then the slot must still be free
  perform pg_advisory_xact_lock(hashtextextended('booking:' || v_page.organization_id::text || ':' || v_page.user_id::text, 0));
  select * into v_type from public.meeting_types t where t.organization_id = v_page.organization_id and t.id = v_page.meeting_type_id;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_page.organization_id;
  -- invalid_time / slot_taken as in CAL-10 (app.booking_refusal; answered, not raised, so the attempt stays counted)
  v_refusal := app.booking_refusal(v_page, p_starts_at, p_ip_hash, v_zone, null);
  if v_refusal is not null then
    return v_refusal;
  end if;
  v_ends_at := p_starts_at + make_interval(mins => v_type.duration_minutes);

  -- linked by phone: a live lead (and the contact it became), else a contact (CON-01: any of its phones)
  -- LEAD-08: with leads off only contacts are matched, and a new person becomes a contact
  v_leads_on := app.org_leads_enabled(v_page.organization_id);
  if v_leads_on then
    select l.id, l.converted_contact_id into v_lead, v_contact
      from public.leads l
     where l.organization_id = v_page.organization_id and l.deleted_at is null and l.phone_e164 = v_phone_e164
     order by l.created_at desc
     limit 1;
  end if;
  -- the contact the lead became, unless it is in the recycle bin
  if v_contact is not null and not exists (select 1 from public.contacts c
                                            where c.organization_id = v_page.organization_id and c.id = v_contact
                                              and c.deleted_at is null) then
    v_contact := null;
  end if;
  if v_lead is null then
    select c.id into v_contact
      from public.contacts c
     where c.organization_id = v_page.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_page.organization_id and c2.phone_e164 = v_phone_e164
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_page.organization_id and ch.value_e164 = v_phone_e164)
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead is null and v_contact is null then
    if v_leads_on then
      select s.id into v_status from public.lead_statuses s
       where s.organization_id = v_page.organization_id and s.kind = 'open'
       order by s.is_default desc, s.position
       limit 1;
      if v_status is null then
        raise exception 'the organization has no open lead status' using errcode = 'P0001';
      end if;
    end if;
    -- the page's source, else "דף קביעת תור" from the lead sources list (made once when missing)
    v_source := v_page.source_id;
    if v_source is null then
      -- one find-or-create at a time per business, so two bookings never make the source twice
      perform pg_advisory_xact_lock(hashtextextended('booking_source:' || v_page.organization_id::text, 0));
      select s.id into v_source from public.lead_sources s
       where s.organization_id = v_page.organization_id
         and (s.kind = 'booking' or btrim(s.name) = 'דף קביעת תור')
       order by s.is_active desc, (s.kind = 'booking') desc, s.created_at
       limit 1;
      if v_source is null then
        insert into public.lead_sources (organization_id, name, kind)
        values (v_page.organization_id, 'דף קביעת תור', 'booking')
        returning id into v_source;
      end if;
    end if;
    if not v_leads_on then
      -- LEAD-08: the rep's new contact, with the page's source; the meeting is its follow-up (no extra task)
      v_name := v_full_name;
      insert into public.contacts (organization_id, first_name, last_name, phone, email, source_id, owner_id)
      values (v_page.organization_id,
              case when position(' ' in v_name) > 0 then split_part(v_name, ' ', 1) else v_name end,
              case when position(' ' in v_name) > 0 then btrim(substr(v_name, position(' ' in v_name) + 1)) end,
              v_phone, v_email, v_source, v_page.user_id)
      returning id into v_contact;
    else
    perform set_config('app.intake', 'on', true);
    insert into public.leads (organization_id, status_id, source_id, owner_id,
                              full_name, phone, email,
                              campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid)
    values (v_page.organization_id, v_status, v_source, v_page.user_id,
            v_full_name, v_phone, v_email,
            coalesce(v_attr ->> 'utm_campaign', v_page.title),
            jsonb_strip_nulls(jsonb_build_object(
              'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
              'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
              'utm_content', v_attr -> 'utm_content', 'extra', v_attr -> 'extra')),
            v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
            v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid')
    returning id into v_lead;
    perform set_config('app.intake', '', true);
    end if;
    v_new_lead := true;
  end if;

  insert into public.meetings (organization_id, title, meeting_type, meeting_type_id, starts_at, ends_at,
                               location, description, owner_id, lead_id, contact_id)
  values (v_page.organization_id,
          left(v_type.name || ': ' || v_full_name, 300),
          coalesce(v_type.meeting_format, 'in_person'),
          v_type.id, p_starts_at, v_ends_at,
          v_type.location,
          left(array_to_string(array['נקבעה בדף קביעת התור "' || v_page.title || '".'] || v_lines, chr(10)), 5000),
          v_page.user_id, v_lead, v_contact)
  returning id into v_meeting;

  -- an existing record: the booking on its timeline (a new lead's own row says it)
  if not v_new_lead then
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (v_page.organization_id, 'inquiry', null, v_lead, v_contact,
            jsonb_build_object('booking_page_id', v_page.id, 'booking_page_title', v_page.title, 'meeting_id', v_meeting,
                               'full_name', v_full_name, 'phone', v_phone, 'email', v_email));
  end if;

  insert into app.booking_requests (page_id, organization_id, ip_hash, outcome)
  values (v_page.id, v_page.organization_id, p_ip_hash, 'booked');

  select coalesce(nullif(btrim(p.full_name), ''), o.name) into v_rep
    from public.organizations o left join public.profiles p on p.id = v_page.user_id
   where o.id = v_page.organization_id;
  -- only what the confirmation shows, and the personal link to cancel or change (CAL-10b; only its hash is kept)
  return jsonb_build_object(
    'status', 'booked',
    'starts_at', p_starts_at,
    'ends_at', v_ends_at,
    'time_zone', v_zone,
    'meeting', jsonb_build_object('name', v_type.name, 'format', coalesce(v_type.meeting_format, 'in_person'), 'location', v_type.location),
    'rep', v_rep,
    'manage_token', app.booking_manage_issue(v_page.organization_id, v_meeting, v_page.id));
end;
$$;
revoke all on function public.booking_submit(text, timestamptz, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.booking_submit(text, timestamptz, jsonb, text, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- A leads import while leads are off is refused when the job is made
-- ----------------------------------------------------------------------------
create or replace function app.import_jobs_module_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- invoker: the switch is read with the caller's rights, so another business's switch reads as "on" and RLS refuses
  if new.entity_type = 'lead'
     and exists (select 1 from public.org_modules m where m.organization_id = new.organization_id and not m.leads_enabled) then
    raise exception 'the leads module is switched off' using errcode = 'P0001', hint = 'module:leads_off';
  end if;
  return new;
end;
$$;
revoke all on function app.import_jobs_module_check() from public, anon;

create or replace trigger import_jobs_module_check before insert on public.import_jobs
  for each row execute function app.import_jobs_module_check();

-- ----------------------------------------------------------------------------
-- CON-09 with companies off: the body of 018200 with the LEAD-08 check
-- ----------------------------------------------------------------------------
create or replace function app.contacts_company_by_domain() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_rows record;
  v_count integer := 0;
  v_pick record;
begin
  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      new.company_matched_domain := null;
      new.company_match_kind := null;
    end if;
    return new;
  end if;

  new.company_matched_domain := null;
  new.company_match_kind := null;
  if new.company_id is not null or new.deleted_at is not null or nullif(btrim(new.email), '') is null then
    return new;
  end if;
  -- a person's write only: conversion, merges and sample data keep their own logic
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- LEAD-08: a business that switched companies off gets no company by the email domain
  if exists (select 1 from public.org_modules m where m.organization_id = new.organization_id and not m.companies_enabled) then
    return new;
  end if;
  -- an import that mapped a company column decides the company itself
  if new.import_job_id is not null and exists (
    select 1 from public.import_jobs j
     where j.organization_id = new.organization_id and j.id = new.import_job_id and j.maps_company
  ) then
    return new;
  end if;

  for v_rows in select x.id, x.domain, x.kind from public.company_domain_matches(new.organization_id, new.email) x limit 2 loop
    v_count := v_count + 1;
    v_pick := v_rows;
  end loop;
  if v_count = 1 then
    new.company_id := v_pick.id;
    new.company_matched_domain := v_pick.domain;
    new.company_match_kind := v_pick.kind;
  end if;
  return new;
end;
$$;

revoke all on function app.contacts_company_by_domain() from public, anon;
grant execute on function app.contacts_company_by_domain() to authenticated, service_role;

notify pgrst, 'reload schema';
