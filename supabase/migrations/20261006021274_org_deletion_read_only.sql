-- =============================================================================
-- 021274 ADM-03: read-only means read-only, and privacy requests stay open (lead's decisions, 13 November 2026)
-- =============================================================================
-- * app.org_write_blocked(org) = app.org_closed(org) or app.org_deletion_pending(org). app.org_closed keeps its meaning
--   (suspended or cancelled): leave_closed_organization, the roadmap vote and every other reader of it are unchanged.
-- * The policies that refuse writes in a closed business refuse them while a deletion is pending too: the business row,
--   another person's membership (a person may still change or leave their own), invitations, support access grants and
--   the customer sending pause. Each is the latest definition (_suspended_lead_notices.sql, 0173; _customer_sending_pause.sql,
--   021134) with app.org_closed replaced by app.org_write_blocked.
-- * public.transfer_ownership: the body of 0173, plus a refusal while a deletion is pending (hint org_deletion:read_only).
-- * PRK-02 (privacy, never locked): the public privacy-request page answers while a deletion is pending. Its link rule and
--   the staff status read app.org_public_pages_open_base, the public-pages rule without the pending deletion (0173's body).
-- The owner's cancel (public.org_deletion_cancel, definer) and the full export (reads) are untouched.
-- Safe to run twice. Nothing is removed by this file.

create or replace function app.org_write_blocked(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select app.org_closed(p_org) or app.org_deletion_pending(p_org) $$;
revoke all on function app.org_write_blocked(uuid) from public, anon;
grant execute on function app.org_write_blocked(uuid) to authenticated, service_role;

alter policy organizations_update on public.organizations
  using (app.is_admin(id) and not app.org_write_blocked(id))
  with check (app.is_admin(id) and not app.org_write_blocked(id));
alter policy memberships_update on public.memberships
  using ((app.is_admin(organization_id) and not app.org_write_blocked(organization_id)) or user_id = (select auth.uid()))
  with check ((app.is_admin(organization_id) and not app.org_write_blocked(organization_id)) or user_id = (select auth.uid()));
alter policy memberships_delete on public.memberships
  using ((app.is_admin(organization_id) and not app.org_write_blocked(organization_id)) or user_id = (select auth.uid()));
alter policy invitations_update on public.invitations
  using (app.is_admin(organization_id) and not app.org_write_blocked(organization_id))
  with check (app.is_admin(organization_id) and not app.org_write_blocked(organization_id));
alter policy invitations_delete on public.invitations
  using (app.is_admin(organization_id) and not app.org_write_blocked(organization_id));
alter policy support_access_grants_insert on public.support_access_grants
  with check (app.is_admin(organization_id) and not app.org_write_blocked(organization_id) and granted_by = (select auth.uid()));
alter policy support_access_grants_update on public.support_access_grants
  using (app.is_admin(organization_id) and not app.org_write_blocked(organization_id))
  with check (app.is_admin(organization_id) and not app.org_write_blocked(organization_id));
alter policy org_sending_pauses_insert on public.org_sending_pauses
  with check (app.is_admin(organization_id) and not app.org_write_blocked(organization_id));
alter policy org_sending_pauses_update on public.org_sending_pauses
  using (app.is_admin(organization_id) and not app.org_write_blocked(organization_id))
  with check (app.is_admin(organization_id) and not app.org_write_blocked(organization_id));

-- transfer_ownership(): the body of _suspended_lead_notices.sql (0173), plus: not while a deletion is pending
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
  if app.org_deletion_pending(p_organization_id) then
    raise exception 'the business waits to be deleted' using errcode = 'P0001', hint = 'org_deletion:read_only';
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

-- ----------------------------------------------------------------------------
-- PRK-02: the privacy-request page is never closed by a pending deletion
-- ----------------------------------------------------------------------------
-- the public-pages rule of _suspended_lead_notices.sql (0173), without the pending deletion
create or replace function app.org_public_pages_open_base(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org and o.deleted_at is null and o.status <> 'cancelled'
  )
$$;
revoke all on function app.org_public_pages_open_base(uuid) from public, anon, authenticated, service_role;

-- app.privacy_request_link_of: the body of _privacy_requests.sql (021147), with the base rule
create or replace function app.privacy_request_link_of(p_token text) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select l.organization_id from app.privacy_request_links l
   where coalesce(p_token, '') ~ '^[A-Za-z0-9_-]{64}$'
     and l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     and app.org_public_pages_open_base(l.organization_id)
$$;
revoke all on function app.privacy_request_link_of(text) from public, anon, authenticated, service_role;

-- public.privacy_request_link_status: the body of _privacy_requests.sql (021147), with the base rule
create or replace function public.privacy_request_link_status(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_created timestamptz;
begin
  if not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select l.created_at into v_created from app.privacy_request_links l
   where l.organization_id = p_org and l.token_hash is not null;
  return jsonb_build_object('active', v_created is not null, 'created_at', v_created,
                            'pages_open', app.org_public_pages_open_base(p_org));
end;
$$;
revoke all on function public.privacy_request_link_status(uuid) from public, anon;
grant execute on function public.privacy_request_link_status(uuid) to authenticated;
