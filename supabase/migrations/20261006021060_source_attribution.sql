-- =============================================================================
-- SEG-02 + DQL-04: first and last source of every lead and contact, the first
-- source locked, and revenue by first source and campaign
-- =============================================================================
-- Owner, 18 October 2026 (DECISIONS.md): (1) the last source is updated by every
-- automatic inquiry (public form, booking page, business card, QR code, site
-- widget), never by a manual entry; (2) revenue is reported by the FIRST source,
-- the last source is a list column and a filter; (3) the first source is locked
-- together with it (DQL-04).
--
-- First source. It is what the record already holds and every existing report,
-- filter, automation and score rule reads: leads.source_id + campaign + utm
-- (CAP-02 "first touch wins"). Contacts had only source_id; they now also get a
-- server-kept `campaign` and `utm` (filled on conversion and by an automatic
-- inquiry, never by a person).
--
-- Last source. New server-only columns on leads and contacts: last_source_id,
-- last_campaign, last_utm and last_source_at (when the latest automatic inquiry
-- arrived). Nothing a person sends can write them (no column grant):
-- * a lead made by an inquiry (intake_submit / booking_submit set app.intake
--   around the insert) starts with last = first (leads_last_source_new);
-- * a repeat inquiry is the server's `inquiry` timeline entry (form: metadata
--   form_id + attribution; booking page: booking_page_id); trigger
--   activities_inquiry_source sets the last source of the lead and contact it is
--   on. A record with no first source at all, or made by this very request (a
--   contact made while leads are off), also gets its empty first-source parts;
-- * a contact made by a booking while leads are off writes no entry: the booking's
--   personal link row (app.booking_manage_links) marks it (booking_links_source).
-- Neither intake_submit nor booking_submit is redefined. Known gap (L3): booking_submit does not put the visit's
-- UTM on a repeat booking's entry, so that last source has the page's source and title but no UTM.
--
-- Conversion (leads_convert_source): the contact gets the lead's first source parts
-- that it lacks when it has no source or the same one, and the lead's last source
-- when it is newer than the contact's own.
--
-- Lock (DQL-04; owner 26 October 2026, lead's decision on the whole): once any part of the
-- first source of a lead or contact is set (source, campaign, a UTM value), a person changes,
-- clears or fills any part only as an owner or admin (hints lead:/contact:first_source_locked).
-- Server paths pass and are audited (L6): the FK set-null of a removed source, the intake, and
-- conversion, which may fill EMPTY parts of a locked contact's first source (never replace a set
-- one). A merge pick of a locked source or campaign is judged by app.merge_pick_check (redefined
-- below from 020560): owners and admins only, the same hints. A merge does not carry the last-source
-- columns: the kept record keeps its own (follow-up: take the newer one). An automation's set_field source_id on a lead or contact fills the source
-- only while the first source is empty, else the step is ok with the warning 'the first source
-- is already set' (owner, answer 3; app.run_automation_actions redefined below from 021035).
-- Every change is in the audit log as before (app.audit_row: old and new values).
--
-- Report: public.report_revenue_by_source (invoker), the won-deal rule of
-- report_revenue (keep in step). A deal is attributed to the first source of the lead it was
-- converted from; when that is empty, to its contact's; when that is empty too, to the deal's own.
-- It is security invoker: a lead or contact the caller cannot read is skipped silently and the deal
-- falls to the next level (a caller who sees the deal but not its lead may see it under the contact's
-- or the deal's own source).
-- Report key `source_revenue` in public.log_export (redefined below).
--
-- No destructive statements and no escaped code points; every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
alter table public.leads add column if not exists last_source_id uuid;
alter table public.leads add column if not exists last_campaign  text;
alter table public.leads add column if not exists last_utm       jsonb;
alter table public.leads add column if not exists last_source_at timestamptz;

alter table public.contacts add column if not exists campaign       text;
alter table public.contacts add column if not exists utm            jsonb;
alter table public.contacts add column if not exists last_source_id uuid;
alter table public.contacts add column if not exists last_campaign  text;
alter table public.contacts add column if not exists last_utm       jsonb;
alter table public.contacts add column if not exists last_source_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_last_source_fk') then
    alter table public.leads add constraint leads_last_source_fk
      foreign key (organization_id, last_source_id) references public.lead_sources (organization_id, id)
      on delete set null (last_source_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_last_source_fk') then
    alter table public.contacts add constraint contacts_last_source_fk
      foreign key (organization_id, last_source_id) references public.lead_sources (organization_id, id)
      on delete set null (last_source_id);
  end if;
end;
$$;

create index if not exists leads_last_source_idx on public.leads (organization_id, last_source_id);
create index if not exists contacts_last_source_idx on public.contacts (organization_id, last_source_id);

alter table public.leads drop constraint if exists leads_last_source_shape;
alter table public.leads add constraint leads_last_source_shape check (
  coalesce(char_length(last_campaign), 0) <= 200
  and (last_utm is null or jsonb_typeof(last_utm) = 'object')
);
alter table public.contacts drop constraint if exists contacts_source_shape;
alter table public.contacts add constraint contacts_source_shape check (
  coalesce(char_length(campaign), 0) <= 200
  and coalesce(char_length(last_campaign), 0) <= 200
  and (utm is null or jsonb_typeof(utm) = 'object')
  and (last_utm is null or jsonb_typeof(last_utm) = 'object')
);

-- leads and contacts have column-level insert/update grants: the new columns get none (server only);
-- select is table-wide, so members read them with the record.

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
-- The utm of an inquiry, in the shape a new lead stores (the five values and `extra`); null when empty.
create or replace function app.attribution_utm(p_attr jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select nullif(jsonb_strip_nulls(jsonb_build_object(
    'utm_source', p_attr -> 'utm_source', 'utm_medium', p_attr -> 'utm_medium',
    'utm_campaign', p_attr -> 'utm_campaign', 'utm_term', p_attr -> 'utm_term',
    'utm_content', p_attr -> 'utm_content', 'extra', p_attr -> 'extra')), '{}'::jsonb)
  where jsonb_typeof(p_attr) = 'object'
$$;
revoke all on function app.attribution_utm(jsonb) from public, anon, authenticated, service_role;

-- The source a booking page brings: its own, else the business's booking source if there is one (the rule
-- booking_submit uses, without making the source).
create or replace function app.booking_page_source(p_org uuid, p_page uuid) returns table (source_id uuid, campaign text)
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p.source_id, (
           select s.id from public.lead_sources s
            where s.organization_id = p_org and (s.kind = 'booking' or btrim(s.name) = 'דף קביעת תור')
            order by s.is_active desc, (s.kind = 'booking') desc, s.created_at
            limit 1)),
         left(nullif(btrim(p.title), ''), 200)
    from public.booking_pages p
   where p.organization_id = p_org and p.id = p_page
$$;
revoke all on function app.booking_page_source(uuid, uuid) from public, anon, authenticated, service_role;

-- One automatic inquiry on a lead or a contact: the last source always; the empty parts of the first source too
-- when the record has no first source at all or was made by this very request (created in this transaction).
create or replace function app.attribution_touch(p_kind text, p_org uuid, p_id uuid, p_source uuid, p_campaign text, p_utm jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_campaign text := left(nullif(btrim(p_campaign), ''), 200);
  v_utm jsonb := nullif(p_utm, '{}'::jsonb);
begin
  if p_id is null then
    return;
  end if;
  if p_kind = 'lead' then
    update public.leads l set
      last_source_id = p_source, last_campaign = v_campaign, last_utm = v_utm, last_source_at = now(),
      source_id = case when l.source_id is null and (app.first_source_empty(l.source_id, l.campaign, l.utm) or l.created_at = now())
                       then p_source else l.source_id end,
      campaign = case when nullif(btrim(l.campaign), '') is null and (app.first_source_empty(l.source_id, l.campaign, l.utm) or l.created_at = now())
                      then v_campaign else l.campaign end,
      utm = case when (l.utm - 'extra') = '{}'::jsonb and v_utm is not null
                      and (app.first_source_empty(l.source_id, l.campaign, l.utm) or l.created_at = now())
                 then v_utm || l.utm else l.utm end
     where l.organization_id = p_org and l.id = p_id;
  elsif p_kind = 'contact' then
    update public.contacts c set
      last_source_id = p_source, last_campaign = v_campaign, last_utm = v_utm, last_source_at = now(),
      source_id = case when c.source_id is null and (app.first_source_empty(c.source_id, c.campaign, c.utm) or c.created_at = now())
                       then p_source else c.source_id end,
      campaign = case when nullif(btrim(c.campaign), '') is null and (app.first_source_empty(c.source_id, c.campaign, c.utm) or c.created_at = now())
                      then v_campaign else c.campaign end,
      utm = case when (coalesce(c.utm, '{}'::jsonb) - 'extra') = '{}'::jsonb and v_utm is not null
                      and (app.first_source_empty(c.source_id, c.campaign, c.utm) or c.created_at = now())
                 then v_utm || coalesce(c.utm, '{}'::jsonb) else c.utm end
     where c.organization_id = p_org and c.id = p_id;
  end if;
end;
$$;

-- No first source at all: no source, no campaign, no UTM value (utm.extra alone does not count).
create or replace function app.first_source_empty(p_source uuid, p_campaign text, p_utm jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_source is null and nullif(btrim(p_campaign), '') is null
     and (case when jsonb_typeof(p_utm) = 'object' then p_utm - 'extra' else '{}'::jsonb end) = '{}'::jsonb
$$;
revoke all on function app.first_source_empty(uuid, text, jsonb) from public, anon;
-- pure; the invoker lock trigger runs it as the person
grant execute on function app.first_source_empty(uuid, text, jsonb) to authenticated, service_role;
revoke all on function app.attribution_touch(text, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A lead made by an inquiry starts with last = first
-- ----------------------------------------------------------------------------
-- invoker: tells the server's insert (intake_submit / booking_submit set app.intake) from a person's
create or replace function app.leads_last_source_new() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' and coalesce(current_setting('app.intake', true), '') = 'on' then
    new.last_source_id := new.source_id;
    new.last_campaign := left(nullif(btrim(new.campaign), ''), 200);
    new.last_utm := nullif(new.utm, '{}'::jsonb);
    new.last_source_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.leads_last_source_new() from public, anon;
grant execute on function app.leads_last_source_new() to authenticated, service_role;

create or replace trigger leads_last_source_new before insert on public.leads
  for each row execute function app.leads_last_source_new();

-- ----------------------------------------------------------------------------
-- A repeat inquiry (the server's `inquiry` entry) moves the last source
-- ----------------------------------------------------------------------------
create or replace function app.activities_inquiry_source() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form uuid := app.safe_uuid(new.metadata ->> 'form_id');
  v_page uuid := app.safe_uuid(new.metadata ->> 'booking_page_id');
  v_attr jsonb := case when jsonb_typeof(new.metadata -> 'attribution') = 'object' then new.metadata -> 'attribution' else '{}'::jsonb end;
  v_source uuid;
  v_campaign text;
  v_utm jsonb;
begin
  if v_form is not null then
    select f.source_id into v_source from public.forms f where f.organization_id = new.organization_id and f.id = v_form;
    v_campaign := v_attr ->> 'utm_campaign';
    v_utm := app.attribution_utm(v_attr);
  elsif v_page is not null then
    -- a booking: the page's source and its title as the campaign (the rule of a new booking lead without UTM)
    select b.source_id, b.campaign into v_source, v_campaign from app.booking_page_source(new.organization_id, v_page) b;
  else
    return null;
  end if;
  perform app.attribution_touch('lead', new.organization_id, new.lead_id, v_source, v_campaign, v_utm);
  perform app.attribution_touch('contact', new.organization_id, new.contact_id, v_source, v_campaign, v_utm);
  return null;
end;
$$;
revoke all on function app.activities_inquiry_source() from public, anon, authenticated, service_role;

-- only the server writes inquiries (a person's insert is limited to the six logged types); the WHEN clause sees
-- the writer, so a person's write never reaches the definer function
create or replace trigger activities_inquiry_source after insert on public.activities
  for each row when (new.type = 'inquiry' and current_user <> 'authenticated')
  execute function app.activities_inquiry_source();

-- ----------------------------------------------------------------------------
-- A record made by a booking without a timeline entry (a contact while leads are off)
-- ----------------------------------------------------------------------------
create or replace function app.booking_links_source() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead uuid;
  v_contact uuid;
  v_source uuid;
  v_campaign text;
begin
  select m.lead_id, m.contact_id into v_lead, v_contact
    from public.meetings m where m.organization_id = new.organization_id and m.id = new.meeting_id;
  select b.source_id, b.campaign into v_source, v_campaign from app.booking_page_source(new.organization_id, new.page_id) b;
  -- only a record this request made and nothing has marked yet (a new lead is marked on insert; a change of a
  -- booking makes no record)
  if v_lead is not null and exists (select 1 from public.leads l where l.organization_id = new.organization_id and l.id = v_lead
                                       and l.created_at = now() and l.last_source_at is null) then
    perform app.attribution_touch('lead', new.organization_id, v_lead, v_source, v_campaign, null);
  end if;
  if v_contact is not null and exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = v_contact
                                          and c.created_at = now() and c.last_source_at is null) then
    perform app.attribution_touch('contact', new.organization_id, v_contact, v_source, v_campaign, null);
  end if;
  return null;
end;
$$;
revoke all on function app.booking_links_source() from public, anon, authenticated, service_role;

create or replace trigger booking_links_source after insert on app.booking_manage_links
  for each row execute function app.booking_links_source();

-- ----------------------------------------------------------------------------
-- Conversion: the contact gets the lead's first and last source
-- ----------------------------------------------------------------------------
create or replace function app.convert_source() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_first boolean;
  v_last boolean;
begin
  if new.converted_contact_id is null then
    return null;
  end if;
  select * into v_contact from public.contacts c
   where c.organization_id = new.organization_id and c.id = new.converted_contact_id
   for update;
  if not found then
    return null;
  end if;
  -- the lead completes the contact's first source only when they agree on it (or the contact has none)
  v_first := v_contact.source_id is null or v_contact.source_id = new.source_id;
  v_last := new.last_source_at is not null and (v_contact.last_source_at is null or new.last_source_at > v_contact.last_source_at);
  if not v_first and not v_last then
    return null;
  end if;
  update public.contacts c set
    source_id = case when v_first and c.source_id is null then new.source_id else c.source_id end,
    campaign = case when v_first and nullif(btrim(c.campaign), '') is null then left(nullif(btrim(new.campaign), ''), 200) else c.campaign end,
    utm = case when v_first and (coalesce(c.utm, '{}'::jsonb) - 'extra') = '{}'::jsonb and new.utm <> '{}'::jsonb
               then new.utm || coalesce(c.utm, '{}'::jsonb) else c.utm end,
    last_source_id = case when v_last then new.last_source_id else c.last_source_id end,
    last_campaign = case when v_last then new.last_campaign else c.last_campaign end,
    last_utm = case when v_last then new.last_utm else c.last_utm end,
    last_source_at = case when v_last then new.last_source_at else c.last_source_at end
   where c.organization_id = new.organization_id and c.id = new.converted_contact_id;
  return null;
end;
$$;
revoke all on function app.convert_source() from public, anon, authenticated, service_role;

create or replace trigger leads_convert_source after update of converted_at on public.leads
  for each row when (old.converted_at is null and new.converted_at is not null)
  execute function app.convert_source();

-- ----------------------------------------------------------------------------
-- DQL-04: the first source of a lead or contact is locked once set
-- ----------------------------------------------------------------------------
-- invoker (current_user tells a person's write); after leads_utm_merge by name, so a {"$merge": ...} is judged
-- as merged. Lead's decision: the first source is locked AS A WHOLE once any part is set (source, campaign or a UTM
-- value): from then on a person changes, clears or fills a part only as owner or admin. Before anything is set, whoever
-- may edit the record fills it. Leads and contacts have the same column names, so one function serves both.
create or replace function app.first_source_lock() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
  v_changed boolean := false;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if app.first_source_empty(old.source_id, old.campaign, old.utm) then
    return new;
  end if;
  if new.source_id is distinct from old.source_id
     or nullif(btrim(new.campaign), '') is distinct from nullif(btrim(old.campaign), '') then
    v_changed := true;
  else
    foreach v_key in array array['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] loop
      if nullif(new.utm ->> v_key, '') is distinct from nullif(old.utm ->> v_key, '') then
        v_changed := true;
        exit;
      end if;
    end loop;
  end if;
  if v_changed and not app.is_admin(new.organization_id) then
    if tg_table_name = 'contacts' then
      raise exception 'the first source of a contact is locked' using errcode = 'P0001', hint = 'contact:first_source_locked';
    end if;
    raise exception 'the first source of a lead is locked' using errcode = 'P0001', hint = 'lead:first_source_locked';
  end if;
  return new;
end;
$$;
revoke all on function app.first_source_lock() from public, anon;
grant execute on function app.first_source_lock() to authenticated, service_role;

create or replace trigger leads_zz_first_source_lock before update of source_id, campaign, utm on public.leads
  for each row execute function app.first_source_lock();
create or replace trigger contacts_zz_first_source_lock before update of source_id, campaign, utm on public.contacts
  for each row execute function app.first_source_lock();

-- ----------------------------------------------------------------------------
-- Revenue by first source and campaign
-- ----------------------------------------------------------------------------
-- security invoker: RLS decides what is counted. The won-deal rule of report_revenue (keep in step).
create or replace function public.report_revenue_by_source(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with won as (
    select d.id, d.amount_agorot, d.contact_id, d.source_id
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  ), attributed as (
    select w.amount_agorot,
           case when l.has_source then 'lead' when ct.has_source then 'contact' else 'deal' end as via,
           case when l.has_source then l.source_id when ct.has_source then ct.source_id else w.source_id end as source_id,
           case when l.has_source then nullif(btrim(l.campaign), '')
                when ct.has_source then nullif(btrim(ct.campaign), '') end as campaign
      from won w
      left join lateral (
        select x.id, x.source_id, x.campaign, (x.source_id is not null or nullif(btrim(x.campaign), '') is not null) as has_source
          from public.leads x
         where x.organization_id = p_org and x.converted_deal_id = w.id
         order by x.converted_at, x.id
         limit 1) l on true
      left join lateral (
        select y.source_id, y.campaign, (y.source_id is not null or nullif(btrim(y.campaign), '') is not null) as has_source
          from public.contacts y
         where y.organization_id = p_org and y.id = w.contact_id) ct on true
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'deals', (select count(*) from attributed),
      'amount', (select coalesce(sum(amount_agorot), 0) from attributed),
      'from_lead', (select count(*) from attributed where via = 'lead'),
      'from_contact', (select count(*) from attributed where via = 'contact'),
      'from_deal', (select count(*) from attributed where via = 'deal'),
      'without_source', (select count(*) from attributed where source_id is null)),
    'by_source', coalesce((
      select jsonb_agg(r order by r.amount desc, r.source_name nulls last) from (
        select a.source_id, s.name as source_name, count(*) as deals, sum(a.amount_agorot) as amount
          from attributed a
          left join public.lead_sources s on s.organization_id = p_org and s.id = a.source_id
         group by a.source_id, s.name) r), '[]'::jsonb),
    'by_campaign', coalesce((
      select jsonb_agg(r order by r.amount desc, r.source_name nulls last, r.campaign nulls last) from (
        select a.source_id, s.name as source_name, a.campaign, count(*) as deals, sum(a.amount_agorot) as amount
          from attributed a
          left join public.lead_sources s on s.organization_id = p_org and s.id = a.source_id
         group by a.source_id, s.name, a.campaign) r), '[]'::jsonb));
$$;
revoke all on function public.report_revenue_by_source(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.report_revenue_by_source(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- log_export: the report keys of src/features/reports/definitions.ts, with source_revenue
-- ----------------------------------------------------------------------------
create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if not app.can_export(p_org) then
      raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
    -- DLI-06: gross profit carries costs
    if p_report = 'profit' and not app.can_view_costs(p_org) then
      raise exception 'the gross profit report is for those who may see costs' using errcode = '42501';
    end if;
    -- QUO-17: the quotes report belongs to the quotes capability
    if p_report = 'quotes' and not app.org_has_feature(p_org, 'quotes') then
      raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;

-- ----------------------------------------------------------------------------
-- app.run_automation_actions: the body of 20261006021035_automation_quote_record_owner_first.sql with one change: a
-- set_field of source_id on a lead or contact fills only an empty first source (warning 'the first source is already set')
-- ----------------------------------------------------------------------------
create or replace function app.run_automation_actions(p_auto public.automations, p_entity text, p_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := p_auto.organization_id;
  v_table text := app.automation_table(p_entity);
  v_record jsonb;
  v_action jsonb;
  v_type text;
  v_steps jsonb := '[]'::jsonb;
  v_name text;
  v_title text;
  v_user uuid;
  v_id uuid;
  v_due timestamptz;
  v_task_type text;
  v_count integer;
  v_kind public.lead_status_kind;
  v_reason text;
  v_warning text;
  v_warning_name text;
  v_kept uuid;
  v_zone text;
  v_local timestamp;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
  -- CAP-08 review: the team the route chose (a rule's team or the step's) and the owner before the step
  v_route_team uuid;
  v_prev_owner uuid;
  v_set_owner uuid;
  -- AUT-01: the field a set_field step writes
  v_field text;
  v_key text;
  v_value jsonb;
  v_def uuid;
  v_field_type text;
  v_options jsonb;
  v_read_only boolean;
  v_unique boolean;
  -- AUT-01 part B: a relative date
  v_relative boolean;
  v_date date;
  -- AUT-02: a create_deal step
  v_pipeline uuid;
  v_stage uuid;
  v_amount bigint;
  v_contact uuid;
  v_company uuid;
  v_hint text;
  v_note_lead uuid;
  v_note_deal uuid;
  -- DEAL-08 follow-up: a create_deal step that follows its source deal
  v_source public.deals;
  v_line public.deal_lines;
  v_skipped integer;
  v_claims text;
  v_claim_sub text;
  -- AUT-02 (rest): a create_quote step
  v_template public.quote_templates;
  v_tline public.quote_template_lines;
  v_day date;
  v_mode boolean;
  v_rate integer;
  v_list uuid;
  v_contact_list uuid;
  v_contact_co uuid;
  v_price bigint;
  v_p_price bigint;
  v_p_incl boolean;
  v_p_kind text;
  v_tier_price bigint;
  v_tier_bp integer;
  v_tier_incl boolean;
  v_source_kind text;
  v_list_used uuid;
  v_pos integer;
  -- AUT-02 follow-up: every warning of a create_quote step (the first is also 'warning')
  v_warnings text[];
begin
  for v_action in select * from jsonb_array_elements(p_auto.actions) loop
    v_type := v_action ->> 'type';
    v_record := app.automation_record(p_entity, v_org, p_id);
    v_name := app.automation_display_name(v_record);
    v_warning_name := null;
    begin
      if v_record is null then
        raise exception 'the record no longer exists';
      end if;

      if v_type = 'create_task' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'משימה'), '{{name}}', v_name), 300);
        v_due := null;
        v_warning := null;
        -- HEB-03: due in N business days (0..60), at the current local time of day
        if v_action ? 'due_in_business_days' then
          if jsonb_typeof(v_action -> 'due_in_business_days') = 'number'
             and (v_action ->> 'due_in_business_days')::numeric between 0 and 60
             and (v_action ->> 'due_in_business_days')::numeric = trunc((v_action ->> 'due_in_business_days')::numeric) then
            select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
            v_zone := coalesce(v_zone, 'Asia/Jerusalem');
            v_local := now() at time zone v_zone;
            v_due := (app.add_business_days(v_org, v_local::date, (v_action ->> 'due_in_business_days')::numeric::int) + v_local::time)
                     at time zone v_zone;
          else
            v_warning := 'the business-day offset is invalid';
          end if;
        end if;
        if v_due is null and (v_action ? 'due_in_minutes' or v_action ? 'due_in_days') then
          v_due := now()
            + make_interval(mins => coalesce((v_action ->> 'due_in_minutes')::int, 0))
            + make_interval(days => coalesce((v_action ->> 'due_in_days')::int, 0));
        end if;
        v_user := case when v_action ->> 'assign' = 'user'
                       then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                       else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
        v_task_type := case when v_action ->> 'task_type' in ('todo', 'call', 'meeting', 'follow_up')
                            then v_action ->> 'task_type' else 'todo' end;
        insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id, contact_id, company_id, deal_id)
        values (
          v_org, v_title, v_task_type, v_due, v_user,
          case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end,
          case when p_entity = 'contact' then p_id when p_entity in ('task', 'deal') then (v_record ->> 'contact_id')::uuid end,
          case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end,
          case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end);

      elsif v_type = 'notify' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'עדכון מאוטומציה'), '{{name}}', v_name), 200);
        if v_action ->> 'to' = 'admins' then
          insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
          select v_org, m.user_id, 'automation', v_title, p_entity, p_id
            from public.memberships m
           where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'admin');
          get diagnostics v_count = row_count;
        else
          v_user := case when v_action ->> 'to' = 'user'
                         then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                         else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
          v_count := 0;
          if v_user is not null then
            insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
            values (v_org, v_user, 'automation', v_title, p_entity, p_id);
            v_count := 1;
          end if;
        end if;
        if v_count = 0 then
          raise exception 'nobody to notify';
        end if;

      elsif v_type = 'assign_owner' then
        v_warning := null;
        if v_action ->> 'mode' = 'round_robin' then
          if (v_action ->> 'team_id') is not null and not exists (
            select 1 from public.teams t where t.organization_id = v_org and t.id = (v_action ->> 'team_id')::uuid) then
            raise exception 'the team no longer exists';
          end if;
          v_rule_user := null;
          if p_entity = 'lead' then
            -- CAP-08: the rules (source, requested product, language, list field; a team or one
            -- person), then the pick
            select p.owner_id, p.rule_user, p.team_id into v_user, v_rule_user, v_route_team
              from app.lead_distribution_route(v_org, (v_action ->> 'team_id')::uuid, now(),
                                               app.lead_routing_context(v_org, p_id), '{}'::uuid[]) p;
          else
            v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          end if;
          if v_rule_user is not null then
            -- a rule's person: the HEB-08 rule of a fixed person, as the "assign to a person" step
            -- the lead's team: the rule's person's by app.default_team()'s rule, else as it is
            v_id := app.member_default_team(v_org, v_rule_user);
            v_prev_owner := (v_record ->> 'owner_id')::uuid;
            v_set_owner := app.assign_lead_owner_auto(v_org, p_id, v_rule_user, coalesce(v_id, (v_record ->> 'team_id')::uuid));
            if v_set_owner is null then
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            -- set after the owner change (which applies default_team to the new owner, a deputy too),
            -- so the team is the person's whoever took the lead; only when the owner changed to the
            -- person or their deputy, or the lead had no owner before (review: a lead that stays with
            -- the owner it has keeps its team too)
            if v_id is not null
               and (v_prev_owner is null or (v_set_owner is not null and v_set_owner is distinct from v_prev_owner)) then
              update public.leads set team_id = v_id
               where organization_id = v_org and id = p_id and team_id is distinct from v_id;
            end if;
            v_user := null;
          elsif v_user is null then
            raise exception 'nobody is available';
          elsif p_entity = 'lead' then
            -- CAP-08 review: as intake does, the lead takes the team the route chose (a rule's team,
            -- else the step's), in the same statement as the owner, so default_team leaves it; no team
            -- chosen (the step names the whole business): the owner's default team, as before
            update public.leads
               set owner_id = v_user, team_id = coalesce(v_route_team, team_id)
             where organization_id = v_org and id = p_id;
            v_user := null;
          end if;
        else
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
          -- HEB-08: a lead goes through the one rule for automatic assignment of a fixed
          -- person (present: them; away: their deputy; away with none: no owner, and back to
          -- them on their return)
          if p_entity = 'lead' then
            v_warning := null;
            if app.assign_lead_owner_auto(v_org, p_id, v_user, (v_record ->> 'team_id')::uuid) is null then
              -- the lead keeps the owner it has (owner, 14 October 2026): say who it stays with
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            -- assigned (or left unowned) above
            v_user := null;
          end if;
        end if;
        if v_user is not null then
          execute format('update public.%I set owner_id = $1 where organization_id = $2 and id = $3', v_table)
            using v_user, v_org, p_id;
        end if;

      elsif v_type = 'add_tag' then
        if p_entity = 'task' then
          raise exception 'tasks have no tags';
        end if;
        select t.id into v_id from public.tags t where t.organization_id = v_org and t.id = (v_action ->> 'tag_id')::uuid;
        if v_id is null then
          raise exception 'the tag no longer exists';
        end if;
        execute format(
          'update public.%I set tag_ids = case when $1 = any (tag_ids) then tag_ids else array_append(tag_ids, $1) end
            where organization_id = $2 and id = $3', v_table)
          using v_id, v_org, p_id;

      elsif v_type = 'set_lead_status' then
        if p_entity <> 'lead' then
          raise exception 'only for leads';
        end if;
        select s.id, s.kind into v_id, v_kind from public.lead_statuses s
         where s.organization_id = v_org and s.id = (v_action ->> 'status_id')::uuid and s.kind <> 'converted';
        if v_id is null then
          raise exception 'the status no longer exists';
        end if;
        v_warning := null;
        if v_kind = 'disqualified' then
          -- the reason is kept by id and read by name now, so a renamed reason still works;
          -- only an active reason of this organization counts (a hidden, deleted or foreign id does not)
          v_reason := null;
          -- absent, null, empty or blank: no reason was set (an old rule); anything else is looked up
          if nullif(btrim(v_action ->> 'reason_id'), '') is null then
            v_warning := 'no reason is set';
          else
            select r.name into v_reason from public.disqualify_reasons r
             where r.organization_id = v_org and r.is_active
               and r.id::text = (v_action ->> 'reason_id');
            if v_reason is null then
              v_warning := 'the reason no longer exists';
            end if;
          end if;
          -- status and reason in one update: leads_disqualify_reason keeps a reason a server write sets
          -- together with the move, and clears the old one when none is given
          if v_reason is not null then
            update public.leads set status_id = v_id, disqualify_reason = v_reason where organization_id = v_org and id = p_id;
          else
            update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
          end if;
        else
          update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
        end if;

      elsif v_type = 'move_deal_stage' then
        if p_entity <> 'deal' then
          raise exception 'only for deals';
        end if;
        select s.id into v_id from public.stages s
         where s.organization_id = v_org and s.id = (v_action ->> 'stage_id')::uuid
           and s.pipeline_id = (v_record ->> 'pipeline_id')::uuid;
        if v_id is null then
          raise exception 'the stage is not in this deal''s pipeline';
        end if;
        update public.deals set stage_id = v_id where organization_id = v_org and id = p_id;

      elsif v_type = 'set_field' then
        -- AUT-01: one field of the record: a custom field ("cf:<key>", any type, checked as a person's
        -- write is) or a built-in field (source_id on leads, contacts and deals; task_type on tasks; part B, owner
        -- 18 October 2026: preferred_channel and preferred_locale on leads and contacts, expected_close_date on deals;
        -- never a name or a phone: an automation does not rewrite identity).
        -- An absent or null value clears the field (task_type cannot be empty).
        -- Part B: a date field (expected_close_date, a date or datetime custom field) may take a relative date
        -- {"relative": {"days": 0..365, "unit": "calendar" | "business"}}, worked out when the step runs (an AUT-06 retry
        -- works it out again at its own time) from today in the business's zone (business days by app.add_business_days;
        -- 0 = today, or the next working day). An invalid one leaves the field as it is: the step is ok with a warning.
        v_warning := null;
        v_field := v_action ->> 'field';
        v_value := case when jsonb_typeof(v_action -> 'value') is distinct from 'null' then v_action -> 'value' end;
        v_relative := jsonb_typeof(v_value) = 'object' and v_value ? 'relative';
        if v_field like 'cf:%' then
          if p_entity not in ('lead', 'contact', 'company', 'deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_key := substr(v_field, 4);
          v_def := null;
          select f.id, f.field_type, f.options, f.is_read_only, f.is_unique
            into v_def, v_field_type, v_options, v_read_only, v_unique
            from public.field_definitions f
           where f.organization_id = v_org and f.object_type = p_entity and f.key = v_key and f.is_active;
          if v_def is null then
            raise exception 'the field no longer exists';
          end if;
          -- part B: a relative date becomes the field's own value (a datetime keeps the current local time, to the minute)
          if v_relative then
            if v_field_type not in ('date', 'datetime') then
              raise exception 'the value does not fit the field';
            end if;
            v_date := app.automation_relative_date(v_org, v_value -> 'relative');
            if v_date is null then
              v_warning := 'the relative date is invalid';
            elsif v_field_type = 'date' then
              v_value := to_jsonb(to_char(v_date, 'YYYY-MM-DD'));
            else
              select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
              v_zone := coalesce(v_zone, 'Asia/Jerusalem');
              v_local := date_trunc('minute', now() at time zone v_zone);
              v_value := to_jsonb(to_char(((v_date + v_local::time) at time zone v_zone) at time zone 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
            end if;
          end if;
          if v_warning is null then
          if not app.custom_value_ok(v_field_type, v_options, v_value) then
            raise exception 'the value does not fit the field';
          end if;
          -- a "user" field holds a member of the record's organization (as app.check_custom_fields)
          if v_field_type = 'user' and v_value is not null and not exists (
            select 1 from public.memberships m
             where m.organization_id = v_org and m.user_id = (v_value #>> '{}')::uuid) then
            raise exception 'the value does not fit the field';
          end if;
          -- FLD-07: a filled read-only value stays (an empty one may be filled once)
          if v_read_only and not app.custom_value_empty(v_record -> 'custom_fields' -> v_key)
             and (v_record -> 'custom_fields' -> v_key) is distinct from v_value then
            raise exception 'the field is read-only';
          end if;
          -- FLD-07: a unique field is judged now, inside this step, as intake_submit does, so a taken
          -- value fails the step instead of the whole run at commit
          begin
            if v_unique then
              set constraints app.custom_unique_values_value immediate;
            end if;
            execute format(
              'update public.%I
                  set custom_fields = case when $1 is null then coalesce(custom_fields, ''{}''::jsonb) - $2
                                           else coalesce(custom_fields, ''{}''::jsonb) || jsonb_build_object($2, $1) end
                where organization_id = $3 and id = $4', v_table)
              using v_value, v_key, v_org, p_id;
            if v_unique then
              set constraints app.custom_unique_values_value deferred;
            end if;
          exception when unique_violation then
            -- (the rollback of this block restores the mode too; said again for clarity)
            set constraints app.custom_unique_values_value deferred;
            raise exception 'the value is already on another record';
          end;
          end if;
        elsif v_field = 'source_id' then
          if p_entity not in ('lead', 'contact', 'deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_id := null;
          if v_value is not null then
            select s.id into v_id from public.lead_sources s
             where s.organization_id = v_org and s.id::text = (v_value #>> '{}') and s.is_active;
            if v_id is null then
              raise exception 'the source no longer exists';
            end if;
          end if;
          -- SEG-02 / DQL-04 (owner, 26 October 2026, answer 3): on a lead or a contact an automation only fills an empty
          -- first source (source, campaign and UTM all empty); otherwise the step is ok with a warning and nothing changes
          if (p_entity = 'lead' and exists (
                select 1 from public.leads l
                 where l.organization_id = v_org and l.id = p_id and not app.first_source_empty(l.source_id, l.campaign, l.utm)))
             or (p_entity = 'contact' and exists (
                select 1 from public.contacts c
                 where c.organization_id = v_org and c.id = p_id and not app.first_source_empty(c.source_id, c.campaign, c.utm))) then
            v_warning := 'the first source is already set';
          else
            execute format('update public.%I set source_id = $1 where organization_id = $2 and id = $3', v_table)
              using v_id, v_org, p_id;
          end if;
        elsif v_field = 'task_type' then
          if p_entity not in ('task') then
            raise exception 'the field does not fit this record';
          end if;
          if v_value is null or (v_value #>> '{}') not in ('todo', 'call', 'meeting', 'follow_up') then
            raise exception 'the value does not fit the field';
          end if;
          update public.tasks set task_type = (v_value #>> '{}') where organization_id = v_org and id = p_id;
        elsif v_field = 'preferred_channel' then
          if p_entity not in ('lead', 'contact') then
            raise exception 'the field does not fit this record';
          end if;
          -- the CON-10 list (contacts_preferred_channel_check, leads_preferred_channel_check; CONTACT_CHANNELS)
          if v_value is not null and (jsonb_typeof(v_value) <> 'string'
             or (v_value #>> '{}') <> all (array['phone', 'whatsapp', 'email', 'sms'])) then
            raise exception 'the value does not fit the field';
          end if;
          -- the source (owner, 26 October 2026): a record that has one keeps it (option ג: form stays form, manual stays
          -- manual); a new channel on a record with no source makes it 'form' (answer ב), so a later public form may replace
          -- it; writing the channel the record already has changes nothing; clearing clears it (app.preferred_channel_source
          -- leaves a server write's source as given, empties it with the channel). The right-hand side reads the old row.
          execute format(
            'update public.%I set preferred_channel = $1,'
            ' preferred_channel_source = case when $1 is not null and preferred_channel_source is null'
            ' and preferred_channel is distinct from $1 then ''form'' else preferred_channel_source end'
            ' where organization_id = $2 and id = $3', v_table)
            using v_value #>> '{}', v_org, p_id;
        elsif v_field = 'preferred_locale' then
          if p_entity not in ('lead', 'contact') then
            raise exception 'the field does not fit this record';
          end if;
          -- the CON-10 list (contacts_preferred_locale_check, leads_preferred_locale_check; CONTACT_LOCALES)
          if v_value is not null and (jsonb_typeof(v_value) <> 'string'
             or (v_value #>> '{}') <> all (array['he', 'ar', 'en', 'ru', 'am', 'fr', 'es'])) then
            raise exception 'the value does not fit the field';
          end if;
          execute format('update public.%I set preferred_locale = $1 where organization_id = $2 and id = $3', v_table)
            using v_value #>> '{}', v_org, p_id;
        elsif v_field = 'expected_close_date' then
          if p_entity not in ('deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_date := null;
          if v_relative then
            v_date := app.automation_relative_date(v_org, v_value -> 'relative');
            if v_date is null then
              v_warning := 'the relative date is invalid';
            end if;
          elsif v_value is not null then
            if jsonb_typeof(v_value) <> 'string' or not app.custom_value_ok('date', '[]'::jsonb, v_value) then
              raise exception 'the value does not fit the field';
            end if;
            v_date := (v_value #>> '{}')::date;
          end if;
          if v_warning is null then
            update public.deals set expected_close_date = v_date where organization_id = v_org and id = p_id;
          end if;
        else
          raise exception 'the field does not fit this record';
        end if;

      elsif v_type = 'create_deal' then
        -- AUT-02: a new deal for the record's customer. A contact gives itself and its company, a company itself, a
        -- deal or a task its contact and company (a link to a record in the recycle bin is left out). A lead becomes
        -- a deal by conversion, not here. A deal made from a deal names it as the previous deal (DEAL-11).
        v_warning := null;
        if p_entity not in ('contact', 'company', 'deal', 'task') then
          raise exception 'a lead becomes a deal by conversion';
        end if;
        v_pipeline := null;
        v_stage := null;
        v_source := null;
        if p_entity = 'deal' then
          select d.* into v_source from public.deals d where d.organization_id = v_org and d.id = p_id;
        end if;
        -- DEAL-08 follow-up: "pipeline": "source" = the triggering deal's sales process, in its first open stage; when the
        -- trigger is not a deal, or that process is gone or has no open stage, the step's own pipeline_id rule below
        if v_action ->> 'pipeline' = 'source' and v_source.id is not null then
          select s.pipeline_id, s.id into v_pipeline, v_stage
            from public.stages s
            join public.pipelines p on p.organization_id = s.organization_id and p.id = s.pipeline_id
           where s.organization_id = v_org and s.pipeline_id = v_source.pipeline_id and s.kind = 'open' and p.deleted_at is null
           order by s.position, s.created_at, s.id
           limit 1;
        end if;
        if v_pipeline is null then
        select p.id into v_pipeline from public.pipelines p
         where p.organization_id = v_org and p.id::text = (v_action ->> 'pipeline_id') and p.deleted_at is null;
        if v_pipeline is null then
          raise exception 'the pipeline no longer exists';
        end if;
        v_stage := null;
        if nullif(btrim(v_action ->> 'stage_id'), '') is not null then
          select s.id into v_stage from public.stages s
           where s.organization_id = v_org and s.pipeline_id = v_pipeline and s.id::text = (v_action ->> 'stage_id')
             and s.kind = 'open';
          if v_stage is null then
            raise exception 'the stage is not an open stage of the pipeline';
          end if;
        else
          -- no stage chosen: the pipeline's first open stage
          select s.id into v_stage from public.stages s
           where s.organization_id = v_org and s.pipeline_id = v_pipeline and s.kind = 'open'
           order by s.position, s.created_at, s.id
           limit 1;
          if v_stage is null then
            raise exception 'the pipeline has no open stage';
          end if;
        end if;
        end if;
        -- the value in agorot: a whole number from 0 to 100,000,000,000 (a billion shekels); absent or null = empty
        v_amount := 0;
        if jsonb_typeof(v_action -> 'amount_agorot') is not null and jsonb_typeof(v_action -> 'amount_agorot') <> 'null' then
          if jsonb_typeof(v_action -> 'amount_agorot') <> 'number'
             or (v_action ->> 'amount_agorot')::numeric < 0
             or (v_action ->> 'amount_agorot')::numeric > 100000000000
             or (v_action ->> 'amount_agorot')::numeric <> trunc((v_action ->> 'amount_agorot')::numeric) then
            raise exception 'the amount is invalid';
          end if;
          v_amount := (v_action ->> 'amount_agorot')::numeric::bigint;
        end if;
        v_title := left(btrim(replace(coalesce(nullif(btrim(v_action ->> 'name'), ''), 'עסקה: {{name}}'), '{{name}}', v_name)), 200);
        if v_title = '' then
          v_title := 'עסקה';
        end if;
        if v_action ->> 'assign' = 'user' then
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
        else
          v_user := app.automation_member(v_org, (v_record ->> 'owner_id')::uuid);
        end if;
        v_contact := case when p_entity = 'contact' then p_id
                          when p_entity in ('deal', 'task') then (v_record ->> 'contact_id')::uuid end;
        v_company := case when p_entity = 'company' then p_id else (v_record ->> 'company_id')::uuid end;
        if v_contact is not null and not exists (
          select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null) then
          v_contact := null;
        end if;
        if v_company is not null and not exists (
          select 1 from public.companies c where c.organization_id = v_org and c.id = v_company and c.deleted_at is null) then
          v_company := null;
        end if;
        -- DEAL-08 follow-up: "copy_from_source": true (deal triggers only) copies the source deal's recurring revenue. A
        -- recurring amount that followed the source's lines is left empty, so the copied lines fill it again (DLI-03);
        -- a typed one is copied as typed. The value follows the lines unless the step names an amount.
        if not (coalesce(v_action -> 'copy_from_source', 'false'::jsonb) = 'true'::jsonb and v_source.id is not null) then
          v_source := null;
        end if;
        begin
          insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot, owner_id, contact_id, company_id,
                                    previous_deal_id, billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date)
          values (v_org, v_title, v_pipeline, v_stage, v_amount, v_user, v_contact, v_company,
                  case when p_entity = 'deal' then p_id end,
                  v_source.billing_kind,
                  case when v_source.billing_kind is not null and v_source.recurring_amount_auto is not true then v_source.recurring_amount_agorot end,
                  -- the next period: it starts on the source's renewal date and renews after the same term; never
                  -- the source's own renewal date, or a date rule on it would renew the copy again
                  case when v_source.billing_kind is not null then coalesce(v_source.renewal_date, v_source.recurring_start_date) end,
                  -- the term in whole months: the source's term rounded to the nearest month (15 days or more count as a
                  -- month), at least one, so a month end stays a month end (Postgres clamps the day)
                  case when v_source.billing_kind is not null and v_source.renewal_date > v_source.recurring_start_date
                       then (v_source.renewal_date + make_interval(months => greatest(1, (
                              extract(year from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp)) * 12
                              + extract(month from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp))
                              + case when extract(day from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp)) >= 15
                                     then 1 else 0 end)::integer)))::date end)
          returning id into v_id;
        exception when sqlstate 'P0001' then
          get stacked diagnostics v_hint = pg_exception_hint;
          if v_hint = 'limit:max_records' then
            raise exception 'the plan record limit is reached';
          end if;
          raise;
        end;
        -- the source deal's lines, as they are (the deal_lines triggers judge each one; the run already marks its writes
        -- as an automation's, so nothing re-fires). A line the rules no longer let in (a product a person may not offer
        -- any more, a plan without products or discounts) is left out and the step says so; a line whose price list was
        -- removed keeps its price as a manual one.
        if v_source.id is not null then
          v_skipped := 0;
          -- the lines are copied as the server, the same whether the rule runs on its own or a person runs it now:
          -- with the person's session, deal_lines_check would skip every rule for a deal that person may not edit.
          -- The session is put back after the loop and on any error that leaves it.
          v_claims := current_setting('request.jwt.claims', true);
          v_claim_sub := current_setting('request.jwt.claim.sub', true);
          if v_claims is not null then
            perform set_config('request.jwt.claims', '', true);
          end if;
          if v_claim_sub is not null then
            perform set_config('request.jwt.claim.sub', '', true);
          end if;
          begin
          for v_line in
            select l.* from public.deal_lines l
             where l.organization_id = v_org and l.deal_id = v_source.id
             order by l.position, l.created_at, l.id
          loop
            begin
              insert into public.deal_lines (organization_id, deal_id, position, product_id, description, quantity, unit_price_agorot,
                                             discount_bp, discount_agorot, price_includes_vat, vat_exempt, price_source, price_list_id,
                                             billing, currency)
              values (v_org, v_id, v_line.position, v_line.product_id, v_line.description, v_line.quantity, v_line.unit_price_agorot,
                      v_line.discount_bp, v_line.discount_agorot, v_line.price_includes_vat, v_line.vat_exempt,
                      case when v_line.price_source = 'price_list' and v_line.price_list_id is null then 'manual' else v_line.price_source end,
                      v_line.price_list_id, v_line.billing, v_line.currency);
            exception when raise_exception or integrity_constraint_violation or insufficient_privilege then
              v_skipped := v_skipped + 1;
            end;
          end loop;
          exception when others then
            if v_claims is not null then
              perform set_config('request.jwt.claims', v_claims, true);
            end if;
            if v_claim_sub is not null then
              perform set_config('request.jwt.claim.sub', v_claim_sub, true);
            end if;
            raise;
          end;
          if v_claims is not null then
            perform set_config('request.jwt.claims', v_claims, true);
          end if;
          if v_claim_sub is not null then
            perform set_config('request.jwt.claim.sub', v_claim_sub, true);
          end if;
          if v_skipped > 0 then
            v_warning := 'some lines were not copied';
          end if;
        end if;

      elsif v_type = 'create_note' then
        -- AUT-02: a note on the record's timeline (a task's note goes on the records the task is linked to). It is
        -- an 'automation_note', not a person's 'note': it is not contact with the customer (last contact, response
        -- time, activation, lead score) and does not count as activity for a "no activity" rule.
        v_title := left(btrim(replace(coalesce(v_action ->> 'body', ''), '{{name}}', v_name)), 2000);
        if v_title = '' then
          raise exception 'the note is empty';
        end if;
        -- the records the note goes on: the record itself, or a task's links that are not in the recycle bin
        v_note_lead := case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end;
        v_contact := case when p_entity = 'contact' then p_id when p_entity = 'task' then (v_record ->> 'contact_id')::uuid end;
        v_company := case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end;
        v_note_deal := case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end;
        if p_entity = 'task' then
          if v_note_lead is not null and not exists (
            select 1 from public.leads l where l.organization_id = v_org and l.id = v_note_lead and l.deleted_at is null) then
            v_note_lead := null;
          end if;
          if v_contact is not null and not exists (
            select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null) then
            v_contact := null;
          end if;
          if v_company is not null and not exists (
            select 1 from public.companies c where c.organization_id = v_org and c.id = v_company and c.deleted_at is null) then
            v_company := null;
          end if;
          if v_note_deal is not null and not exists (
            select 1 from public.deals d where d.organization_id = v_org and d.id = v_note_deal and d.deleted_at is null) then
            v_note_deal := null;
          end if;
          if num_nonnulls(v_note_lead, v_contact, v_company, v_note_deal) = 0 then
            raise exception 'the task is not linked to a record';
          end if;
        end if;
        -- written by the automation, not by a person: no author (the trigger activities_zz_automation_note clears it
        -- after touch_row, which would set the person who ran the rule by hand)
        insert into public.activities (organization_id, type, body, metadata, lead_id, contact_id, company_id, deal_id, created_by)
        values (
          v_org, 'automation_note', v_title,
          jsonb_build_object('automation_id', p_auto.id, 'automation_name', left(p_auto.name, 80)),
          v_note_lead, v_contact, v_company, v_note_deal, null);

      elsif v_type = 'create_quote' then
        -- AUT-02 (rest): a draft quote from a quote template (QUO-04), on the deal or the contact the rule runs on. The
        -- template is read by its id within the rule's business only. The quote is a draft: never sent, no number.
        -- It is written as the server (the session is put aside, as for a create_deal step's copied lines), so a person
        -- who runs the rule by hand gets the same quote as the rule on its own; the VAT mode is the template's (else the
        -- business's). The owner (owner's answer of 26 October 2026, (ב)): the record's owner while an active member who
        -- is not a viewer; else the step's optional owner_id while usable (a fallback); else no owner and the warning
        -- 'the record owner is not usable, the quote has no owner'.
        v_warning := null;
        v_warnings := '{}'::text[];
        if p_entity not in ('deal', 'contact') then
          raise exception 'a quote is made on a deal or a contact';
        end if;
        if (v_record ->> 'deleted_at') is not null then
          raise exception 'the record is in the recycle bin';
        end if;
        if not app.org_has_feature(v_org, 'quotes') then
          raise exception 'quotes are not in the plan';
        end if;
        select t.* into v_template from public.quote_templates t
         where t.organization_id = v_org and t.id::text = (v_action ->> 'template_id');
        if not found then
          raise exception 'the quote template no longer exists';
        end if;
        -- the record's owner first (they know the customer)
        v_user := app.automation_member(v_org, (v_record ->> 'owner_id')::uuid);
        -- the step's chosen owner only when the record's owner is not usable
        if v_user is null and (v_action ->> 'owner_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_user := app.automation_member(v_org, (v_action ->> 'owner_id')::uuid);
        end if;
        -- neither is usable (a chosen owner who is not usable is noted only then, by this same warning)
        if v_user is null then
          v_warnings := v_warnings || 'the record owner is not usable, the quote has no owner'::text;
        end if;
        -- the quote's date as quotes_check sets it (the business's today), valid for 30 days (DEFAULT_VALID_DAYS)
        select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_day
          from public.organizations o where o.id = v_org;
        -- a template with item lines brings its VAT mode (its typed prices are written in it), as applyTemplateToQuote
        v_mode := case when exists (select 1 from public.quote_template_lines tl
                                     where tl.organization_id = v_org and tl.template_id = v_template.id and tl.kind = 'item')
                       then v_template.prices_include_vat
                       else coalesce((select s.prices_include_vat from public.org_document_settings s where s.organization_id = v_org), false) end;
        v_title := btrim(v_name);
        v_title := case when v_title = '' then 'הצעת מחיר' else rtrim(left('הצעת מחיר: ' || v_title, 200)) end;
        v_skipped := 0;
        v_claims := current_setting('request.jwt.claims', true);
        v_claim_sub := current_setting('request.jwt.claim.sub', true);
        if v_claims is not null then
          perform set_config('request.jwt.claims', '', true);
        end if;
        if v_claim_sub is not null then
          perform set_config('request.jwt.claim.sub', '', true);
        end if;
        begin
          -- quotes_check fills a deal's contact and company, or a contact's company
          insert into public.quotes (organization_id, title, deal_id, contact_id, owner_id, valid_until, prices_include_vat, notes, terms)
          values (v_org, v_title,
                  case when p_entity = 'deal' then p_id end,
                  case when p_entity = 'contact' then p_id end,
                  v_user, v_day + 30, v_mode, v_template.notes, v_template.terms)
          returning id, contact_id, company_id into v_id, v_contact, v_company;

          -- PL-03, as the app prices a product line saved without a price (src/features/quotes/template-server.ts): the
          -- customer's price list (plan flag price_lists): the first that is active and valid today of the quote contact's
          -- own list, that contact's company's, the quote's company's; within it the product's tier with the largest
          -- min_quantity not above the line's quantity; then into the quote's VAT mode at the conversion rate
          -- (app.product_line_price, app.price_list_discounted: the SQL mirrors of RVW-27)
          v_list := null;
          if app.org_has_feature(v_org, 'price_lists') then
            v_contact_list := null;
            v_contact_co := null;
            if v_contact is not null then
              select c.price_list_id, c.company_id into v_contact_list, v_contact_co
                from public.contacts c where c.organization_id = v_org and c.id = v_contact;
            end if;
            select l.id into v_list
              from (values (1, v_contact_list),
                           (2, (select co.price_list_id from public.companies co where co.organization_id = v_org and co.id = v_contact_co)),
                           (3, (select co.price_list_id from public.companies co where co.organization_id = v_org and co.id = v_company)))
                   as o(n, list_id)
              join public.price_lists l on l.organization_id = v_org and l.id = o.list_id
             where l.is_active
               and (l.valid_from is null or l.valid_from <= v_day)
               and (l.valid_to is null or l.valid_to >= v_day)
             order by o.n
             limit 1;
          end if;
          v_rate := 0;
          if app.org_charges_vat(v_org) is distinct from false then
            v_rate := coalesce(app.vat_rate_at(v_day), 0);
          end if;

          v_pos := 0;
          for v_tline in
            select tl.* from public.quote_template_lines tl
             where tl.organization_id = v_org and tl.template_id = v_template.id
             order by tl.position, tl.created_at, tl.id
          loop
            v_price := v_tline.unit_price_agorot;
            v_source_kind := 'manual';
            v_list_used := null;
            if v_tline.kind = 'item' and v_tline.product_id is not null then
              -- only a product that may still be offered (quote_lines_check judges this for a person only)
              select p.price_agorot, p.vat_kind = 'taxable' and p.price_includes_vat, p.vat_kind
                into v_p_price, v_p_incl, v_p_kind
                from public.products p
               where p.organization_id = v_org and p.id = v_tline.product_id and p.is_active and p.archived_at is null;
              if not found then
                v_skipped := v_skipped + 1;
                continue;
              end if;
              if v_price is null then
                v_source_kind := 'product';
                v_tier_price := null;
                v_tier_bp := null;
                v_tier_incl := null;
                if v_list is not null then
                  select t.price_agorot, t.discount_bp, t.price_includes_vat into v_tier_price, v_tier_bp, v_tier_incl
                    from public.price_list_lines t
                   where t.organization_id = v_org and t.price_list_id = v_list and t.product_id = v_tline.product_id
                     and t.min_quantity <= v_tline.quantity
                   order by t.min_quantity desc, t.id
                   limit 1;
                  if v_tier_price is not null then
                    v_p_price := v_tier_price;
                    v_p_incl := v_p_kind = 'taxable' and v_tier_incl;
                    v_source_kind := 'price_list';
                    v_list_used := v_list;
                  elsif v_tier_bp is not null then
                    v_p_price := app.price_list_discounted(v_p_price, v_tier_bp);
                    v_source_kind := 'price_list';
                    v_list_used := v_list;
                  end if;
                end if;
                v_price := app.product_line_price(v_p_price, v_p_incl, v_p_kind, v_mode, v_rate);
              end if;
            elsif v_tline.kind = 'group' then
              v_price := 0;
            end if;
            v_pos := v_pos + 1;
            begin
              insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                              unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                              optional_selected, price_source, price_list_id)
              values (v_org, v_id, v_pos, v_tline.kind, v_tline.product_id, v_tline.name, v_tline.description, v_tline.quantity,
                      v_price, v_tline.discount_bp, v_tline.discount_agorot, v_tline.vat_exempt, v_tline.billing, v_tline.is_optional,
                      v_tline.optional_selected, v_source_kind, v_list_used);
            exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
              -- the rules refuse this line today (a plan flag: products, discounts; a constraint): leave it out and count it,
              -- like quote_duplicate. Anything else fails the step, and the quote with it.
              v_skipped := v_skipped + 1;
              v_pos := v_pos - 1;
            end;
          end loop;
        exception when others then
          if v_claims is not null then
            perform set_config('request.jwt.claims', v_claims, true);
          end if;
          if v_claim_sub is not null then
            perform set_config('request.jwt.claim.sub', v_claim_sub, true);
          end if;
          raise;
        end;
        if v_claims is not null then
          perform set_config('request.jwt.claims', v_claims, true);
        end if;
        if v_claim_sub is not null then
          perform set_config('request.jwt.claim.sub', v_claim_sub, true);
        end if;
        if v_skipped > 0 then
          v_warnings := v_warnings || 'some template lines were skipped'::text;
        end if;
        -- COL-05 (owner's answer of 26 October 2026): a customer on hold still gets the quote, with a warning. The rule of
        -- the app's warning at quote creation (CustomerHoldWarning): only with the plan's 'collection' flag; the quote's
        -- contact and its company (quotes_check filled them: the deal's contact and company, else the contact's company);
        -- an active hold (not cleared) on either. The contact's own hold first.
        if app.org_has_feature(v_org, 'collection') then
          if v_contact is not null and exists (
            select 1 from public.customer_holds h
             where h.organization_id = v_org and h.contact_id = v_contact and h.cleared_at is null) then
            v_warnings := v_warnings || 'the customer is on hold'::text;
          end if;
          if v_company is not null and exists (
            select 1 from public.customer_holds h
             where h.organization_id = v_org and h.company_id = v_company and h.cleared_at is null) then
            v_warnings := v_warnings || 'the customer''s company is on hold'::text;
          end if;
        end if;
        v_warning := v_warnings[1];

      else
        raise exception 'unknown action %', coalesce(v_type, '(none)');
      end if;

      v_steps := v_steps || jsonb_build_array(
        jsonb_build_object('action', v_type, 'status', 'ok')
        || case when v_type in ('set_lead_status', 'create_task', 'assign_owner', 'create_deal', 'set_field', 'create_quote') and v_warning is not null
                then jsonb_build_object('warning', v_warning) else '{}'::jsonb end
        || case when v_type = 'create_quote' and v_skipped > 0
                then jsonb_build_object('warning_count', v_skipped) else '{}'::jsonb end
        || case when v_type = 'create_quote' and v_warning is not null
                then jsonb_build_object('warnings', to_jsonb(v_warnings)) else '{}'::jsonb end
        || case when v_type = 'assign_owner' and v_warning is not null and v_warning_name is not null
                then jsonb_build_object('warning_name', v_warning_name) else '{}'::jsonb end);
    exception when others then
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('action', v_type, 'status', 'error', 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return v_steps;
end;
$$;
revoke all on function app.run_automation_actions(public.automations, text, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- app.merge_pick_check: the body of 20261006020560_merge_more_picks.sql with one change (review of SEG-02): a merge pick of
-- a locked first source (source_id of a lead or contact, campaign of a lead) is for owners and admins only
-- ----------------------------------------------------------------------------
create or replace function app.merge_pick_check(p_org uuid, p_type text, p_keep jsonb, p_merge jsonb, p_cols text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_value   uuid;
  v_tax     text;
  v_country text;
begin
  if 'preferred_channel_source' = any (p_cols) and not 'preferred_channel' = any (p_cols) then
    raise exception 'field preferred_channel_source is merged only with preferred_channel' using errcode = '22023';
  end if;

  -- SEG-02 / DQL-04 (owner, 26 October 2026, answer 1 (א)): a merge pick never changes a locked first source for anyone
  -- but owners and admins. The kept record's first source is locked once any part of it is set (app.first_source_empty);
  -- picking the duplicate's source (leads and contacts) or campaign (leads) then needs app.is_admin. A pick of the same
  -- value changes nothing and passes.
  if p_type in ('lead', 'contact')
     and not app.first_source_empty((p_keep ->> 'source_id')::uuid, p_keep ->> 'campaign', p_keep -> 'utm')
     and not app.is_admin(p_org)
     and (('source_id' = any (p_cols) and (p_merge ->> 'source_id') is distinct from (p_keep ->> 'source_id'))
          or ('campaign' = any (p_cols)
              and nullif(btrim(p_merge ->> 'campaign'), '') is distinct from nullif(btrim(p_keep ->> 'campaign'), ''))) then
    if p_type = 'contact' then
      raise exception 'the first source of a contact is locked' using errcode = 'P0001', hint = 'contact:first_source_locked';
    end if;
    raise exception 'the first source of a lead is locked' using errcode = 'P0001', hint = 'lead:first_source_locked';
  end if;

  if p_type = 'company' and ('tax_id' = any (p_cols) or 'country' = any (p_cols)) then
    v_tax := case when 'tax_id' = any (p_cols) then p_merge ->> 'tax_id' else p_keep ->> 'tax_id' end;
    v_country := case when 'country' = any (p_cols) then p_merge ->> 'country' else p_keep ->> 'country' end;
    if v_tax is not null
       and (v_tax is distinct from p_keep ->> 'tax_id' or v_country is distinct from p_keep ->> 'country') then
      if v_country is distinct from 'IL' then
        if btrim(v_tax, E' \t\r\n') !~ '^[A-Za-z0-9 ./-]{2,30}$' then
          raise exception 'invalid company number' using errcode = 'P0001', hint = 'tax_id:invalid_foreign';
        end if;
      elsif not app.valid_israeli_id(v_tax) then
        raise exception 'invalid company number' using errcode = 'P0001', hint = 'tax_id:invalid';
      end if;
    end if;
  end if;

  if p_type in ('contact', 'company') and 'type_id' = any (p_cols) then
    v_value := (p_merge ->> 'type_id')::uuid;
    if v_value is not null and v_value is distinct from (p_keep ->> 'type_id')::uuid
       and not exists (select 1 from public.record_type_options r
                        where r.organization_id = p_org and r.id = v_value and r.object_type = p_type and r.is_active) then
      raise exception 'pick a type from the list' using errcode = 'P0001', hint = 'record_type:invalid';
    end if;
  end if;

  if p_type = 'lead' and 'requested_product_id' = any (p_cols) then
    v_value := (p_merge ->> 'requested_product_id')::uuid;
    if v_value is not null and v_value is distinct from (p_keep ->> 'requested_product_id')::uuid then
      if not exists (select 1 from public.products p
                      where p.organization_id = p_org and p.id = v_value and p.is_active and p.archived_at is null) then
        raise exception 'the requested product is not available' using errcode = 'P0001', hint = 'lead:requested_product';
      end if;
      if not app.org_has_feature(p_org, 'products') then
        raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
      end if;
    end if;
  end if;
end;
$$;
revoke all on function app.merge_pick_check(uuid, text, jsonb, jsonb, text[]) from public, anon, authenticated, service_role;
