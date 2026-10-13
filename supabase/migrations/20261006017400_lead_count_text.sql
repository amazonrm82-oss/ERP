-- =============================================================================
-- 0164 Lead counts in notices: one rule for one and for many (owner's answer of 13 October
-- 2026, "ספירת לידים בהודעות")
-- =============================================================================
-- One lead: "ליד אחד מחכה לכם ב<business>. כדי לראות אותו, חדשו את המנוי."
-- Two or more: "<n> לידים מחכים לכם ב<business>. כדי לראות אותם, חדשו את המנוי."
-- app.leads_waiting_text() is the one place it is written; leadsWaitingText() in
-- src/features/notifications/lead-count.ts mirrors it (a database test compares them).
-- app.run_suspended_lead_notices() is the body of 0163 using it.
--
-- Leaving a suspended or cancelled business (owner's answer of 13 October 2026, "עזיבת עסק מושהה או
-- מבוטל"): public.leave_closed_organization(org). A closed business hides even a member's own
-- membership row (0161), so the normal leave cannot reach it. Leaving here sets the membership's
-- status to 'suspended' instead of removing the row: the records a person owns point at their
-- membership (composite foreign keys, no on delete action), so removing it would be refused for
-- anyone who owns a record, and a closed business cannot hand records over. A suspended membership
-- has no access and is out of the person's list (closed_orgs, the business picker); the records stay
-- with their owner; the memberships audit trigger logs the change with the person as actor. Coming
-- back takes an admin of the reopened business. The owner cannot leave; an open business uses the
-- normal path.
--
-- Coming back (review of 13 October 2026): create_invitation() may invite someone whose membership
-- is 'suspended', and accept_invitation() reactivates that same row with the invited role and seat
-- (the membership guard's seat rules apply); an active member is still "already a member". Both are
-- the bodies of rpc (0005) with only that changed.
-- Every statement is safe to run twice.

create or replace function app.leads_waiting_text(p_count integer, p_name text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_count = 1
              then 'ליד אחד מחכה לכם ב' || p_name || '. כדי לראות אותו, חדשו את המנוי.'
              else p_count || ' לידים מחכים לכם ב' || p_name || '. כדי לראות אותם, חדשו את המנוי.'
         end
$$;
revoke all on function app.leads_waiting_text(integer, text) from public, anon, authenticated;

-- the body of suspended_lead_notices (0163), with the count text from app.leads_waiting_text()
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
    perform app.owner_plan_notice(t.organization_id, app.leads_waiting_text(t.leads_waiting, t.name));
    update app.org_suspensions set leads_waiting = 0, lead_last_notice_at = p_now where id = t.id;
    v_sent := v_sent + 1;
  end loop;
  return jsonb_build_object('enabled', true, 'sent', v_sent);
end;
$$;
revoke all on function app.run_suspended_lead_notices(timestamptz, uuid) from public, anon, authenticated;

create or replace function public.leave_closed_organization(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.membership_role;
begin
  if auth.uid() is null or not app.session_verified() then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select m.role into v_role from public.memberships m
   where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active';
  if v_role is null then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if v_role = 'owner' then
    raise exception 'the owner cannot leave the business' using errcode = '42501', hint = 'leave:owner';
  end if;
  if not app.org_closed(p_org) then
    raise exception 'the business is open; leave it the usual way' using errcode = 'P0001', hint = 'leave:open';
  end if;
  update public.memberships m set status = 'suspended'
   where m.organization_id = p_org and m.user_id = auth.uid();
end;
$$;
revoke all on function public.leave_closed_organization(uuid) from public, anon;
grant execute on function public.leave_closed_organization(uuid) to authenticated;

-- create_invitation(): the body of rpc (0005); an active membership only counts as "already a member"
create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email           text,
  p_role            public.membership_role default 'member'
) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_role public.membership_role := app.role_in(p_organization_id);
  v_token text;
begin
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'only an admin can invite users' using errcode = '42501';
  end if;
  if not app.org_writable(p_organization_id) then
    raise exception 'the organization is read-only' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'cannot invite an owner' using errcode = '22023';
  end if;
  if p_role = 'admin' and v_role <> 'owner' then
    raise exception 'only the owner can invite an admin' using errcode = '42501';
  end if;
  if p_role = 'viewer' and not app.org_has_feature(p_organization_id, 'view_seats') then
    raise exception 'view-only seats are not included in this plan' using errcode = 'P0001', hint = 'feature:view_seats';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and lower(u.email) = v_email
      -- 0174: someone whose membership is suspended (left a closed business, or suspended by an admin)
      -- may be invited again; accept_invitation() reactivates that row
      and m.status = 'active'
  ) then
    raise exception 'this user is already a member' using errcode = '23505';
  end if;

  -- a new invitation replaces any pending one for the same address
  update public.invitations i
     set revoked_at = now()
   where i.organization_id = p_organization_id and i.email = v_email
     and i.accepted_at is null and i.revoked_at is null;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into public.invitations (organization_id, email, role, token_hash, invited_by)
  values (p_organization_id, v_email, p_role,
          encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid());

  return v_token;
end;
$$;

-- accept_invitation(): the body of rpc (0005); a suspended membership is reactivated
create or replace function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv public.invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_inv
  from public.invitations i
  where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
  for update;

  if not found or v_inv.revoked_at is not null or v_inv.accepted_at is not null
     or v_inv.expires_at <= now() then
    raise exception 'the invitation is invalid or has expired' using errcode = 'P0002';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is distinct from v_inv.email then
    raise exception 'this invitation was sent to a different email address' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.memberships m
    where m.organization_id = v_inv.organization_id and m.user_id = v_uid and m.status = 'active'
  ) then
    raise exception 'you are already a member of this organization' using errcode = '23505';
  end if;

  -- 0174: a suspended membership (left a closed business, or suspended by an admin) comes back as
  -- the same row, with the invited role and seat; the seat rules of the membership guard apply
  update public.memberships m
     set role = v_inv.role,
         seat_type = case when v_inv.role = 'viewer' then 'view' else 'full' end::public.seat_type,
         status = 'active'
   where m.organization_id = v_inv.organization_id and m.user_id = v_uid and m.status = 'suspended';
  if not found then
    insert into public.memberships (organization_id, user_id, role, seat_type)
    values (v_inv.organization_id, v_uid, v_inv.role,
            case when v_inv.role = 'viewer' then 'view' else 'full' end::public.seat_type);
  end if;

  update public.invitations set accepted_at = now() where id = v_inv.id;

  return v_inv.organization_id;
end;
$$;

notify pgrst, 'reload schema';
