-- =============================================================================
-- New-lead push with buttons: call, WhatsApp and "I took it" (SPD-01)
-- =============================================================================
-- * leads.taken_at: when a person pressed "לקחתי" (I took it) on the lead.
--   Server only (no client grant; leads has per-column insert/update grants since
--   0038). There is no hand-over clock yet (SPD-03, wave 2); this is the mark it
--   will stop on. A new owner starts unmarked: trigger leads_reset_taken clears it
--   whenever owner_id changes without taken_at changing in the same update.
--
-- * public.take_lead(org, lead) (security definer, authenticated): "לקחתי".
--   - Only an active owner/admin/manager/member of a writable organization who may
--     read the lead (app.can_read_record), on a live lead (not in the bin);
--     otherwise 42501, the same for "no such lead" and "not yours to see".
--   - The lead has no owner: the caller becomes its owner, atomically. The update
--     carries "where owner_id is null", so of two people pressing at once the
--     second finds it taken. Answer {ok: true, result: 'taken'}.
--   - The caller owns it: marks taken_at once. {ok: true, result: 'acknowledged'}.
--   - Someone else owns it (or took it a moment ago): nothing changes.
--     {ok: false, reason: 'taken', owner_name}.
--   - A converted lead, or one whose status is not of kind 'open' (converted,
--     disqualified): {ok: false, reason: 'closed'}. Both updates re-check this,
--     so a lead closed while the call waited for its lock is not taken either.
--   On success the caller's unread notifications about the lead are marked read.
--
-- * public.claim_push_notifications(): the same body as 0010, plus two keys per
--   notification: 'type', and 'lead_actions' = the push may carry the three
--   buttons. That is a notification of kind 'lead_new', or an 'assigned' one about
--   a lead that came in through a form or webhook (an accepted form submission)
--   in the last hour and is still open: app.notify_assignment still sends new form
--   leads as 'assigned' (moving them to 'lead_new' is shared ground, left to the lead).
--   No lead data is added: the phone number never travels in the push.
--
-- * Index form_submissions (organization_id, lead_id) for that lookup.
--
-- Every statement is safe to run twice.

alter table public.leads add column if not exists taken_at timestamptz;

comment on column public.leads.taken_at is
  'SPD-01: when someone pressed "I took it" on the lead (server only; cleared when the owner changes).';

create index if not exists form_submissions_lead_idx
  on public.form_submissions (organization_id, lead_id) where lead_id is not null;

-- ----------------------------------------------------------------------------
-- A new owner starts unmarked
-- ----------------------------------------------------------------------------
create or replace function app.leads_reset_taken() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id and new.taken_at is not distinct from old.taken_at then
    new.taken_at := null;
  end if;
  return new;
end;
$$;
revoke all on function app.leads_reset_taken() from public, anon, authenticated;

create or replace trigger leads_reset_taken before update of owner_id on public.leads
  for each row execute function app.leads_reset_taken();

-- ----------------------------------------------------------------------------
-- "לקחתי"
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
-- The push batch says which notifications may carry the buttons
-- ----------------------------------------------------------------------------
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
