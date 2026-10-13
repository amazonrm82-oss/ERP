-- =============================================================================
-- Working hours and leave in lead distribution (CAP-09)
-- =============================================================================
-- * org_calendar_settings.working_hours: the business's weekly hours, in the
--   organization's time zone, same shape as profiles.working_hours (checked by
--   app.working_hours_ok). Null (or no settings row) = no hours limit: the round
--   robin hands out leads at any hour, as before (the lead's safe default until
--   the owner decides, review M1). Owners and admins write it (the table's
--   existing policies; column grants below).
-- * A person's own hours stay in profiles.working_hours (USR-01), read in their
--   own time zone (profiles.timezone, else the organization's). Null = the
--   business's hours apply. The user edits their own row as before; through
--   public.set_member_working_hours() the owner edits anyone's and an admin
--   anyone's but the owner's and other admins' (the rule of org_reset_member_mfa),
--   only while that member belongs to no other organization (the profile is
--   shared by all of them). Logged in the audit log.
-- * public.member_leaves: leave / absence as a date range per member and
--   organization (dates in the person's zone, both ends included). Members of
--   the organization read them; a member writes their own; the owner anyone's,
--   an admin anyone's but the owner's and other admins' (app.member_hours_editable),
--   while the organization is writable. Audited. At most 100 current and future
--   ones per member (ends_on from yesterday on, business zone). HEB-08 adds a
--   substitute later.
-- * app.member_in_hours(org, user, at): false on a day of leave. When hours apply
--   (the person's own, else the business's), also false on a rest day or
--   holiday of the business (its own zone) and outside those hours. With no hours
--   set anywhere, rest days do not limit, as before. Mirrored by memberInHours()
--   in src/features/work-hours/in-hours.ts (test 100 compares a grid of cases).
--   A range ending 23:59 runs to midnight.
-- * app.next_lead_owner(org, team, at): the round robin now also skips whoever
--   is outside hours (when hours are set) or on leave at that moment. The two-argument form (called
--   by intake_submit and the automation engine, unchanged) uses now(). When
--   nobody qualifies it returns null, as it did when nobody was available: the
--   form's fixed owner gets the lead (else nobody, SPD-01), and an automation's
--   round robin step fails with "nobody is available".
-- * When the rotation has members but none is in hours (owner, 13 October 2026,
--   DECISIONS.md CAP-09): intake_submit (body of lead_new_notifications, only the
--   fallback changed) leaves the lead with no owner, so SPD-01 announces it to
--   app.intake_unowned_recipients for a "לקחתי", and notes it in
--   app.rotation_waiting_leads. pg_cron crm-rotation-waiting (every minute,
--   app.assign_waiting_rotation_leads()) gives a still unowned lead to the next
--   member in line once one is back in hours (notify_assignment's 'assigned');
--   a lead taken meanwhile is left alone. Nobody available at all (or no
--   rotation): the form owner's fallback, as before. take_lead never moves the
--   rotation pointer (last_lead_assigned_at).
--   The job is fair and bounded: rows are taken by next_check_at, at most
--   app.rotation_waiting_per_org() per organization and app.rotation_waiting_limit()
--   per run (settings for tests); a row that cannot be settled yet is pushed a
--   minute forward (15 minutes for a read-only organization); once nobody of an
--   (organization, team) is in hours, the rest of that pair's rows are pushed
--   without asking again; each row runs in its own exception block, so one bad
--   row is pushed 10 minutes forward and does not stop the run.
--   Accepted (review L4): when two submissions at once lock every member row
--   (next_lead_owner's skip locked), a lead can be taken for "nobody in hours";
--   the job gives it out within a minute.
-- Read-only / suspended organization: reading goes on, nothing changes.
-- Full export: member_leaves.csv. Handover, merge: not involved.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The business's hours
-- ----------------------------------------------------------------------------
alter table public.org_calendar_settings add column if not exists working_hours jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.org_calendar_settings'::regclass and conname = 'org_calendar_settings_working_hours_check') then
    alter table public.org_calendar_settings add constraint org_calendar_settings_working_hours_check
      check (app.working_hours_ok(working_hours));
  end if;
end;
$$;

grant insert (working_hours), update (working_hours) on public.org_calendar_settings to authenticated;

-- ----------------------------------------------------------------------------
-- Leave
-- ----------------------------------------------------------------------------
create table if not exists public.member_leaves (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null,
  starts_on       date not null,
  ends_on         date not null,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  -- leaves go with the membership
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade,
  constraint member_leaves_range check (ends_on >= starts_on and ends_on - starts_on <= 365)
);

create index if not exists member_leaves_user_idx on public.member_leaves (organization_id, user_id, ends_on);

-- at most 100 current and future leaves per member and organization (ends_on
-- from yesterday on in the business's zone, what the screens show); hint
-- member_leaves:max. Checked on every insert, and on an update whose new dates
-- are current or future (moving an old leave forward counts). An advisory lock
-- per (organization, member) makes two writes at once count one after the other.
create or replace function app.member_leaves_limit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_cutoff date;
begin
  select (now() at time zone app.intake_zone(o.timezone))::date - 1 into v_cutoff
    from public.organizations o where o.id = new.organization_id;
  v_cutoff := coalesce(v_cutoff, current_date - 1);
  if tg_op = 'UPDATE' and new.ends_on < v_cutoff then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('member_leaves:' || new.organization_id::text || ':' || new.user_id::text, 0));
  if (select count(*) from public.member_leaves l
       where l.organization_id = new.organization_id and l.user_id = new.user_id
         and l.id <> new.id
         and l.ends_on >= v_cutoff) >= 100 then
    raise exception 'too many leaves for one member' using errcode = 'P0001', hint = 'member_leaves:max';
  end if;
  return new;
end;
$$;
revoke all on function app.member_leaves_limit() from public, anon, authenticated;

create or replace trigger member_leaves_limit before insert or update of starts_on, ends_on on public.member_leaves
  for each row execute function app.member_leaves_limit();
create or replace trigger member_leaves_touch before insert or update on public.member_leaves
  for each row execute function app.touch_row();
create or replace trigger member_leaves_audit after insert or update or delete on public.member_leaves
  for each row execute function app.audit_row();

-- May the caller change this member's hours and leaves? Their own (any role, a
-- real membership); the owner anyone's; an admin anyone's but the owner's and
-- other admins'. Only while the organization is writable.
create or replace function app.member_hours_editable(p_org uuid, p_user uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me public.membership_role := app.membership_role(p_org);
  v_target public.membership_role;
begin
  if v_me is null or p_user is null or not app.org_writable(p_org) then
    return false;
  end if;
  if p_user = auth.uid() or v_me = 'owner' then
    return true;
  end if;
  if v_me <> 'admin' then
    return false;
  end if;
  select m.role into v_target from public.memberships m where m.organization_id = p_org and m.user_id = p_user;
  return v_target is not null and v_target not in ('owner', 'admin');
end;
$$;
revoke all on function app.member_hours_editable(uuid, uuid) from public, anon;
grant execute on function app.member_hours_editable(uuid, uuid) to authenticated, service_role;

alter table public.member_leaves enable row level security;
revoke all on public.member_leaves from anon, authenticated;
grant select, delete on public.member_leaves to authenticated;
grant insert (organization_id, user_id, starts_on, ends_on) on public.member_leaves to authenticated;
grant update (starts_on, ends_on) on public.member_leaves to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'member_leaves' and policyname = 'member_leaves_select') then
    create policy member_leaves_select on public.member_leaves for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'member_leaves' and policyname = 'member_leaves_insert') then
    create policy member_leaves_insert on public.member_leaves for insert to authenticated
      with check (app.member_hours_editable(organization_id, user_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'member_leaves' and policyname = 'member_leaves_update') then
    create policy member_leaves_update on public.member_leaves for update to authenticated
      using (app.member_hours_editable(organization_id, user_id))
      with check (app.member_hours_editable(organization_id, user_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'member_leaves' and policyname = 'member_leaves_delete') then
    create policy member_leaves_delete on public.member_leaves for delete to authenticated
      using (app.member_hours_editable(organization_id, user_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- In hours?
-- ----------------------------------------------------------------------------

-- Is a wall-clock moment inside weekly hours (either stored shape)? A missing
-- day is a day off; a range ending 23:59 runs to midnight.
create or replace function app.hours_cover(p_hours jsonb, p_local timestamp) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_day jsonb;
  v_time time := p_local::time;
  v_range jsonb;
begin
  if p_hours is null or jsonb_typeof(p_hours) <> 'object' then
    return false;
  end if;
  v_day := p_hours -> (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[extract(dow from p_local)::int + 1];
  if v_day is null then
    return false;
  end if;
  for v_range in
    select r.value from jsonb_array_elements(case when jsonb_typeof(v_day) = 'array' then v_day else jsonb_build_array(v_day) end) r
  loop
    if v_time >= (v_range ->> 'start')::time
       and ((v_range ->> 'end') = '23:59' or v_time < (v_range ->> 'end')::time) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function app.hours_cover(jsonb, timestamp) from public, anon, authenticated;

create or replace function app.member_in_hours(p_org uuid, p_user uuid, p_at timestamptz) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org_zone text;
  v_zone text;
  v_own jsonb;
  v_profile_zone text;
  v_org_hours jsonb;
begin
  if p_org is null or p_user is null or p_at is null then
    return false;
  end if;
  select app.intake_zone(o.timezone) into v_org_zone from public.organizations o where o.id = p_org;
  if v_org_zone is null then
    return false;
  end if;
  select p.working_hours, p.timezone into v_own, v_profile_zone from public.profiles p where p.id = p_user;
  v_zone := case when v_profile_zone is null then v_org_zone else app.intake_zone(v_profile_zone) end;
  select c.working_hours into v_org_hours from public.org_calendar_settings c where c.organization_id = p_org;
  -- hours apply (the person's or the business's): a rest day or holiday of the business, in its own zone, is closed
  if (v_own is not null or v_org_hours is not null)
     and app.org_rest_day(p_org, (p_at at time zone v_org_zone)::date) then
    return false;
  end if;
  -- on leave that day (the person's zone)
  if exists (select 1 from public.member_leaves l
              where l.organization_id = p_org and l.user_id = p_user
                and (p_at at time zone v_zone)::date between l.starts_on and l.ends_on) then
    return false;
  end if;
  if v_own is not null then
    return app.hours_cover(v_own, p_at at time zone v_zone);
  end if;
  if v_org_hours is not null then
    return app.hours_cover(v_org_hours, p_at at time zone v_org_zone);
  end if;
  -- no hours set anywhere: no limit
  return true;
end;
$$;
revoke all on function app.member_in_hours(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.member_in_hours(uuid, uuid, timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- Round robin
-- ----------------------------------------------------------------------------

-- The next owner in the rotation at a moment: an active, available member with
-- a full seat (of the team, when one is given), inside their working hours and
-- not on leave, who got a lead the longest time ago. Null when nobody qualifies
-- (the callers fall back as before). Locks the chosen membership row so two
-- submissions at once do not pick the same person.
create or replace function app.next_lead_owner(p_org uuid, p_team uuid, p_at timestamptz) returns uuid
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
     and app.member_in_hours(p_org, m.user_id, p_at)
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
revoke all on function app.next_lead_owner(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.next_lead_owner(uuid, uuid, timestamptz) to service_role;

create or replace function app.next_lead_owner(p_org uuid, p_team uuid) returns uuid
language sql security definer
set search_path = ''
as $$ select app.next_lead_owner(p_org, p_team, now()) $$;
revoke all on function app.next_lead_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function app.next_lead_owner(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- An owner or admin sets a member's hours
-- ----------------------------------------------------------------------------
-- p_hours null = the business's hours apply. The owner sets anyone's; an admin
-- anyone's but the owner's and other admins'. Refused for a member of another
-- organization too (hint member_hours:other_orgs): the hours are on the shared
-- profile, so only the member changes them then.
create or replace function public.set_member_working_hours(p_org uuid, p_user uuid, p_hours jsonb) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_me public.membership_role := app.membership_role(p_org);
  v_target public.membership_role;
begin
  if v_me is null or v_me not in ('owner', 'admin') then
    raise exception 'owners and admins only' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  select m.role into v_target from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_target is null then
    raise exception 'not a member' using errcode = '42501';
  end if;
  -- an admin does not change the owner or another admin (org_reset_member_mfa's rule)
  if p_user is distinct from auth.uid() and v_me <> 'owner' and v_target in ('owner', 'admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_user is distinct from auth.uid() and exists (
    select 1 from public.memberships m
     where m.user_id = p_user and m.status = 'active' and m.organization_id <> p_org) then
    raise exception 'the user belongs to other organizations' using errcode = 'P0001', hint = 'member_hours:other_orgs';
  end if;
  if not app.working_hours_ok(p_hours) then
    raise exception 'invalid working hours' using errcode = 'P0001', hint = 'member_hours:invalid';
  end if;
  select p.working_hours into v_old from public.profiles p where p.id = p_user for update;
  if v_old is not distinct from p_hours then
    return;
  end if;
  update public.profiles set working_hours = p_hours where id = p_user;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'update', 'profiles', p_user,
          jsonb_build_object('working_hours', jsonb_build_object('old', v_old, 'new', p_hours)));
end;
$$;
revoke all on function public.set_member_working_hours(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_member_working_hours(uuid, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- A lead that comes in while the rotation is out of hours (owner, 13 October 2026)
-- ----------------------------------------------------------------------------

-- Does the rotation have members at all (active, available, a full seat, of the
-- team when one is given), whatever their hours? next_lead_owner's filter
-- without the hours.
create or replace function app.rotation_has_members(p_org uuid, p_team uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
     where m.organization_id = p_org
       and m.status = 'active' and m.is_available and m.role <> 'viewer' and m.seat_type = 'full'
       and (p_team is null or exists (
         select 1 from public.team_members tm where tm.team_id = p_team and tm.user_id = m.user_id)))
$$;
revoke all on function app.rotation_has_members(uuid, uuid) from public, anon, authenticated;
grant execute on function app.rotation_has_members(uuid, uuid) to service_role;

-- Leads that came in while nobody of the rotation was in hours. resolved_at is
-- set when the lead got an owner (assigned_to: by the rotation), was taken,
-- closed or removed, or after 14 days. Schema app: no API access.
create table if not exists app.rotation_waiting_leads (
  lead_id         uuid primary key references public.leads (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  team_id         uuid,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  assigned_to     uuid,
  -- the job looks at the row again from this time on
  next_check_at   timestamptz not null default now()
);
create index if not exists rotation_waiting_leads_due_idx on app.rotation_waiting_leads (next_check_at) where resolved_at is null;
alter table app.rotation_waiting_leads enable row level security;
revoke all on app.rotation_waiting_leads from public, anon, authenticated;

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
    -- CAP-09 (owner, 13 October 2026): nobody of the rotation in hours: the lead waits
    -- with no owner for a "לקחתי"; nobody available at all keeps the form owner's fallback
    v_rotation_closed := v_owner is null and app.rotation_has_members(v_form.organization_id, v_form.team_id);
  end if;
  if v_owner is null and not v_rotation_closed then
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

  -- CAP-09: if nobody takes it, the rotation gives it to the first member back in hours
  if v_rotation_closed then
    insert into app.rotation_waiting_leads (lead_id, organization_id, team_id)
    values (v_lead, v_form.organization_id, v_form.team_id) on conflict do nothing;
  end if;

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

-- How many waiting rows the job looks at per organization, and in all, per run
-- (settings app.rotation_waiting_per_org / app.rotation_waiting_limit; tests
-- lower them). Defaults and maxima: 50 and 500.
create or replace function app.rotation_waiting_per_org() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,4}$' then least(greatest(s::int, 1), 50) else 50 end
    from coalesce(current_setting('app.rotation_waiting_per_org', true), '') as s
$$;
revoke all on function app.rotation_waiting_per_org() from public, anon, authenticated;

create or replace function app.rotation_waiting_limit() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,4}$' then least(greatest(s::int, 1), 500) else 500 end
    from coalesce(current_setting('app.rotation_waiting_limit', true), '') as s
$$;
revoke all on function app.rotation_waiting_limit() from public, anon, authenticated;

-- Every minute: a waiting lead nobody took goes to the next member of the
-- rotation who is back in hours. The lead row is locked first, so a "לקחתי" at
-- the same moment either wins (the lead is left alone) or waits for this.
create or replace function app.assign_waiting_rotation_leads() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_lead record;
  v_user uuid;
  v_done integer := 0;
  -- (organization, team) pairs with nobody in hours in this run
  v_closed text[] := '{}';
  v_key text;
begin
  for v_row in
    select d.lead_id, d.organization_id, d.team_id, d.created_at
      from (
        select w.lead_id, w.organization_id, w.team_id, w.created_at, w.next_check_at,
               row_number() over (partition by w.organization_id order by w.next_check_at, w.created_at) as n
          from app.rotation_waiting_leads w
         where w.resolved_at is null and w.next_check_at <= now()
      ) d
     where d.n <= app.rotation_waiting_per_org()
     order by d.next_check_at, d.created_at
     limit app.rotation_waiting_limit()
  loop
    v_key := v_row.organization_id::text || ':' || coalesce(v_row.team_id::text, '');
    begin
      select l.owner_id, l.deleted_at, l.converted_at, s.kind as status_kind into v_lead
        from public.leads l
        join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
       where l.organization_id = v_row.organization_id and l.id = v_row.lead_id
       for update of l;
      if not found or v_lead.owner_id is not null or v_lead.deleted_at is not null or v_lead.converted_at is not null
         or v_lead.status_kind <> 'open' or v_row.created_at < now() - interval '14 days' then
        update app.rotation_waiting_leads set resolved_at = now() where lead_id = v_row.lead_id;
      elsif not app.org_writable(v_row.organization_id) then
        update app.rotation_waiting_leads set next_check_at = now() + interval '15 minutes' where lead_id = v_row.lead_id;
      elsif v_key = any (v_closed) then
        update app.rotation_waiting_leads set next_check_at = now() + interval '1 minute' where lead_id = v_row.lead_id;
      else
        v_user := app.next_lead_owner(v_row.organization_id, v_row.team_id);
        if v_user is null then
          v_closed := v_closed || v_key;
          update app.rotation_waiting_leads set next_check_at = now() + interval '1 minute' where lead_id = v_row.lead_id;
        else
          update public.leads set owner_id = v_user
           where organization_id = v_row.organization_id and id = v_row.lead_id and owner_id is null;
          update app.rotation_waiting_leads set resolved_at = now(), assigned_to = v_user where lead_id = v_row.lead_id;
          v_done := v_done + 1;
        end if;
      end if;
    exception when others then
      -- this row's changes are rolled back; look at it again later, go on with the others
      update app.rotation_waiting_leads set next_check_at = now() + interval '10 minutes' where lead_id = v_row.lead_id;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.assign_waiting_rotation_leads() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-rotation-waiting', '* * * * *', 'select app.assign_waiting_rotation_leads();');
  end if;
end;
$$;
