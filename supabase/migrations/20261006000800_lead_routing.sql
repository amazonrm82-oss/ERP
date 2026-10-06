-- =============================================================================
-- 0008 Lead distribution (round robin) and repeat inquiries
-- =============================================================================
-- * forms.assign_mode: 'owner' (a fixed person, as before) or 'round_robin'
--   among the available members of the form's team (or of the organization).
-- * memberships.last_lead_assigned_at: the round robin's memory. Server-only
--   (not in the client's column grants) and left out of the audit log.
-- * A submission whose phone or email matches a live lead or a contact does
--   not create a lead: it becomes an 'inquiry' on that record's timeline, and
--   its owner is notified. form_submissions.status gets 'duplicate'.

alter table public.forms
  add column assign_mode text not null default 'owner' check (assign_mode in ('owner', 'round_robin'));
grant insert (assign_mode), update (assign_mode) on public.forms to authenticated;

alter table public.memberships add column last_lead_assigned_at timestamptz;

alter table public.form_submissions drop constraint form_submissions_status_check;
alter table public.form_submissions
  add constraint form_submissions_status_check check (status in ('accepted', 'spam', 'duplicate'));

-- The next owner in the rotation: an active, available member with a full seat
-- (of the team, when one is given) who got a lead the longest time ago.
-- Locks the chosen membership row so two submissions at once do not pick the same person.
create or replace function app.next_lead_owner(p_org uuid, p_team uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select m.user_id into v_user
    from public.memberships m
   where m.organization_id = p_org
     and m.status = 'active' and m.is_available and m.role <> 'viewer' and m.seat_type = 'full'
     and (p_team is null or exists (
       select 1 from public.team_members tm where tm.team_id = p_team and tm.user_id = m.user_id))
   order by m.last_lead_assigned_at nulls first, m.created_at
   limit 1
   for update skip locked;
  if v_user is not null then
    update public.memberships set last_lead_assigned_at = now()
     where organization_id = p_org and user_id = v_user;
  end if;
  return v_user;
end;
$$;

revoke all on function app.next_lead_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function app.next_lead_owner(uuid, uuid) to service_role;

-- same function as in 0003, with last_lead_assigned_at ignored
create or replace function app.audit_row() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_org uuid;
  v_entity uuid;
  v_action text;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164', 'last_lead_assigned_at'];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_table_name = 'organizations' then
    v_org := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  else
    v_org := coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid;
  end if;
  v_entity := nullif(coalesce(v_new ->> 'id', v_old ->> 'id'), '')::uuid;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'DELETE' then
    -- nothing to attach the entry to when the organization itself is going away
    if not app.org_exists(v_org) then
      return null;
    end if;
    v_action := 'delete';
    v_changes := v_old;
  else
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> all (v_ignored) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    v_action := case
      when v_changes ? 'deleted_at' and (v_new ->> 'deleted_at') is not null then 'trash'
      when v_changes ? 'deleted_at' then 'restore'
      else 'update'
    end;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_changes);
  return null;
end;
$$;

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
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company));
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
                            full_name, phone, email, company_name, message)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_form.team_id,
          v_full_name, v_phone, v_email, v_company, v_message)
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
