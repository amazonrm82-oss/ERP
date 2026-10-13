-- =============================================================================
-- Setup checklist and sample data (USR-04)
-- =============================================================================
-- 1. The setup checklist on the home page is derived from the business's own
--    data in the app (with the user's session). The only thing stored is that
--    an owner or admin closed it: organizations.setup_checklist_hidden_at,
--    written like setup_step (column grant + the organizations_update policy,
--    admins only), and audited as any change of the business details.
--
-- 2. Sample data. public.sample_data_add(org) (owners and admins of a writable
--    business) creates a small set of records, each with " (דוגמה)" in its name
--    and the tag "דוגמה", and notes every one of them in app.sample_records.
--    That table, not the tag or the name, is what says a record is sample data,
--    so a real record that someone tags "דוגמה" is never removed with them.
--    It has one nullable column per record type, each a composite foreign key
--    with ON DELETE CASCADE: when a sample record is deleted for good (by the
--    removal in the app, by the recycle bin or by a merge), its note goes with
--    it, with no DELETE statement here.
--    Every note keeps a snapshot of the row as it was created. A noted record
--    is removable only while it is untouched: the row still equals the
--    snapshot (moving it to the recycle bin does not count), and nothing that
--    is not sample data links to it (a note, a file, a meeting, a real task,
--    contact or deal, a conversion, a form inquiry). A merge of a real record
--    into a sample one changes the kept row, so that record is kept.
--    A linked sample record counts as sample only while its own row is
--    unchanged, so an edited sample task keeps its lead, and an edited sample
--    deal or contact keeps its contact and company.
--    public.sample_data_records(org) (owners and admins) lists the noted
--    records with `removable`. The removal itself is
--    public.sample_data_remove(org), in its own small migration file
--    (*_sample_data_remove.sql) because it deletes: the connector refuses it,
--    and the owner pastes it in the SQL Editor. It locks the noted rows,
--    re-checks them and deletes the untouched ones in one transaction, with
--    app.sample_removal = 'on' so the guard trigger defined here refuses to
--    delete any noted record that is no longer untouched.
--    Automations do not react to sample data (events are marked as automation,
--    like a handover), and nobody is notified (the records belong to the caller).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- 1. The checklist can be closed
-- ----------------------------------------------------------------------------
alter table public.organizations
  add column if not exists setup_checklist_hidden_at timestamptz;

comment on column public.organizations.setup_checklist_hidden_at is
  'USR-04: when an owner or admin closed the setup checklist on the home page; null = shown.';

grant update (setup_checklist_hidden_at) on public.organizations to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Which records are sample data (schema app: no API access, RLS on, no policies)
-- ----------------------------------------------------------------------------
create table if not exists app.sample_records (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  task_id         uuid,
  -- the row as created, without updated_at, updated_by and deleted_at
  snapshot        jsonb not null,
  created_at      timestamptz not null default now(),
  constraint sample_records_one_record check (num_nonnulls(lead_id, contact_id, company_id, deal_id, task_id) = 1),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete cascade,
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete cascade,
  foreign key (organization_id, task_id) references public.tasks (organization_id, id) on delete cascade
);

create index if not exists sample_records_by_org_idx on app.sample_records (organization_id);
-- the cascades look rows up by the record
create index if not exists sample_records_lead_idx on app.sample_records (organization_id, lead_id) where lead_id is not null;
create index if not exists sample_records_contact_idx on app.sample_records (organization_id, contact_id) where contact_id is not null;
create index if not exists sample_records_company_idx on app.sample_records (organization_id, company_id) where company_id is not null;
create index if not exists sample_records_deal_idx on app.sample_records (organization_id, deal_id) where deal_id is not null;
create index if not exists sample_records_task_idx on app.sample_records (organization_id, task_id) where task_id is not null;

alter table app.sample_records enable row level security;
revoke all on app.sample_records from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- A record as compared with its snapshot: the row without the columns that
-- change when it moves to the recycle bin. Null when the row is gone.
-- ----------------------------------------------------------------------------
create or replace function app.sample_row(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
-- timestamps in the snapshot must not depend on the caller's time zone
set timezone = 'UTC'
as $$
declare
  v_row jsonb;
begin
  if p_type not in ('lead', 'contact', 'company', 'deal', 'task') then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select to_jsonb(t) - array[''updated_at'', ''updated_by'', ''deleted_at''] from public.%I t where t.organization_id = $1 and t.id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                             when 'deal' then 'deals' else 'tasks' end)
    into v_row using p_org, p_id;
  return v_row;
end;
$$;
revoke all on function app.sample_row(uuid, text, uuid) from public, anon, authenticated;

-- the type of a note
create or replace function app.sample_note_type(s app.sample_records) returns text
language sql immutable
set search_path = ''
as $$
  select case
           when s.lead_id is not null then 'lead'
           when s.contact_id is not null then 'contact'
           when s.company_id is not null then 'company'
           when s.deal_id is not null then 'deal'
           else 'task'
         end
$$;
revoke all on function app.sample_note_type(app.sample_records) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- True when the record is noted as sample data and its own row still equals
-- the snapshot. Looks at the row only, not at what links to it, so the link
-- checks below can use it without recursion.
-- ----------------------------------------------------------------------------
create or replace function app.sample_pristine(p_org uuid, p_type text, p_id uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.sample_records s
     where s.organization_id = p_org
       and app.sample_note_type(s) = p_type
       and coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) = p_id
       and app.sample_row(p_org, p_type, p_id) is not distinct from s.snapshot)
