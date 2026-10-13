-- =============================================================================
-- New-lead notifications from forms and webhooks (SPD-01, owner's answer of
-- 13 October 2026)
-- =============================================================================
-- * A lead that public.intake_submit() creates is announced as kind 'lead_new'
--   (it was 'assigned'): intake_submit() sets the transaction-local app.intake
--   to 'on' around its insert of the lead, and app.notify_assignment() sends
--   'lead_new' to the owner for that insert. Muting 'lead_new' in the
--   notification settings now applies (trigger notifications_apply_settings).
--   A lead made by hand, an import, a conversion or a handover is unchanged.
-- * A lead with no owner (no round-robin result, and the form's owner is not an
--   active member who can edit) is announced as 'lead_new' to whoever may take it
--   (app.intake_unowned_recipients()): the active members of the form's team whose
--   role can write (owner, admin, manager, member; viewers and view seats never)
--   and who may read the lead (app.user_can_read_record(), the rule of
--   take_lead()); when the form has no team or nobody there qualifies, the
--   organization's active owners and admins. One notification per person. The
--   push carries the "לקחתי" buttons (claim_push_notifications() gives them to
--   'lead_new'); take_lead() lets the first one win.
-- * The call-back time (SPD-05) still goes into the body of every notification
--   about the new lead, matched by entity.
-- * Repeat inquiries keep their 'inquiry' notification.
-- * The call-back task of a lead (SPD-05) follows the lead's owner (owner's
--   answer, 13 October 2026). app.intake_callback_tasks (schema app: RLS on, no
--   grants, cascades with the task) only marks the call tasks intake_submit()
--   makes; the lead is the task's own lead_id (so merges and re-links count).
--   app.intake_call_task() now also gives the task the lead's team, so members
--   who see the team's records see the task before anyone takes the lead.
--   app.intake_callback_task_follow(org, lead): the lead's marked call tasks that
--   are open, not in the bin and still without an owner move to the lead's owner
--   (the lead not in the bin) when that owner is an active member with a full seat who is not a viewer;
--   silently (app.intake_follow makes app.notify_assignment skip that change).
--   It runs from trigger leads_callback_task_follow (any change of owner_id:
--   "לקחתי", by hand, inline, bulk, transfer_records), from trigger
--   tasks_callback_task_follow (the task moved to another lead: a merge, a
--   re-link), from public.take_lead()
--   (body of 0122; also when the caller already owned the lead), and from
--   app.send_task_reminders() before reminding. Other tasks, and a call task
--   that has an owner, do not change.
-- * app.send_task_reminders() (body of 0010): a marked call task still without an
--   owner when its reminder is due (its lead has no usable owner) reminds, once
--   (reminded_at), the people app.intake_unowned_recipients() names for the
--   lead's team, as 'lead_new' about the lead (the push carries "לקחתי"), while
--   the lead is open, unconverted and not in the bin. Every other reminder is
--   unchanged. Index tasks_reminder_due_idx keeps the minute job cheap.
-- Every statement is safe to run twice.

create table if not exists app.intake_callback_tasks (
  task_id         uuid primary key,
  organization_id uuid not null,
  lead_id         uuid not null,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, task_id) references public.tasks (organization_id, id) on delete cascade
);
comment on column app.intake_callback_tasks.lead_id is
  'SPD-01: the lead at creation (for reading only; the rules use the task''s own lead_id).';
alter table app.intake_callback_tasks enable row level security;
revoke all on app.intake_callback_tasks from public, anon, authenticated;

create index if not exists tasks_reminder_due_idx on public.tasks (remind_at)
  where reminded_at is null and status = 'open';

create or replace function app.intake_unowned_recipients(p_org uuid, p_team uuid)
returns table (user_id uuid)
language plpgsql stable
set search_path = ''
as $$
begin
  if p_team is not null then
    return query
      select m.user_id
        from public.team_members tm
        join public.memberships m on m.organization_id = tm.organization_id and m.user_id = tm.user_id
       where tm.organization_id = p_org and tm.team_id = p_team
         and m.status = 'active' and m.role in ('owner', 'admin', 'manager', 'member') and m.seat_type = 'full'
         and app.user_can_read_record(p_org, m.user_id, null, p_team);
    if found then
      return;
    end if;
  end if;
  return query
    select m.user_id
      from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
