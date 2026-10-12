-- =============================================================================
-- Conversion carries the lead's open tasks and its meetings (RVW-5)
-- =============================================================================
-- public.convert_lead() moved only the timeline to the new contact and deal.
-- An open task ("call him back tomorrow") stayed on the converted lead alone, so
-- right after a conversion the new deal looked stuck with no next step
-- (DEAL-02), the contact's card summary showed no next action (REC-10) and the
-- task cards of the contact and the deal were empty (FXU-01). Meetings stayed
-- behind the same way (BACKLOG follow-up of CAL-01).
--
-- Redefined with create or replace; everything else is exactly as in 0005
-- (checks, contact, company, deal, status, timeline, conversion entry, grants).
-- Added, after the timeline moves:
-- * open tasks of the lead (status 'open', not in the recycle bin) get
--   contact_id and deal_id, like the timeline: a link the task already has is
--   kept (coalesce), lead_id stays. Done and cancelled tasks stay where they
--   were: they are history of the lead, and the timeline already carries it.
-- * every meeting of the lead (any status) gets contact_id and deal_id the same
--   way; lead_id stays.
-- * These moves are housekeeping, not edits by a person: app.automation_running
--   is on while they run (as in transfer_records), so the task.updated events
--   they write start no automation; the previous value is put back afterwards.
--   The audit log records them as usual (audit_row). The meetings link check
--   (meetings_check_links) does not apply to server writes; the links come from
--   the conversion itself.
-- Every statement is safe to run twice.

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
  v_automation text;
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

  -- RVW-5: so do its open tasks and its meetings (housekeeping: no automation reacts)
  v_automation := current_setting('app.automation_running', true);
  perform set_config('app.automation_running', 'on', true);

  update public.tasks
     set contact_id = coalesce(contact_id, v_contact),
         deal_id = coalesce(deal_id, v_deal)
   where organization_id = v_lead.organization_id
     and lead_id = v_lead.id
     and status = 'open'
     and deleted_at is null;

  update public.meetings
     set contact_id = coalesce(contact_id, v_contact),
         deal_id = coalesce(deal_id, v_deal)
   where organization_id = v_lead.organization_id
     and lead_id = v_lead.id;

  perform set_config('app.automation_running', coalesce(v_automation, ''), true);

  insert into public.activities (organization_id, type, lead_id, contact_id, deal_id, metadata, created_by)
  values (v_lead.organization_id, 'conversion', v_lead.id, v_contact, v_deal,
          jsonb_build_object('company_id', v_company), auth.uid());

  return jsonb_build_object('contact_id', v_contact, 'company_id', v_company, 'deal_id', v_deal);
end;
$$;

revoke all on function public.convert_lead(uuid, boolean, text, bigint) from public, anon;
grant execute on function public.convert_lead(uuid, boolean, text, bigint) to authenticated, service_role;