$$;
revoke all on function app.sample_pristine(uuid, text, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- app.sample_untouched by id: false when the record is not noted as sample.
-- PL/pgSQL, so it may be created before app.sample_untouched below.
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched_id(p_org uuid, p_type text, p_id uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
begin
  select s.snapshot into v_snapshot
    from app.sample_records s
   where s.organization_id = p_org
     and app.sample_note_type(s) = p_type
     and coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) = p_id
   limit 1;
  if not found then
    return false;
  end if;
  return app.sample_untouched(p_org, p_type, p_id, v_snapshot);
end;
$$;
revoke all on function app.sample_untouched_id(uuid, text, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- True while a noted sample record is untouched: the row equals its snapshot,
-- and nothing links to it except sample records that are themselves untouched
-- (a kept sample task, deal or contact is real work: what it points at stays
-- too). Tasks are checked by their row only; the recursion is bounded:
-- company <- contact <- deal, company <- deal.
-- ----------------------------------------------------------------------------
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
                         and not app.sample_untouched_id(p_org, 'deal', d.id));
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

-- ----------------------------------------------------------------------------
-- Guard while sample data is being removed (app.sample_removal = 'on', set by
-- public.sample_data_remove only): a noted record that is no longer untouched
-- is never deleted, also not by a cascade such as app.purge_links(). Any other
-- delete (a person's purge, a merge) is not affected. Named to run before the
-- *_purge_links triggers.
-- ----------------------------------------------------------------------------
create or replace function app.guard_sample_removal() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_type text := tg_argv[0];
  v_snapshot jsonb;
begin
  if current_setting('app.sample_removal', true) is distinct from 'on' then
    return old;
  end if;
  select s.snapshot into v_snapshot
    from app.sample_records s
   where s.organization_id = old.organization_id
     and app.sample_note_type(s) = v_type
     and coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) = old.id;
  if found and not app.sample_untouched(old.organization_id, v_type, old.id, v_snapshot) then
    raise exception 'sample record was changed' using errcode = 'P0001', hint = 'sample:changed';
  end if;
  return old;
end;
$$;
revoke all on function app.guard_sample_removal() from public, anon, authenticated;

create or replace trigger leads_guard_sample_removal before delete on public.leads
  for each row execute function app.guard_sample_removal('lead');
create or replace trigger contacts_guard_sample_removal before delete on public.contacts
  for each row execute function app.guard_sample_removal('contact');
create or replace trigger companies_guard_sample_removal before delete on public.companies
  for each row execute function app.guard_sample_removal('company');
create or replace trigger deals_guard_sample_removal before delete on public.deals
  for each row execute function app.guard_sample_removal('deal');
create or replace trigger tasks_guard_sample_removal before delete on public.tasks
  for each row execute function app.guard_sample_removal('task');

-- ----------------------------------------------------------------------------
-- Adds the sample data: one company, two contacts, three leads, one deal and
-- two tasks, all owned by the caller. Refused while sample data is still there.
-- ----------------------------------------------------------------------------
create or replace function public.sample_data_add(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_tag      uuid;
  v_status   uuid;
  v_source   uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_currency text;
  v_company  uuid;
  v_contact1 uuid;
  v_contact2 uuid;
  v_lead1    uuid;
  v_lead2    uuid;
  v_lead3    uuid;
  v_deal     uuid;
  v_task1    uuid;
  v_task2    uuid;
  v_suffix   constant text := ' (דוגמה)';
  v_prev_automation text := current_setting('app.automation_running', true);
begin
  if v_uid is null or p_org is null or not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;
  -- one at a time per business, so a double click cannot add two sets
  perform 1 from public.organizations o where o.id = p_org for no key update;
  if exists (select 1 from app.sample_records s
              where s.organization_id = p_org
                and app.sample_untouched(p_org, app.sample_note_type(s), coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id), s.snapshot)) then
    raise exception 'sample data already exists' using errcode = 'P0001', hint = 'sample:exists';
  end if;

  select o.currency into v_currency from public.organizations o where o.id = p_org;

  -- the lists every business starts with; a business that removed them gets what is left
  select s.id into v_status from public.lead_statuses s
   where s.organization_id = p_org and s.kind = 'open'
   order by s.is_default desc, s.position, s.created_at limit 1;
  if v_status is null then
    raise exception 'no open lead status' using errcode = 'P0001', hint = 'sample:no_status';
  end if;
  select s.id into v_source from public.lead_sources s
   where s.organization_id = p_org and s.is_active
   order by (s.kind = 'manual') desc, s.created_at limit 1;
  select p.id into v_pipeline from public.pipelines p
   where p.organization_id = p_org and p.deleted_at is null
   order by p.is_default desc, p.position, p.created_at limit 1;
  if v_pipeline is not null then
    select st.id into v_stage from public.stages st
     where st.organization_id = p_org and st.pipeline_id = v_pipeline and st.kind = 'open'
     order by st.position, st.created_at limit 1;
  end if;

  insert into public.tags (organization_id, name, created_by)
  values (p_org, 'דוגמה', v_uid)
  on conflict (organization_id, lower(name)) do nothing;
  select t.id into v_tag from public.tags t where t.organization_id = p_org and lower(t.name) = lower('דוגמה');

  -- what this creates is not news for automations (like a handover of records)
  perform set_config('app.automation_running', 'on', true);

  insert into public.companies (organization_id, name, industry, email, city, owner_id, tag_ids)
  values (p_org, 'סטודיו כרמל' || v_suffix, 'עיצוב', 'office@example.com', 'חיפה', v_uid, array[v_tag])
  returning id into v_company;

  insert into public.contacts (organization_id, first_name, last_name, email, job_title, company_id, source_id, owner_id, tag_ids)
  values (p_org, 'נועה', 'כרמלי' || v_suffix, 'noa@example.com', 'מנהלת', v_company, v_source, v_uid, array[v_tag])
  returning id into v_contact1;
  insert into public.contacts (organization_id, first_name, last_name, email, city, source_id, owner_id, tag_ids)
  values (p_org, 'אבי', 'שגיא' || v_suffix, 'avi@example.com', 'תל אביב', v_source, v_uid, array[v_tag])
  returning id into v_contact2;

  insert into public.leads (organization_id, full_name, email, company_name, status_id, source_id, message, owner_id, tag_ids)
  values (p_org, 'דנה לוי' || v_suffix, 'dana@example.com', null, v_status, v_source,
          'ליד לדוגמה. אפשר למחוק את כל נתוני הדוגמה בלחיצה מרשימת ההקמה.', v_uid, array[v_tag])
  returning id into v_lead1;
  insert into public.leads (organization_id, full_name, email, company_name, status_id, source_id, message, owner_id, tag_ids)
  values (p_org, 'יוסי אברהם' || v_suffix, 'yossi@example.com', 'אברהם שיפוצים', v_status, v_source,
          'מבקש הצעת מחיר. ליד לדוגמה.', v_uid, array[v_tag])
  returning id into v_lead2;
  insert into public.leads (organization_id, full_name, email, status_id, source_id, owner_id, tag_ids)
  values (p_org, 'מיכל דהן' || v_suffix, 'michal@example.com', v_status, v_source, v_uid, array[v_tag])
  returning id into v_lead3;

  if v_stage is not null then
    insert into public.deals (organization_id, name, amount_agorot, currency, pipeline_id, stage_id,
                              contact_id, company_id, source_id, owner_id, tag_ids)
    values (p_org, 'עיצוב אתר לסטודיו כרמל' || v_suffix, 1250000, coalesce(v_currency, 'ILS'), v_pipeline, v_stage,
            v_contact1, v_company, v_source, v_uid, array[v_tag])
    returning id into v_deal;
  end if;

  insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id)
  values (p_org, 'להתקשר לדנה לוי' || v_suffix, 'call', now() + interval '2 hours', v_uid, v_lead1)
  returning id into v_task1;
  insert into public.tasks (organization_id, title, task_type, due_at, owner_id, deal_id, contact_id)
  values (p_org, 'לשלוח הצעת מחיר' || v_suffix, 'todo', now() + interval '1 day', v_uid, v_deal,
          case when v_deal is null then v_contact1 end)
  returning id into v_task2;

  perform set_config('app.automation_running', coalesce(v_prev_automation, ''), true);

  insert into app.sample_records (organization_id, company_id, snapshot) values (p_org, v_company, app.sample_row(p_org, 'company', v_company));
  insert into app.sample_records (organization_id, contact_id, snapshot) values
    (p_org, v_contact1, app.sample_row(p_org, 'contact', v_contact1)),
    (p_org, v_contact2, app.sample_row(p_org, 'contact', v_contact2));
  insert into app.sample_records (organization_id, lead_id, snapshot) values
    (p_org, v_lead1, app.sample_row(p_org, 'lead', v_lead1)),
    (p_org, v_lead2, app.sample_row(p_org, 'lead', v_lead2)),
    (p_org, v_lead3, app.sample_row(p_org, 'lead', v_lead3));
  if v_deal is not null then
    insert into app.sample_records (organization_id, deal_id, snapshot) values (p_org, v_deal, app.sample_row(p_org, 'deal', v_deal));
  end if;
  insert into app.sample_records (organization_id, task_id, snapshot) values
    (p_org, v_task1, app.sample_row(p_org, 'task', v_task1)),
    (p_org, v_task2, app.sample_row(p_org, 'task', v_task2));

  return jsonb_build_object('created', case when v_deal is null then 8 else 9 end);
end;
$$;
revoke all on function public.sample_data_add(uuid) from public, anon;
grant execute on function public.sample_data_add(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The records that are sample data (ids only), live or in the recycle bin,
-- each with `removable` = still untouched. Owners and admins: they are the
-- ones who add and remove them.
-- ----------------------------------------------------------------------------
create or replace function public.sample_data_records(p_org uuid)
returns table (record_type text, record_id uuid, removable boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_org is null or not app.is_admin(p_org) then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;
  return query
    select n.t, n.id, app.sample_untouched(p_org, n.t, n.id, n.snapshot)
      from (select app.sample_note_type(s) as t,
                   coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) as id,
                   s.snapshot, s.created_at, s.id as note_id
              from app.sample_records s
             where s.organization_id = p_org) n
     order by n.created_at, n.note_id;
end;
$$;
revoke all on function public.sample_data_records(uuid) from public, anon;
grant execute on function public.sample_data_records(uuid) to authenticated;
