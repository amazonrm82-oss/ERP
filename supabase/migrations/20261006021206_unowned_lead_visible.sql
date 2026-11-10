-- SPD-01 completion (owner, 9 and 10 November 2026): a lead nobody owns can be taken from the member role up.
--
-- Under record visibility 'own' or 'team', app.can_read_record() gives a member only their own and their teams'
-- records, so an unowned lead was out of their sight and out of their reach. The rule of this migration:
--
--   an open (status kind 'open'), unconverted lead that is not in the bin and has no owner is offered to every
--   active owner, admin, manager or member of the business (never a viewer, never a support session:
--   app.membership_role() is the plain membership, with the two-step and closed-business rules); a lead with a
--   team only to the members of that team, to a manager (role) who manages the team or a parent team
--   (app.manages_team, the rule app.can_read_record() uses for managers) (188) א, and to owners and admins.
--
-- Owner's answer (212) ב (10 November 2026): this reaches ONLY the lead's page, its timeline, the waiting list and
-- the lead's short screen (the respond page a push opens). The leads_select policy is NOT changed, so reports,
-- global search, list export, imports and their duplicate checks, cleanup suggestions and every other reader keep
-- the old rule; the four places read through the narrow definer functions below, each of which checks the caller
-- itself, is scoped to the business and answers only what those screens show. Nothing is written through it (187) ב:
-- every write path still judges the lead by the old rule (the table policies are untouched), so until the lead is
-- taken the person can read it and press "לקחתי", nothing else. (186) א: public.take_lead accepts the rule.
--
-- New: app.unowned_lead_visible (the rule for one lead), public.unowned_lead (the page's and the short screen's
-- fields), public.unowned_lead_timeline (its non-private entries and their files' names), public.unowned_leads_waiting
-- (the waiting list's rows) and public.unowned_leads_waiting_count (the menu's counter, (189)). No drop, no delete;
-- safe to run twice.

create or replace function app.unowned_lead_visible(p_org uuid, p_id uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  with me as (select app.membership_role(p_org) as role)
  select p_org is not null and p_id is not null and exists (
    select 1
      from me
      join public.leads l on l.organization_id = p_org and l.id = p_id
      join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
     where me.role in ('owner', 'admin', 'manager', 'member')
       and l.owner_id is null and l.converted_at is null and l.deleted_at is null
       and s.kind = 'open'
       and (l.team_id is null or me.role in ('owner', 'admin')
            or exists (select 1 from public.team_members tm
                        where tm.organization_id = p_org and tm.team_id = l.team_id and tm.user_id = auth.uid())
            or (me.role = 'manager' and app.manages_team(l.team_id))))
$$;
-- only the definer functions below and public.take_lead call it
revoke all on function app.unowned_lead_visible(uuid, uuid) from public, anon, authenticated;

-- The unowned leads the caller is offered (the rule above, set-based: the role read once), that nobody answered yet
-- by the waiting screen's rule (SPD-02: a contact entry a person logged that is not a private note) and that were not
-- imported; at most p_limit, the oldest first when p_oldest (the list), else in no order, so the counter stops at its
-- limit. Definer, no grants: only the public functions below read it.
create or replace function app.unowned_waiting_leads(p_org uuid, p_limit integer, p_oldest boolean)
returns table (id uuid, full_name text, email text, phone text, phone_e164 text, company_name text, source_id uuid,
               team_id uuid, created_at timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role text := app.membership_role(p_org);
  v_user uuid := auth.uid();
  v_limit integer := greatest(0, coalesce(p_limit, 0));
begin
  if p_org is null or v_user is null or v_role is null or v_role not in ('owner', 'admin', 'manager', 'member') or v_limit = 0 then
    return;
  end if;
  return query
    select l.id, l.full_name, l.email, l.phone, l.phone_e164, l.company_name, l.source_id, l.team_id, l.created_at
      from public.leads l
      join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
     where l.organization_id = p_org
       and l.owner_id is null and l.converted_at is null and l.deleted_at is null and l.import_job_id is null
       and s.kind = 'open'
       and (l.team_id is null or v_role in ('owner', 'admin')
            or exists (select 1 from public.team_members tm
                        where tm.organization_id = p_org and tm.team_id = l.team_id and tm.user_id = v_user)
            or (v_role = 'manager' and app.manages_team(l.team_id)))
       and not exists (select 1 from public.activities a
                        where a.organization_id = l.organization_id and a.lead_id = l.id
                          and a.type = any (app.contact_types()) and a.created_by is not null and not a.is_private)
     order by case when p_oldest then l.created_at end, case when p_oldest then l.id end
     limit v_limit;
end;
$$;
revoke all on function app.unowned_waiting_leads(uuid, integer, boolean) from public, anon, authenticated;

-- The waiting list's rows (oldest first, at most p_limit, 1..200): the fields that list shows, nothing else.
create or replace function public.unowned_leads_waiting(p_org uuid, p_limit integer default 200)
returns table (id uuid, full_name text, email text, phone text, phone_e164 text, company_name text, source_id uuid,
               team_id uuid, created_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select * from app.unowned_waiting_leads(p_org, greatest(1, least(coalesce(p_limit, 200), 200)), true)
$$;
revoke all on function public.unowned_leads_waiting(uuid, integer) from public, anon;
grant execute on function public.unowned_leads_waiting(uuid, integer) to authenticated;

-- (189) the menu's counter: how many of them there are, counted up to 100 (the menu shows "99+"); the helper stops at 100
create or replace function public.unowned_leads_waiting_count(p_org uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from app.unowned_waiting_leads(p_org, 100, false)
$$;
revoke all on function public.unowned_leads_waiting_count(uuid) from public, anon;
grant execute on function public.unowned_leads_waiting_count(uuid) to authenticated;

-- The fields the take-only lead page and the short screen show, or null when the rule does not offer the lead
create or replace function public.unowned_lead(p_org uuid, p_lead uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', l.id, 'full_name', l.full_name, 'email', l.email, 'phone', l.phone, 'phone_e164', l.phone_e164,
           'company_name', l.company_name, 'source_id', l.source_id, 'status_id', l.status_id, 'message', l.message,
           'created_at', l.created_at, 'original_created_on', l.original_created_on,
           'last_contacted_at', l.last_contacted_at, 'gender', l.gender)
    from public.leads l
   where l.organization_id = p_org and l.id = p_lead
     and app.unowned_lead_visible(p_org, p_lead)
$$;
revoke all on function public.unowned_lead(uuid, uuid) from public, anon;
grant execute on function public.unowned_lead(uuid, uuid) to authenticated;

-- The metadata an entry of the take-only timeline carries: ONLY the keys the timeline draws its text from (getTimeline in
-- src/features/activities/queries.ts: the entry's kind and channel, a call's outcome, status/stage ids, the quote id and
-- number, a purged link's type, the reps of a pass-on and its target, an automation's name, the form's name), each only as
-- a plain string or number. Never a merge's copy of the duplicate (`merged`), an inquiry's attribution, custom fields,
-- names, phones or emails.
create or replace function app.unowned_timeline_metadata(p_metadata jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_metadata) = 'object' then coalesce((
    select jsonb_object_agg(e.key, e.value)
      from jsonb_each(p_metadata) e
     where e.key = any (array['kind', 'via', 'outcome', 'form_name', 'from_status_id', 'to_status_id', 'from_stage_id',
                              'to_stage_id', 'quote_id', 'number', 'target_type', 'from_user_id', 'to_user_id',
                              'target_minutes', 'automation_name'])
       and jsonb_typeof(e.value) in ('string', 'number')), '{}'::jsonb)
  else '{}'::jsonb end
$$;
revoke all on function app.unowned_timeline_metadata(jsonb) from public, anon, authenticated;

-- Its timeline for the same page: the newest 100 entries that are not private notes (of anyone), in the columns the
-- timeline shows (the metadata through the allow-list above), and the names of their files and the lead's (confirmed, not on a private note); no file content,
-- path or download (a download still needs the old rule). Null when the rule does not offer the lead.
create or replace function public.unowned_lead_timeline(p_org uuid, p_lead uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select case when app.unowned_lead_visible(p_org, p_lead) then jsonb_build_object(
    'activities', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.is_pinned desc, x.occurred_at desc, x.id desc)
        from (select a.id, a.type, a.body, app.unowned_timeline_metadata(a.metadata) as metadata, a.occurred_at,
                     a.created_by, a.created_at, a.is_pinned, a.is_private, a.activity_type_id
                from public.activities a
               where a.organization_id = p_org and a.lead_id = p_lead and not a.is_private
               order by a.is_pinned desc, a.occurred_at desc, a.id desc
               limit 100) x), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes,
                                          'created_at', f.created_at, 'activity_id', f.activity_id)
                       order by f.created_at desc, f.id desc)
        from public.files f
       where f.organization_id = p_org and f.lead_id = p_lead and f.unconfirmed_since is null and f.custom_field_key is null
         and (f.activity_id is null
              or exists (select 1 from public.activities a
                          where a.organization_id = f.organization_id and a.id = f.activity_id and not a.is_private))), '[]'::jsonb))
  end
$$;
revoke all on function public.unowned_lead_timeline(uuid, uuid) from public, anon;
grant execute on function public.unowned_lead_timeline(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- (186) א: take_lead also takes a lead offered to the caller through app.unowned_lead_visible
-- ----------------------------------------------------------------------------
-- The body of 012800 (lead_new_notifications); only the read check gains app.unowned_lead_visible.
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
     or not (app.can_read_record(p_org, v_lead.owner_id, v_lead.team_id)
             -- SPD-01 (owner (186) א): an unowned open lead offered to the caller through app.unowned_lead_visible
             or app.unowned_lead_visible(p_org, p_lead)) then
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