end;
$$;
revoke all on function app.intake_unowned_recipients(uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- notify_assignment: the body of callback_slot_rules plus 'lead_new', marked SPD-01
-- ----------------------------------------------------------------------------
create or replace function app.notify_assignment() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_title text := tg_argv[1];
begin
  if new.owner_id is null or new.owner_id is not distinct from auth.uid() then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.owner_id is not distinct from old.owner_id then
    return null;
  end if;
  -- an imported file is not "assigned to you" one record at a time
  if tg_op = 'INSERT' and to_jsonb(new) ->> 'import_job_id' is not null then
    return null;
  end if;
  -- neither is a handover of someone's records (one summary notification instead)
  if current_setting('app.bulk_transfer', true) = 'on' then
    return null;
  end if;
  -- SPD-05: the call task of a form's call-back request, for the person this
  -- request has just told about the lead (app.intake_call_task())
  if v_entity = 'task' and tg_op = 'INSERT' and new.owner_id::text = current_setting('app.intake_quiet_task', true) then
    return null;
  end if;
  -- SPD-01: a call-back task following its lead's owner (app.intake_callback_task_follow())
  if v_entity = 'task' and current_setting('app.intake_follow', true) = 'on' then
    return null;
  end if;
  -- SPD-01: a lead that came in through a form or webhook (public.intake_submit())
  -- is a new lead for its owner, not an assignment
  if v_entity = 'lead' and tg_op = 'INSERT' and current_setting('app.intake', true) = 'on' then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    values (new.organization_id, new.owner_id, 'lead_new', 'ליד חדש הוקצה לכם', 'lead', new.id);
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  values (new.organization_id, new.owner_id, 'assigned', v_title, v_entity, new.id);
  return null;
end;
$$;

-- ----------------------------------------------------------------------------
-- intake_submit: the body of callback_slot_rules plus the marker and the
-- notifications of a lead nobody owns, marked SPD-01
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
      v_task := app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                     coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- SPD-01: the lead's call task follows "לקחתי"
      if v_lead_match is not null then
        insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
        values (v_task, v_form.organization_id, v_lead_match) on conflict do nothing;
      end if;
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

  -- SPD-01: the owner is told as 'lead_new' (app.notify_assignment())
  perform set_config('app.intake', 'on', true);
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
  perform set_config('app.intake', '', true);

  -- SPD-01: nobody owns it: whoever may take it is told, and the first "לקחתי" wins
  if v_owner is null then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    select v_form.organization_id, r.user_id, 'lead_new', 'ליד חדש מחכה למי שייקח אותו', 'lead', v_lead
      from app.intake_unowned_recipients(v_form.organization_id, v_form.team_id) r;
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
-- intake_call_task: the body of callback_slot_rules plus the lead's team, marked SPD-01
-- ----------------------------------------------------------------------------
create or replace function app.intake_call_task(
  p_org uuid, p_owner uuid, p_lead uuid, p_contact uuid,
  p_is_now boolean, p_at timestamptz, p_phrase text, p_who text, p_form_name text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_task uuid;
  v_told boolean;
  v_team uuid;
begin
  -- notifications of this request carry this transaction's now()
  v_told := p_owner is not null and exists (
    select 1 from public.notifications n
     where n.organization_id = p_org and n.user_id = p_owner and n.created_at = now()
       and n.type in ('lead_new', 'assigned', 'inquiry')
       and ((n.entity_type = 'lead' and n.entity_id = p_lead) or (n.entity_type = 'contact' and n.entity_id = p_contact)));
  perform set_config('app.intake_quiet_task', case when v_told then p_owner::text else '' end, true);

  -- SPD-01: the lead's team, so the team sees the task before anyone takes the lead
  if p_lead is not null then
    select l.team_id into v_team from public.leads l where l.organization_id = p_org and l.id = p_lead;
  end if;

  insert into public.tasks (organization_id, title, description, task_type, due_at, remind_at, priority,
                            owner_id, team_id, lead_id, contact_id)
  values (p_org,
          left('שיחה חוזרת: ' || coalesce(nullif(btrim(p_who), ''), 'פנייה מטופס'), 300),
          left('ביקשו בטופס "' || coalesce(p_form_name, '') || '" שנחזור אליהם ' || p_phrase || '.', 2000),
          'call', p_at,
          -- a slot still ahead reminds at its start; "now" is due at once
          case when p_at > now() then p_at end,
          case when p_is_now then 1 else 2 end,
          p_owner, v_team, p_lead, p_contact)
  returning id into v_task;

  perform set_config('app.intake_quiet_task', '', true);

  update public.notifications n set body = 'ביקשו שנחזור אליהם ' || p_phrase
   where n.organization_id = p_org and n.entity_type = 'task' and n.entity_id = v_task and n.body is null;
  return v_task;
end;
$$;
revoke all on function app.intake_call_task(uuid, uuid, uuid, uuid, boolean, timestamptz, text, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The call-back task follows the lead's owner
-- ----------------------------------------------------------------------------
create or replace function app.intake_callback_task_follow(p_org uuid, p_lead uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_count integer;
begin
  select l.owner_id into v_owner
    from public.leads l
    join public.memberships m on m.organization_id = l.organization_id and m.user_id = l.owner_id
   where l.organization_id = p_org and l.id = p_lead and l.deleted_at is null
     and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full';
  if v_owner is null then
    return 0;
  end if;
  perform set_config('app.intake_follow', 'on', true);
  update public.tasks t
     set owner_id = v_owner
   where t.organization_id = p_org and t.lead_id = p_lead
     and t.owner_id is null and t.status = 'open' and t.deleted_at is null
     and exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = p_org and ct.task_id = t.id);
  get diagnostics v_count = row_count;
  perform set_config('app.intake_follow', '', true);
  return v_count;
end;
$$;
revoke all on function app.intake_callback_task_follow(uuid, uuid) from public, anon, authenticated;

create or replace function app.leads_callback_task_follow() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.owner_id is not null and new.owner_id is distinct from old.owner_id then
    perform app.intake_callback_task_follow(new.organization_id, new.id);
  end if;
  return null;
end;
$$;
revoke all on function app.leads_callback_task_follow() from public, anon, authenticated;

create or replace trigger leads_callback_task_follow after update of owner_id on public.leads
  for each row execute function app.leads_callback_task_follow();

-- A marked call task moved to another lead (a merge, a re-link) follows that lead's owner.
create or replace function app.tasks_callback_task_follow() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.owner_id is null and new.lead_id is not null and new.lead_id is distinct from old.lead_id
     and exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = new.organization_id and ct.task_id = new.id) then
    perform app.intake_callback_task_follow(new.organization_id, new.lead_id);
  end if;
  return null;
end;
$$;
revoke all on function app.tasks_callback_task_follow() from public, anon, authenticated;

create or replace trigger tasks_callback_task_follow after update of lead_id on public.tasks
  for each row execute function app.tasks_callback_task_follow();

-- ----------------------------------------------------------------------------
-- take_lead: the body of 0122 (lead_push_actions) plus the call-back task, marked SPD-01
-- ----------------------------------------------------------------------------
create or replace function public.take_lead(p_org uuid, p_lead uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_lead record;
  v_owner uuid;
  v_owner_name text;
begin
  if v_user is null or p_org is null or p_lead is null
     or coalesce(app.membership_role(p_org) not in ('owner', 'admin', 'manager', 'member'), true)
     or not app.org_writable(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select l.id, l.owner_id, l.team_id, l.converted_at, l.deleted_at, s.kind as status_kind into v_lead
    from public.leads l
    left join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
   where l.organization_id = p_org and l.id = p_lead;
  if v_lead.id is null or v_lead.deleted_at is not null
     or not app.can_read_record(p_org, v_lead.owner_id, v_lead.team_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_lead.converted_at is not null or v_lead.status_kind is distinct from 'open' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  if v_lead.owner_id is null then
    -- first one wins: a second caller waits for the first one's row lock, then
    -- finds owner_id set and updates nothing
    update public.leads l
       set owner_id = v_user, taken_at = now()
     where l.organization_id = p_org and l.id = p_lead and l.owner_id is null
       and l.deleted_at is null and l.converted_at is null
       and exists (select 1 from public.lead_statuses s
                    where s.organization_id = l.organization_id and s.id = l.status_id and s.kind = 'open')
    returning l.owner_id into v_owner;
  elsif v_lead.owner_id = v_user then
    update public.leads l
       set taken_at = coalesce(l.taken_at, now())
     where l.organization_id = p_org and l.id = p_lead and l.owner_id = v_user
       and l.deleted_at is null and l.converted_at is null
       and exists (select 1 from public.lead_statuses s
                    where s.organization_id = l.organization_id and s.id = l.status_id and s.kind = 'open')
    returning l.owner_id into v_owner;
  end if;

  if v_owner is null then
    -- closed (converted, moved out of the open statuses, binned) while this call waited
    select l.owner_id, l.converted_at, l.deleted_at, s.kind as status_kind into v_lead
      from public.leads l
      left join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
     where l.organization_id = p_org and l.id = p_lead;
    if v_lead.converted_at is not null or v_lead.deleted_at is not null or v_lead.status_kind is distinct from 'open' then
      return jsonb_build_object('ok', false, 'reason', 'closed');
    end if;
    v_owner := v_lead.owner_id;
    select p.full_name into v_owner_name from public.profiles p where p.id = v_owner;
    return jsonb_build_object('ok', false, 'reason', 'taken', 'owner_name', nullif(btrim(coalesce(v_owner_name, '')), ''));
  end if;

  -- SPD-01: the lead's call-back task, still without an owner, goes with it
  -- (the owner change above already did it through the trigger; this covers a
  -- lead the caller owned before)
  perform app.intake_callback_task_follow(p_org, p_lead);

  update public.notifications n
     set read_at = now()
   where n.user_id = v_user and n.organization_id = p_org
     and n.entity_type = 'lead' and n.entity_id = p_lead and n.read_at is null;

  return jsonb_build_object('ok', true, 'result', case when v_lead.owner_id is null then 'taken' else 'acknowledged' end);
end;
$$;

revoke all on function public.take_lead(uuid, uuid) from public, anon;
grant execute on function public.take_lead(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- send_task_reminders: the body of 0010 (notifications) plus the call-back task
-- of a lead nobody owns, marked SPD-01
-- ----------------------------------------------------------------------------
create or replace function app.send_task_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_more integer;
  v_due record;
begin
  -- SPD-01: a lead's call-back task without an owner whose reminder is due goes
  -- to the lead's owner first, when the lead has a usable one (fallback for a
  -- task that did not follow), and is then reminded like any task
  for v_due in
    select distinct t.organization_id, t.lead_id
      from public.tasks t
     where t.reminded_at is null and t.status = 'open' and t.deleted_at is null
       and t.owner_id is null and t.lead_id is not null
       and t.remind_at <= now() and t.remind_at > now() - interval '1 day'
       and exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = t.organization_id and ct.task_id = t.id)
       and app.org_writable(t.organization_id)
  loop
    perform app.intake_callback_task_follow(v_due.organization_id, v_due.lead_id);
  end loop;

  with due as (
    update public.tasks t
       set reminded_at = now()
     where t.reminded_at is null and t.status = 'open' and t.deleted_at is null
       and t.owner_id is not null
       and t.remind_at <= now() and t.remind_at > now() - interval '1 day'
       and app.org_writable(t.organization_id)
    returning t.organization_id, t.owner_id, t.id, t.title
  )
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  select d.organization_id, d.owner_id, 'task_reminder', left('תזכורת: ' || d.title, 200), 'task', d.id
    from due d;
  get diagnostics v_count = row_count;

  -- SPD-01: a lead's call-back task nobody owns yet: whoever may take the lead,
  -- as 'lead_new' about the lead (the push carries "לקחתי"); once (reminded_at).
  -- (A lead with a usable owner had its task moved to that owner above.)
  with due as (
    update public.tasks t
       set reminded_at = now()
     where t.reminded_at is null and t.status = 'open' and t.deleted_at is null
       and t.owner_id is null and t.lead_id is not null
       and t.remind_at <= now() and t.remind_at > now() - interval '1 day'
       and exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = t.organization_id and ct.task_id = t.id)
       and app.org_writable(t.organization_id)
    returning t.organization_id, t.id, t.title, t.lead_id
  ), lead_due as (
    select d.organization_id, d.title, l.id as lead_id, l.team_id
      from due d
      join public.leads l on l.organization_id = d.organization_id and l.id = d.lead_id
     where l.deleted_at is null and l.converted_at is null
       and exists (select 1 from public.lead_statuses s
                    where s.organization_id = l.organization_id and s.id = l.status_id and s.kind = 'open')
  )
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select x.organization_id, r.user_id, 'lead_new', left('תזכורת: ' || x.title, 200), 'הליד עוד לא אצל אף אחד', 'lead', x.lead_id
    from lead_due x
    cross join lateral app.intake_unowned_recipients(x.organization_id, x.team_id) r;
  get diagnostics v_more = row_count;
  return v_count + v_more;
end;
$$;
revoke all on function app.send_task_reminders() from public, anon, authenticated;
