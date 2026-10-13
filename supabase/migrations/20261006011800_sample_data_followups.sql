-- =============================================================================
-- Sample data follow-ups (USR-04, after CON-01 and GAP-06)
-- =============================================================================
-- Two gaps found after USR-04 was written, closed by redefining two functions
-- from their latest versions, with only the lines below changed:
--
-- 1. app.sample_untouched() (from 0105, setup_checklist): a sample contact with
--    any row in public.contact_channels (CON-01, 0108: a further phone or email
--    that a person added) is real work, so it is no longer untouched and
--    sample_data_remove() keeps it (the channels would otherwise go with it by
--    cascade). Sample data itself never adds channels (sample_data_add() writes
--    contacts.email only). Through the existing recursion a company or deal that
--    such a contact links to is kept too.
--    record_followers (REC-03) is deliberately not checked: following a sample
--    record is not data about a customer; the follow goes with the record.
--
-- 2. app.mark_org_activation() (from 0116, activation_metric): a lead noted in
--    app.sample_records is not a real lead, so an answer to it does not activate
--    the organization. The one-time fill of 0116 is not repeated; rows it or the
--    trigger already wrote stay as they are.
--
-- Only `create or replace function`; safe to run twice. Grants and triggers are
-- unchanged (create or replace keeps them; the revokes are repeated anyway).

create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    return true;
  end if;
  -- notes, files and meetings are never sample data
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and not app.sample_pristine($1, ''task'', t.id))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id));
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id);
  end if;
end;
$$;
revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

create or replace function app.mark_org_activation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead_created timestamptz;
  v_at timestamptz;
begin
  if new.lead_id is null
     or new.created_by is null
     or new.is_private is true
     or not (new.type = any (app.contact_types()))
     or new.occurred_at > now() + interval '5 minutes' then
    return null;
  end if;
  if exists (select 1 from app.org_activation a where a.organization_id = new.organization_id) then
    return null;
  end if;

  -- created_at can be sent by the client on insert: never later than now
  select least(l.created_at, now()) into v_lead_created
    from public.leads l
   where l.organization_id = new.organization_id
     and l.id = new.lead_id
     and l.import_job_id is null
     and l.deleted_at is null
     -- USR-04: a sample lead is not a real lead
     and not exists (select 1 from app.sample_records s
                      where s.organization_id = new.organization_id and s.lead_id = new.lead_id);
  if v_lead_created is null then
    return null;
  end if;

  v_at := greatest(least(new.occurred_at, now()), v_lead_created);
  if v_at > v_lead_created + interval '24 hours' then
    return null;
  end if;

  insert into app.org_activation (organization_id, activated_at, lead_created_at)
  values (new.organization_id, v_at, v_lead_created)
  on conflict (organization_id) do nothing;
  return null;
end;
$$;
revoke all on function app.mark_org_activation() from public, anon, authenticated;
