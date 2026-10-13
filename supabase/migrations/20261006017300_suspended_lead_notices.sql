-- =============================================================================
-- 0163 A new lead for a suspended business: a notice to its owner, a count only.
-- Built OFF behind its own platform switch (owner's answer of 13 October 2026,
-- "התראת ליד חדש לבעלים של עסק מושהה")
-- =============================================================================
-- Public forms keep taking leads while a business is suspended (0161). The owner decided
-- its owner may be told, with limits:
-- * Only the owner of the business (not admins, not reps); no detail of the lead at all
--   (no name, phone, content or form name), only how many.
-- * The first lead after the suspension: a notice at once ("נכנס ליד חדש ל<business>. כדי
--   לראות אותו, חדשו את המנוי."). After that at most one a day, with the count of leads
--   since the last notice ("<n> לידים מחכים לכם ב<business>. כדי לראות אותם, חדשו את
--   המנוי."). Kind 'system' (cannot be muted): the bell and, for who turned it on, push
--   through the existing notifications -> dispatch_push path. entity_type 'subscription'
--   with the business id: the app links it to the plan page; the push payload carries the
--   title and the business name only. Email waits for the email layer (no provider yet).
-- * The notices stop when the business leaves 'suspended' (pays, or becomes 'cancelled'):
--   they are kept on its row in app.org_suspensions (0162), which ends then; a new
--   suspension starts afresh with a first notice.
-- * Built OFF: app.suspension_cancel_settings.lead_notices (its own switch in the same
--   settings row), changed only by public.platform_set_suspended_lead_notices() (platform
--   owner, aal2), logged 'suspended_lead_notices.switch'. While off nothing is counted or sent.
-- * Counting: trigger leads_suspended_notice (after insert on public.leads) keeps a counter
--   on the open suspension; no lead id or lead data is stored.
-- * pg_cron 'crm-suspended-lead-notices' runs app.run_suspended_lead_notices() daily at
--   05:25 UTC: a business with leads waiting whose last notice was on an earlier local day
--   gets the daily notice.
-- * Cancelled business (owner's answer of 13 October 2026, "טפסים של עסק מבוטל"): it keeps refusing
--   leads (intake_submit refuses before any write, so not even an IP hash is kept), and every public
--   page of it shows only "הטופס הזה אינו פעיל כרגע". app.org_public_pages_open(org) is the one rule
--   for every public page of a business (form and QR now; booking, business card and site widget
--   when they are built); intake_form() answers only {"inactive": true} when it is false. Body of
--   wave2_plan_keys (0146) otherwise.
-- * The cancel stage (0162) warns 14 and 3 days before the cancel day instead of 30, 7 and 1, owner
--   only, kind 'system', leading to the plan page: "בעוד <n> ימים החשבון של <business> ייסגר, המידע
--   יימחק והטפסים באתר יפסיקו לקלוט פניות. כדי להמשיך, חדשו את המנוי." The cancel day is planned at
--   least 14 days ahead; a 3-day notice sent late moves the day so it is always 3 local days away;
--   the move happens only after that notice. app.run_suspension_cancel() and
--   platform_set_suspension_cancel() are redefined (bodies of 0162 with only that changed; the old
--   notice columns stay unused). Nothing is ever deleted here. Still OFF.
-- * Review of 13 October 2026: a closed business changes no settings or membership (organizations,
--   memberships (others), invitations, support grants, transfer_ownership(); read_only unchanged), a
--   notification of a closed business is deleted only by who reads it, and claim_push_notifications()
--   pushes only the system notices to the owner of a closed business.
-- * Email: none of these notices is emailed yet; the email layer waits for a provider
--   (EMAIL-LAYER marker below).
-- Every statement is safe to run twice.

alter table app.suspension_cancel_settings
  add column if not exists lead_notices boolean not null default false,
  add column if not exists lead_notices_at timestamptz;

alter table app.org_suspensions
  add column if not exists lead_first_notice_at timestamptz,
  add column if not exists lead_last_notice_at timestamptz,
  add column if not exists leads_waiting integer not null default 0;

-- one 'system' notice to the active owner of a business, leading to the plan page.
-- EMAIL-LAYER: the owner decided these go by email too; there is no email layer yet (provider not chosen).
create or replace function app.owner_plan_notice(p_org uuid, p_title text) returns void
language sql security definer
set search_path = ''
as $$
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select m.organization_id, m.user_id, 'system', p_title, null, 'subscription', m.organization_id
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role = 'owner';
$$;
revoke all on function app.owner_plan_notice(uuid, text) from public, anon, authenticated;

-- a lead came into a suspended business: the first one is told at once, the rest are counted
create or replace function app.suspended_lead_arrived() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_name text;
  v_first bigint;
begin
  select o.name into v_name from public.organizations o
   where o.id = new.organization_id and o.status = 'suspended' and o.deleted_at is null;
  if v_name is null
     or not coalesce((select st.lead_notices from app.suspension_cancel_settings st where st.id), false) then
    return null;
  end if;
  -- one row lock decides who is first, so two leads at once give one first notice
  update app.org_suspensions s
     set lead_first_notice_at = now(), lead_last_notice_at = now()
   where s.organization_id = new.organization_id and s.ended_at is null and s.lead_first_notice_at is null
  returning s.id into v_first;
  if v_first is not null then
    perform app.owner_plan_notice(new.organization_id,
      'נכנס ליד חדש ל' || v_name || '. כדי לראות אותו, חדשו את המנוי.');
  else
    update app.org_suspensions s set leads_waiting = s.leads_waiting + 1
     where s.organization_id = new.organization_id and s.ended_at is null;
  end if;
  return null;
end;
$$;
revoke all on function app.suspended_lead_arrived() from public, anon, authenticated;

create or replace trigger leads_suspended_notice after insert on public.leads
  for each row execute function app.suspended_lead_arrived();

-- the daily notice. p_now and p_org exist for the tests; the cron passes neither.
create or replace function app.run_suspended_lead_notices(p_now timestamptz default now(), p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  t record;
  v_sent integer := 0;
begin
  if not coalesce((select st.lead_notices from app.suspension_cancel_settings st where st.id for share), false) then
    return jsonb_build_object('enabled', false);
  end if;
  for t in
    select s.id, s.organization_id, s.leads_waiting, o.name
      from app.org_suspensions s
      join public.organizations o on o.id = s.organization_id
     where s.ended_at is null
       and o.status = 'suspended'
       and o.deleted_at is null
       and s.leads_waiting > 0
       and (s.lead_last_notice_at is null
            or (s.lead_last_notice_at at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date
               < (p_now at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date)
       and (p_org is null or s.organization_id = p_org)
     order by s.id
     for update of s
  loop
    perform app.owner_plan_notice(t.organization_id,
      t.leads_waiting || ' לידים מחכים לכם ב' || t.name || '. כדי לראות אותם, חדשו את המנוי.');
    update app.org_suspensions set leads_waiting = 0, lead_last_notice_at = p_now where id = t.id;
    v_sent := v_sent + 1;
  end loop;
  return jsonb_build_object('enabled', true, 'sent', v_sent);
end;
$$;
revoke all on function app.run_suspended_lead_notices(timestamptz, uuid) from public, anon, authenticated;

-- the switch, for every platform role
create or replace function public.platform_suspended_lead_notices_status() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.suspension_cancel_settings;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  select * into v_row from app.suspension_cancel_settings st where st.id;
  return jsonb_build_object(
    'enabled', coalesce(v_row.lead_notices, false),
    'enabled_at', v_row.lead_notices_at,
    'waiting', (select coalesce(sum(s.leads_waiting), 0) from app.org_suspensions s where s.ended_at is null)
  );
end;
$$;
revoke all on function public.platform_suspended_lead_notices_status() from public, anon;
grant execute on function public.platform_suspended_lead_notices_status() to authenticated;

-- the platform owner turns the notices on or off
create or replace function public.platform_set_suspended_lead_notices(p_enabled boolean) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old boolean;
begin
  perform app.require_platform(array[]::text[]);
  if p_enabled is null then
    raise exception 'invalid value' using errcode = '22023';
  end if;
  insert into app.suspension_cancel_settings (id) values (true) on conflict (id) do nothing;
  select st.lead_notices into v_old from app.suspension_cancel_settings st where st.id for update;
  if v_old = p_enabled then
    return jsonb_build_object('enabled', p_enabled, 'changed', false);
  end if;
  update app.suspension_cancel_settings
     set lead_notices = p_enabled,
         lead_notices_at = case when p_enabled then now() else lead_notices_at end,
         updated_by = auth.uid(), updated_at = now()
   where id;
  perform app.log_platform('suspended_lead_notices.switch', null, jsonb_build_object('old', v_old, 'new', p_enabled));
  return jsonb_build_object('enabled', p_enabled, 'changed', true);
end;
$$;
revoke all on function public.platform_set_suspended_lead_notices(boolean) from public, anon;
grant execute on function public.platform_set_suspended_lead_notices(boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Public pages of a cancelled business
-- -----------------------------------------------------------------------------
-- the one rule every public page of a business follows: open unless cancelled or deleted
create or replace function app.org_public_pages_open(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org and o.deleted_at is null and o.status <> 'cancelled'
  )
$$;
revoke all on function app.org_public_pages_open(uuid) from public, anon, authenticated;
grant execute on function app.org_public_pages_open(uuid) to service_role;

-- intake_form(): the body of wave2_plan_keys (0146), plus the closed-pages marker
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
  -- FLD-04: the "נבנה ב-Mexuz" line
  v_built_with boolean;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
  end if;
  -- 0163: a business whose public pages are closed (cancelled, deleted): a marker and nothing else
  if not app.org_public_pages_open(v_form.organization_id) then
    return jsonb_build_object('inactive', true);
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

  -- SPD-05: the call-back choice: the business's time zone, whether "now" is
  -- offered, and the slots still open today and on the next working day
  if v_form.callback_choice then
    select jsonb_build_object('time_zone', app.intake_zone(o.timezone))
           || app.intake_callback_offer(v_form.organization_id, v_form.callback_slots_off, now())
      into v_callback
      from public.organizations o
     where o.id = v_form.organization_id;
  end if;

  -- FLD-04: shown unless the plan or the override turns remove_built_with on; a bad
  -- plan value never fails the form (the line then shows)
  begin
    v_built_with := coalesce(app.show_built_with(v_form.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'built_with', v_built_with,
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

-- -----------------------------------------------------------------------------
-- The cancel stage: notices 14 and 3 days before (replaces 30, 7 and 1)
-- -----------------------------------------------------------------------------
alter table app.org_suspensions
  add column if not exists notice_14_at timestamptz,
  add column if not exists notice_3_at timestamptz;


-- the body of cancel_after_suspension (0162), with the 14 and 3 day notices
create or replace function app.run_suspension_cancel(p_now timestamptz default now(), p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  t record;
  v_tz text;
  v_at timestamptz;
  v_days integer;
  v_planned integer := 0;
  v_notices integer := 0;
  v_cancelled integer := 0;
begin
  select st.enabled into v_enabled from app.suspension_cancel_settings st where st.id for share;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('enabled', false);
  end if;

  for t in
    select s.*, o.timezone, o.name
      from app.org_suspensions s
      join public.organizations o on o.id = s.organization_id
     where s.ended_at is null
       and o.status = 'suspended'
       and o.deleted_at is null
       and (p_org is null or s.organization_id = p_org)
     order by s.id
     for update of s
  loop
    v_tz := coalesce(t.timezone, 'Asia/Jerusalem');
    if t.cancel_at is null then
      -- the start of the local day after 90 days of suspension, and at least 14 days from now
      v_at := app.trial_end_day_start(v_tz,
                (greatest(t.suspended_at + interval '90 days', p_now + interval '14 days') at time zone v_tz)::date + 1);
      update app.org_suspensions set cancel_at = v_at where id = t.id;
      t.cancel_at := v_at;
      v_planned := v_planned + 1;
    end if;

    if t.notice_3_at is not null and t.notice_3_at < t.cancel_at and p_now >= t.cancel_at then
      update app.org_suspensions set cancelled_at = p_now where id = t.id;
      -- the trigger ends the suspension as 'cancelled'; nothing is deleted
      update public.organizations set status = 'cancelled' where id = t.organization_id and status = 'suspended';
      perform app.log_platform('suspension.cancelled', t.organization_id, jsonb_build_object('suspended_at', t.suspended_at));
      v_cancelled := v_cancelled + 1;
    elsif t.notice_3_at is null and p_now >= t.cancel_at - interval '3 days' then
      -- late: the cancel day moves so it is still 3 local days away
      v_at := greatest(t.cancel_at, app.trial_end_day_start(v_tz, (p_now at time zone v_tz)::date + 3));
      v_days := (v_at at time zone v_tz)::date - (p_now at time zone v_tz)::date;
      perform app.owner_plan_notice(t.organization_id,
        'בעוד ' || v_days || ' ימים החשבון של ' || t.name
        || ' ייסגר, המידע יימחק והטפסים באתר יפסיקו לקלוט פניות. כדי להמשיך, חדשו את המנוי.');
      update app.org_suspensions
         set notice_3_at = p_now, cancel_at = v_at, notice_14_at = coalesce(notice_14_at, p_now)
       where id = t.id;
      v_notices := v_notices + 1;
    elsif t.notice_14_at is null and p_now >= t.cancel_at - interval '14 days' then
      v_days := (t.cancel_at at time zone v_tz)::date - (p_now at time zone v_tz)::date;
      perform app.owner_plan_notice(t.organization_id,
        'בעוד ' || v_days || ' ימים החשבון של ' || t.name
        || ' ייסגר, המידע יימחק והטפסים באתר יפסיקו לקלוט פניות. כדי להמשיך, חדשו את המנוי.');
      update app.org_suspensions set notice_14_at = p_now where id = t.id;
      v_notices := v_notices + 1;
    end if;
  end loop;

  return jsonb_build_object('enabled', true, 'planned', v_planned, 'notices', v_notices, 'cancelled', v_cancelled);
end;
$$;
revoke all on function app.run_suspension_cancel(timestamptz, uuid) from public, anon, authenticated;

-- the body of cancel_after_suspension (0162); switching off also clears the 14 and 3 day notices
create or replace function public.platform_set_suspension_cancel(p_enabled boolean) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old boolean;
  v_cleared integer := 0;
begin
  perform app.require_platform(array[]::text[]);
  if p_enabled is null then
    raise exception 'invalid value' using errcode = '22023';
  end if;
  insert into app.suspension_cancel_settings (id) values (true) on conflict (id) do nothing;
  select st.enabled into v_old from app.suspension_cancel_settings st where st.id for update;
  if v_old = p_enabled then
    return jsonb_build_object('enabled', p_enabled, 'changed', false);
  end if;

  if p_enabled then
    update app.suspension_cancel_settings
       set enabled = true, enabled_at = now(), updated_by = auth.uid(), updated_at = now() where id;
  else
    update app.suspension_cancel_settings
       set enabled = false, updated_by = auth.uid(), updated_at = now() where id;
    -- off = no cancel days: a later switch-on plans and warns from the start
    update app.org_suspensions
       set cancel_at = null, notice_30_at = null, notice_7_at = null, notice_1_at = null,
           notice_14_at = null, notice_3_at = null
     where ended_at is null and cancel_at is not null;
    get diagnostics v_cleared = row_count;
  end if;

  perform app.log_platform('suspension_cancel.switch', null, jsonb_build_object('old', v_old, 'new', p_enabled, 'cleared', v_cleared));
  return jsonb_build_object('enabled', p_enabled, 'changed', true, 'cleared', v_cleared);
end;
$$;
revoke all on function public.platform_set_suspension_cancel(boolean) from public, anon;
grant execute on function public.platform_set_suspension_cancel(boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Review of 13 October 2026: a closed business (suspended, cancelled) changes no settings
-- and no membership, read_only unchanged
-- -----------------------------------------------------------------------------
create or replace function app.org_closed(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select exists (select 1 from public.organizations o where o.id = p_org and app.org_status_closed(o.status)) $$;
revoke all on function app.org_closed(uuid) from public, anon;
grant execute on function app.org_closed(uuid) to authenticated, service_role;

alter policy organizations_update on public.organizations
  using (app.is_admin(id) and not app.org_closed(id))
  with check (app.is_admin(id) and not app.org_closed(id));
-- a person may still change or leave their own membership; admins manage others only while open
alter policy memberships_update on public.memberships
  using ((app.is_admin(organization_id) and not app.org_closed(organization_id)) or user_id = (select auth.uid()))
  with check ((app.is_admin(organization_id) and not app.org_closed(organization_id)) or user_id = (select auth.uid()));
alter policy memberships_delete on public.memberships
  using ((app.is_admin(organization_id) and not app.org_closed(organization_id)) or user_id = (select auth.uid()));
alter policy invitations_update on public.invitations
  using (app.is_admin(organization_id) and not app.org_closed(organization_id))
  with check (app.is_admin(organization_id) and not app.org_closed(organization_id));
alter policy invitations_delete on public.invitations
  using (app.is_admin(organization_id) and not app.org_closed(organization_id));
alter policy support_access_grants_insert on public.support_access_grants
  with check (app.is_admin(organization_id) and not app.org_closed(organization_id) and granted_by = (select auth.uid()));
alter policy support_access_grants_update on public.support_access_grants
  using (app.is_admin(organization_id) and not app.org_closed(organization_id))
  with check (app.is_admin(organization_id) and not app.org_closed(organization_id));
-- notifications: deleting follows reading (0161)
alter policy notifications_delete on public.notifications
  using (user_id = (select auth.uid()) and app.session_verified() and app.org_open_to_me(organization_id));

-- transfer_ownership(): the body of rpc (0005), plus: not while the business is closed
create or replace function public.transfer_ownership(
  p_organization_id uuid,
  p_new_owner       uuid
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if app.role_in(p_organization_id) is distinct from 'owner' then
    raise exception 'only the owner can transfer ownership' using errcode = '42501';
  end if;
  if app.org_closed(p_organization_id) then
    raise exception 'the organization is closed until payment' using errcode = 'P0001', hint = 'org:suspended';
  end if;
  if p_new_owner = v_uid then
    raise exception 'you already own this organization' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organization_id = p_organization_id and m.user_id = p_new_owner
      and m.status = 'active' and m.seat_type = 'full'
  ) then
    raise exception 'the new owner must be an active member with a full seat' using errcode = '22023';
  end if;

  update public.memberships set role = 'admin'
   where organization_id = p_organization_id and user_id = v_uid;
  update public.memberships set role = 'owner'
   where organization_id = p_organization_id and user_id = p_new_owner;
end;
$$;
revoke all on function public.transfer_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated, service_role;

-- claim_push_notifications(): the body of lead_push_actions (0122), plus the closed-business filter
create or replace function public.claim_push_notifications(p_limit integer default 200)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  with batch as (
    select n.id
      from public.notifications n
     where n.pushed_at is null and n.read_at is null and n.created_at > now() - interval '1 hour'
       and exists (select 1 from public.push_subscriptions p where p.user_id = n.user_id)
       -- 0163: a closed business pushes only the system notices to its owner (stored before the closing: none)
       and (not exists (select 1 from public.organizations o2
                         where o2.id = n.organization_id and app.org_status_closed(o2.status))
            or (n.type = 'system' and exists (
                  select 1 from public.memberships m
                   where m.organization_id = n.organization_id and m.user_id = n.user_id
                     and m.status = 'active' and m.role = 'owner')))
     order by n.created_at
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
     for update skip locked
  ), claimed as (
    update public.notifications n
       set pushed_at = now()
      from batch
     where n.id = batch.id
    returning n.id, n.organization_id, n.user_id, n.type, n.title, n.body, n.entity_type, n.entity_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'organization_id', c.organization_id, 'user_id', c.user_id,
           'title', c.title, 'body', c.body, 'entity_type', c.entity_type, 'entity_id', c.entity_id,
           'organization_name', o.name,
           'type', c.type,
           'lead_actions', c.entity_type = 'lead' and c.entity_id is not null
             and c.type in ('lead_new', 'assigned')
             and exists (
               select 1 from public.leads l
                where l.organization_id = c.organization_id and l.id = c.entity_id
                  and l.deleted_at is null and l.converted_at is null
                  and (c.type = 'lead_new'
                       or (l.created_at > now() - interval '1 hour'
                           and exists (select 1 from public.form_submissions fs
                                        where fs.organization_id = c.organization_id and fs.lead_id = c.entity_id
                                          and fs.status = 'accepted'))))
         )), '[]'::jsonb)
    into v_result
    from claimed c
    join public.organizations o on o.id = c.organization_id;
  return v_result;
end;
$$;
revoke all on function public.claim_push_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_push_notifications(integer) to service_role;



do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-suspended-lead-notices', '25 5 * * *', 'select app.run_suspended_lead_notices();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
