-- =============================================================================
-- 0005 RPC: the operations a client performs through functions, not raw DML
-- =============================================================================
-- Every function here is exposed by the Supabase API as /rpc/<name>.
-- Each one ends with: revoke from public/anon, grant to authenticated.

-- ----------------------------------------------------------------------------
-- create_organization: the only way an organization comes to exist.
-- Creates the tenant, its owner, a 14-day Pro trial and the default setup.
-- ----------------------------------------------------------------------------
create or replace function public.create_organization(
  p_name      text,
  p_industry  text default null,
  p_team_size text default null,
  p_phone     text default null
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_pipeline uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'organization name is required' using errcode = '22023';
  end if;
  if (select count(*) from public.memberships m where m.user_id = v_uid and m.role = 'owner') >= 5 then
    raise exception 'a user can own at most 5 organizations' using errcode = 'P0001', hint = 'limit:owned_organizations';
  end if;

  insert into public.organizations (name, slug, industry, team_size, phone, created_by)
  values (
    btrim(p_name),
    'org-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    nullif(btrim(p_industry), ''),
    nullif(btrim(p_team_size), ''),
    nullif(btrim(p_phone), ''),
    v_uid
  )
  returning id into v_org;

  insert into public.subscriptions (organization_id, plan_key, status, trial_ends_at)
  values (v_org, 'pro', 'trialing', now() + interval '14 days');

  insert into public.org_usage (organization_id) values (v_org);

  insert into public.memberships (organization_id, user_id, role, seat_type)
  values (v_org, v_uid, 'owner', 'full');

  insert into public.pipelines (organization_id, name, position, is_default)
  values (v_org, 'מכירות', 0, true)
  returning id into v_pipeline;

  insert into public.stages (organization_id, pipeline_id, name, position, kind, probability, rot_days) values
    (v_org, v_pipeline, 'פנייה ראשונית', 0, 'open', 10, 7),
    (v_org, v_pipeline, 'שיחת היכרות',   1, 'open', 25, 7),
    (v_org, v_pipeline, 'הצעת מחיר',     2, 'open', 50, 14),
    (v_org, v_pipeline, 'משא ומתן',      3, 'open', 75, 14),
    (v_org, v_pipeline, 'נסגר בהצלחה',   4, 'won', 100, null),
    (v_org, v_pipeline, 'אבוד',          5, 'lost', 0, null);

  insert into public.lead_statuses (organization_id, name, kind, position, is_default) values
    (v_org, 'חדש',         'open',         0, true),
    (v_org, 'נוצר קשר',    'open',         1, false),
    (v_org, 'בטיפול',      'open',         2, false),
    (v_org, 'לא ענה',      'open',         3, false),
    (v_org, 'מוסמך',       'open',         4, false),
    (v_org, 'הומר',        'converted',    5, false),
    (v_org, 'לא רלוונטי',  'disqualified', 6, false);

  insert into public.lead_sources (organization_id, name, kind) values
    (v_org, 'הזנה ידנית', 'manual'),
    (v_org, 'טופס באתר',  'form'),
    (v_org, 'פייסבוק',    'facebook'),
    (v_org, 'WhatsApp',   'whatsapp'),
    (v_org, 'טלפון',      'phone'),
    (v_org, 'המלצה',      'other'),
    (v_org, 'ייבוא',      'import');

  return v_org;
end;
$$;

-- ----------------------------------------------------------------------------
-- create_invitation: returns the raw token ONCE; only its hash is stored.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- accept_invitation: the signed-in user joins, if the invitation was sent to
-- their own (verified) email address.
-- ----------------------------------------------------------------------------
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
    where m.organization_id = v_inv.organization_id and m.user_id = v_uid
  ) then
    raise exception 'you are already a member of this organization' using errcode = '23505';
  end if;

  insert into public.memberships (organization_id, user_id, role, seat_type)
  values (v_inv.organization_id, v_uid, v_inv.role,
          case when v_inv.role = 'viewer' then 'view' else 'full' end::public.seat_type);

  update public.invitations set accepted_at = now() where id = v_inv.id;

  return v_inv.organization_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- transfer_ownership: the owner hands the organization to another member.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- convert_lead: lead -> contact (+ company) (+ deal), in one transaction.
-- ----------------------------------------------------------------------------
create or replace function public.convert_lead(
  p_lead_id       uuid,
  p_create_deal   boolean default true,
  p_deal_name     text default null,
  p_amount_agorot bigint default 0
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead public.leads%rowtype;
  v_owner uuid;
  v_company uuid;
  v_contact uuid;
  v_deal uuid;
  v_pipeline uuid;
  v_stage uuid;
  v_status uuid;
  v_name text;
  v_first text;
  v_last text;
begin
  select * into v_lead from public.leads l where l.id = p_lead_id for update;

  -- same answer for "does not exist" and "not yours": no information leaks
  if not found or v_lead.deleted_at is not null
     or not app.can_edit_record(v_lead.organization_id, v_lead.owner_id, v_lead.team_id) then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_lead.converted_at is not null then
    raise exception 'the lead is already converted' using errcode = 'P0001';
  end if;

  v_owner := coalesce(v_lead.owner_id, auth.uid());

  if coalesce(btrim(v_lead.company_name), '') <> '' then
    select c.id into v_company
    from public.companies c
    where c.organization_id = v_lead.organization_id
      and lower(c.name) = lower(btrim(v_lead.company_name))
      and c.deleted_at is null
    order by c.created_at
    limit 1;

    if v_company is null then
      insert into public.companies (organization_id, name, owner_id, team_id)
      values (v_lead.organization_id, btrim(v_lead.company_name), v_owner, v_lead.team_id)
      returning id into v_company;
    end if;
  end if;

  v_name := btrim(coalesce(v_lead.full_name, ''));
  if position(' ' in v_name) > 0 then
    v_first := split_part(v_name, ' ', 1);
    v_last := btrim(substr(v_name, position(' ' in v_name) + 1));
  else
    v_first := nullif(v_name, '');
  end if;

  insert into public.contacts (
    organization_id, first_name, last_name, email, phone, job_title,
    company_id, source_id, owner_id, team_id, tag_ids, last_contacted_at)
  values (
    v_lead.organization_id, v_first, v_last, v_lead.email, v_lead.phone, v_lead.job_title,
    v_company, v_lead.source_id, v_owner, v_lead.team_id, v_lead.tag_ids, v_lead.last_contacted_at)
  returning id into v_contact;

  if p_create_deal then
    select p.id into v_pipeline
    from public.pipelines p
    where p.organization_id = v_lead.organization_id and p.deleted_at is null
    order by p.is_default desc, p.position, p.created_at
    limit 1;

    select s.id into v_stage
    from public.stages s
    where s.pipeline_id = v_pipeline and s.kind = 'open'
    order by s.position
    limit 1;

    if v_stage is null then
      raise exception 'no open stage to put the deal in' using errcode = 'P0001';
    end if;

    insert into public.deals (
      organization_id, name, amount_agorot, pipeline_id, stage_id,
      contact_id, company_id, source_id, owner_id, team_id)
    values (
      v_lead.organization_id,
      coalesce(nullif(btrim(p_deal_name), ''), nullif(v_name, ''), nullif(btrim(v_lead.company_name), ''), 'עסקה חדשה'),
      greatest(coalesce(p_amount_agorot, 0), 0), v_pipeline, v_stage,
      v_contact, v_company, v_lead.source_id, v_owner, v_lead.team_id)
    returning id into v_deal;
  end if;

  select s.id into v_status
  from public.lead_statuses s
  where s.organization_id = v_lead.organization_id and s.kind = 'converted'
  order by s.position
  limit 1;

  update public.leads
     set converted_at = now(),
         converted_contact_id = v_contact,
         converted_company_id = v_company,
         converted_deal_id = v_deal,
         status_id = coalesce(v_status, status_id)
   where id = v_lead.id;

  -- the lead's history follows it to the contact and the deal
  update public.activities
     set contact_id = coalesce(contact_id, v_contact),
         deal_id = coalesce(deal_id, v_deal)
   where lead_id = v_lead.id;

  insert into public.activities (organization_id, type, lead_id, contact_id, deal_id, metadata, created_by)
  values (v_lead.organization_id, 'conversion', v_lead.id, v_contact, v_deal,
          jsonb_build_object('company_id', v_company), auth.uid());

  return jsonb_build_object('contact_id', v_contact, 'company_id', v_company, 'deal_id', v_deal);
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
revoke all on function public.create_organization(text, text, text, text) from public, anon;
revoke all on function public.create_invitation(uuid, text, public.membership_role) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
revoke all on function public.transfer_ownership(uuid, uuid) from public, anon;
revoke all on function public.convert_lead(uuid, boolean, text, bigint) from public, anon;

grant execute on function public.create_organization(text, text, text, text) to authenticated, service_role;
grant execute on function public.create_invitation(uuid, text, public.membership_role) to authenticated, service_role;
grant execute on function public.accept_invitation(text) to authenticated, service_role;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated, service_role;
grant execute on function public.convert_lead(uuid, boolean, text, bigint) to authenticated, service_role;
