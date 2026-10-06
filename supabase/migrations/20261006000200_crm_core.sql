-- =============================================================================
-- 0002 CRM core: pipelines, leads, contacts, companies, deals, activities, tasks
-- =============================================================================
-- Conventions for every business table:
--   * organization_id not null, and a unique (organization_id, id) so that
--     other tables reference it with a composite foreign key. A row can then
--     never point at a row of another organization, even through a bug.
--   * owner_id references a member OF THE SAME organization.
--   * deleted_at = recycle bin (soft delete); purged after 30 days by a job.
--   * custom_fields jsonb holds the tenant's custom fields (see field_definitions).
--   * money is stored in agorot (integer) with a currency code.

-- ----------------------------------------------------------------------------
-- Pipelines and stages
-- ----------------------------------------------------------------------------
create type public.stage_kind as enum ('open', 'won', 'lost');

create table public.pipelines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  position        integer not null default 0,
  is_default      boolean not null default false,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (organization_id, id)
);

create unique index pipelines_one_default_idx on public.pipelines (organization_id)
  where is_default and deleted_at is null;

create table public.stages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pipeline_id     uuid not null,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  position        integer not null default 0,
  kind            public.stage_kind not null default 'open',
  probability     smallint not null default 0 check (probability between 0 and 100),
  color           text,
  -- days a deal may sit in this stage before it is flagged as stuck
  rot_days        integer check (rot_days is null or rot_days > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (pipeline_id, id),
  foreign key (organization_id, pipeline_id) references public.pipelines (organization_id, id) on delete cascade
);

create index stages_pipeline_idx on public.stages (pipeline_id, position);

-- ----------------------------------------------------------------------------
-- Lead statuses and sources (editable per organization)
-- ----------------------------------------------------------------------------
create type public.lead_status_kind as enum ('open', 'converted', 'disqualified');

create table public.lead_statuses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 60),
  kind            public.lead_status_kind not null default 'open',
  position        integer not null default 0,
  color           text,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index lead_statuses_one_default_idx on public.lead_statuses (organization_id) where is_default;

create table public.lead_sources (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 60),
  -- manual | form | facebook | webhook | import | whatsapp | phone | other
  kind            text not null default 'manual',
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

-- ----------------------------------------------------------------------------
-- Tags (records keep tag ids in a uuid[] column, so access follows the record)
-- ----------------------------------------------------------------------------
create table public.tags (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 40),
  color           text,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index tags_name_idx on public.tags (organization_id, lower(name));

-- ----------------------------------------------------------------------------
-- Companies
-- ----------------------------------------------------------------------------
create table public.companies (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 200),
  -- ח.פ / עוסק מורשה
  tax_id            text,
  company_type      text,
  industry          text,
  size              text,
  website           text,
  email             text,
  phone             text,
  phone_e164        text,
  address_line      text,
  city              text,
  postal_code       text,
  country           char(2) not null default 'IL',
  parent_company_id uuid,
  owner_id          uuid,
  team_id           uuid,
  tag_ids           uuid[] not null default '{}',
  custom_fields     jsonb not null default '{}'::jsonb,
  created_by        uuid references auth.users (id) on delete set null,
  updated_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, parent_company_id) references public.companies (organization_id, id) on delete set null (parent_company_id),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id),
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete set null (team_id),
  constraint companies_custom_fields_object check (jsonb_typeof(custom_fields) = 'object')
);

create index companies_org_idx on public.companies (organization_id, created_at desc) where deleted_at is null;
create index companies_owner_idx on public.companies (organization_id, owner_id) where deleted_at is null;
create index companies_name_trgm_idx on public.companies using gin (name extensions.gin_trgm_ops);
create index companies_tax_id_idx on public.companies (organization_id, tax_id) where tax_id is not null;

-- ----------------------------------------------------------------------------
-- Contacts
-- ----------------------------------------------------------------------------
create table public.contacts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  first_name      text,
  last_name       text,
  full_name       text generated always as (
                    nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
                  ) stored,
  email           text,
  phone           text,
  phone_e164      text,
  job_title       text,
  contact_type    text,
  company_id      uuid,
  source_id       uuid,
  address_line    text,
  city            text,
  birth_date      date,
  preferred_locale text,
  owner_id        uuid,
  team_id         uuid,
  tag_ids         uuid[] not null default '{}',
  custom_fields   jsonb not null default '{}'::jsonb,
  last_contacted_at timestamptz,
  created_by      uuid references auth.users (id) on delete set null,
  updated_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete set null (company_id),
  foreign key (organization_id, source_id) references public.lead_sources (organization_id, id) on delete set null (source_id),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id),
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete set null (team_id),
  constraint contacts_has_identity check (
    coalesce(btrim(first_name), '') <> '' or coalesce(btrim(last_name), '') <> ''
    or coalesce(btrim(email), '') <> '' or coalesce(btrim(phone), '') <> ''
  ),
  constraint contacts_custom_fields_object check (jsonb_typeof(custom_fields) = 'object')
);

create index contacts_org_idx on public.contacts (organization_id, created_at desc) where deleted_at is null;
create index contacts_owner_idx on public.contacts (organization_id, owner_id) where deleted_at is null;
create index contacts_company_idx on public.contacts (organization_id, company_id);
create index contacts_phone_idx on public.contacts (organization_id, phone_e164) where phone_e164 is not null;
create index contacts_email_idx on public.contacts (organization_id, lower(email)) where email is not null;
create index contacts_name_trgm_idx on public.contacts using gin (full_name extensions.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Leads
-- ----------------------------------------------------------------------------
create table public.leads (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  full_name            text,
  email                text,
  phone                text,
  phone_e164           text,
  company_name         text,
  job_title            text,
  status_id            uuid not null,
  source_id            uuid,
  campaign             text,
  utm                  jsonb not null default '{}'::jsonb,
  score                integer not null default 0,
  budget_agorot        bigint check (budget_agorot is null or budget_agorot >= 0),
  message              text,
  disqualify_reason    text,
  owner_id             uuid,
  team_id              uuid,
  tag_ids              uuid[] not null default '{}',
  custom_fields        jsonb not null default '{}'::jsonb,
  first_contacted_at   timestamptz,
  last_contacted_at    timestamptz,
  converted_at         timestamptz,
  converted_contact_id uuid,
  converted_company_id uuid,
  converted_deal_id    uuid,
  created_by           uuid references auth.users (id) on delete set null,
  updated_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, status_id) references public.lead_statuses (organization_id, id),
  foreign key (organization_id, source_id) references public.lead_sources (organization_id, id) on delete set null (source_id),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id),
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete set null (team_id),
  foreign key (organization_id, converted_contact_id) references public.contacts (organization_id, id) on delete set null (converted_contact_id),
  foreign key (organization_id, converted_company_id) references public.companies (organization_id, id) on delete set null (converted_company_id),
  constraint leads_has_identity check (
    coalesce(btrim(full_name), '') <> '' or coalesce(btrim(email), '') <> '' or coalesce(btrim(phone), '') <> ''
  ),
  constraint leads_custom_fields_object check (jsonb_typeof(custom_fields) = 'object')
);

create index leads_org_idx on public.leads (organization_id, created_at desc) where deleted_at is null;
create index leads_owner_idx on public.leads (organization_id, owner_id) where deleted_at is null;
create index leads_status_idx on public.leads (organization_id, status_id) where deleted_at is null;
create index leads_phone_idx on public.leads (organization_id, phone_e164) where phone_e164 is not null;
create index leads_email_idx on public.leads (organization_id, lower(email)) where email is not null;
create index leads_name_trgm_idx on public.leads using gin (full_name extensions.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Deals
-- ----------------------------------------------------------------------------
create table public.deals (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 200),
  amount_agorot       bigint not null default 0 check (amount_agorot >= 0),
  currency            char(3) not null default 'ILS',
  pipeline_id         uuid not null,
  stage_id            uuid not null,
  -- copied from the stage by trigger; kept on the row for fast filtering
  status              public.stage_kind not null default 'open',
  probability         smallint not null default 0 check (probability between 0 and 100),
  expected_close_date date,
  stage_entered_at    timestamptz not null default now(),
  closed_at           timestamptz,
  lost_reason         text,
  contact_id          uuid,
  company_id          uuid,
  source_id           uuid,
  owner_id            uuid,
  team_id             uuid,
  tag_ids             uuid[] not null default '{}',
  custom_fields       jsonb not null default '{}'::jsonb,
  created_by          uuid references auth.users (id) on delete set null,
  updated_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, pipeline_id) references public.pipelines (organization_id, id),
  -- the stage must belong to the deal's pipeline
  foreign key (pipeline_id, stage_id) references public.stages (pipeline_id, id),
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete set null (contact_id),
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete set null (company_id),
  foreign key (organization_id, source_id) references public.lead_sources (organization_id, id) on delete set null (source_id),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id),
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete set null (team_id),
  constraint deals_custom_fields_object check (jsonb_typeof(custom_fields) = 'object')
);

create index deals_org_idx on public.deals (organization_id, created_at desc) where deleted_at is null;
create index deals_board_idx on public.deals (organization_id, pipeline_id, stage_id) where deleted_at is null;
create index deals_owner_idx on public.deals (organization_id, owner_id) where deleted_at is null;
create index deals_contact_idx on public.deals (organization_id, contact_id);
create index deals_company_idx on public.deals (organization_id, company_id);

alter table public.leads
  add foreign key (organization_id, converted_deal_id) references public.deals (organization_id, id) on delete set null (converted_deal_id);

-- additional contacts on a deal, with their role in the purchase
create table public.deal_contacts (
  organization_id uuid not null,
  deal_id         uuid not null,
  contact_id      uuid not null,
  role            text,
  created_at      timestamptz not null default now(),
  primary key (deal_id, contact_id),
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade
);

-- ----------------------------------------------------------------------------
-- Activities: the timeline of every record
-- ----------------------------------------------------------------------------
create table public.activities (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- note | call | meeting | email | whatsapp | sms | stage_change | status_change
  -- | conversion | assignment | system
  type            text not null check (type ~ '^[a-z_]{2,40}$'),
  body            text,
  metadata        jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  is_pinned       boolean not null default false,
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete cascade,
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete cascade,
  constraint activities_has_subject check (num_nonnulls(lead_id, contact_id, company_id, deal_id) >= 1)
);

create index activities_lead_idx on public.activities (lead_id, occurred_at desc) where lead_id is not null;
create index activities_contact_idx on public.activities (contact_id, occurred_at desc) where contact_id is not null;
create index activities_company_idx on public.activities (company_id, occurred_at desc) where company_id is not null;
create index activities_deal_idx on public.activities (deal_id, occurred_at desc) where deal_id is not null;

-- ----------------------------------------------------------------------------
-- Tasks
-- ----------------------------------------------------------------------------
create type public.task_status as enum ('open', 'done', 'cancelled');

create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title           text not null check (char_length(btrim(title)) between 1 and 300),
  description     text,
  -- call | meeting | todo | follow_up ...
  task_type       text not null default 'todo',
  due_at          timestamptz,
  remind_at       timestamptz,
  priority        smallint not null default 2 check (priority between 1 and 3),
  status          public.task_status not null default 'open',
  completed_at    timestamptz,
  outcome         text,
  -- the assignee; named owner_id so tasks follow the same access rules as records
  owner_id        uuid,
  team_id         uuid,
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  created_by      uuid references auth.users (id) on delete set null,
  updated_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id),
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete set null (team_id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete cascade,
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete cascade
);

create index tasks_owner_due_idx on public.tasks (organization_id, owner_id, due_at) where status = 'open' and deleted_at is null;
create index tasks_lead_idx on public.tasks (lead_id) where lead_id is not null;
create index tasks_contact_idx on public.tasks (contact_id) where contact_id is not null;
create index tasks_deal_idx on public.tasks (deal_id) where deal_id is not null;

-- ----------------------------------------------------------------------------
-- Custom field definitions and saved views
-- ----------------------------------------------------------------------------
create table public.field_definitions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  object_type     text not null check (object_type in ('lead', 'contact', 'company', 'deal')),
  -- key inside custom_fields
  key             text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label           text not null check (char_length(btrim(label)) between 1 and 80),
  field_type      text not null check (field_type in (
                    'text', 'long_text', 'number', 'currency', 'percent', 'rating',
                    'select', 'multi_select', 'checkbox', 'date', 'datetime',
                    'phone', 'email', 'url', 'il_id', 'il_company_id', 'user')),
  options         jsonb not null default '[]'::jsonb,
  is_required     boolean not null default false,
  is_active       boolean not null default true,
  help_text       text,
  position        integer not null default 0,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, object_type, key)
);

create type public.view_scope as enum ('private', 'team', 'org');

create table public.saved_views (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  object_type     text not null check (object_type in ('lead', 'contact', 'company', 'deal', 'task')),
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  -- { layout, columns, filters, sort }
  config          jsonb not null default '{}'::jsonb,
  scope           public.view_scope not null default 'private',
  owner_id        uuid not null,
  team_id         uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id) on delete cascade,
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete cascade,
  constraint saved_views_team_scope check ((scope = 'team') = (team_id is not null))
);

-- =============================================================================
-- Triggers
-- =============================================================================

create trigger pipelines_touch before insert or update on public.pipelines for each row execute function app.touch_row();
create trigger stages_touch before update on public.stages for each row execute function app.touch_row();
create trigger lead_statuses_touch before update on public.lead_statuses for each row execute function app.touch_row();
create trigger lead_sources_touch before update on public.lead_sources for each row execute function app.touch_row();
create trigger tags_touch before insert or update on public.tags for each row execute function app.touch_row();
create trigger companies_touch before insert or update on public.companies for each row execute function app.touch_row();
create trigger contacts_touch before insert or update on public.contacts for each row execute function app.touch_row();
create trigger leads_touch before insert or update on public.leads for each row execute function app.touch_row();
create trigger deals_touch before insert or update on public.deals for each row execute function app.touch_row();
create trigger activities_touch before insert or update on public.activities for each row execute function app.touch_row();
create trigger tasks_touch before insert or update on public.tasks for each row execute function app.touch_row();
create trigger field_definitions_touch before insert or update on public.field_definitions for each row execute function app.touch_row();
create trigger saved_views_touch before update on public.saved_views for each row execute function app.touch_row();

-- phone -> phone_e164, lower-cased email
create or replace function app.normalize_contact_fields() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.phone_e164 := app.normalize_phone(new.phone);
  new.email := nullif(lower(btrim(new.email)), '');
  return new;
end;
$$;

-- Fires on every write, not only when phone/email are in the SET list, so a
-- client cannot write phone_e164 directly.
create trigger companies_normalize before insert or update on public.companies
  for each row execute function app.normalize_contact_fields();
create trigger contacts_normalize before insert or update on public.contacts
  for each row execute function app.normalize_contact_fields();
create trigger leads_normalize before insert or update on public.leads
  for each row execute function app.normalize_contact_fields();

-- A record created by a signed-in user without an owner belongs to its creator.
-- Rows written by the server (lead forms, imports) may stay unassigned.
create or replace function app.default_owner() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is null and auth.uid() is not null and current_user = 'authenticated' then
    new.owner_id := auth.uid();
  end if;
  return new;
end;
$$;

create trigger companies_default_owner before insert on public.companies for each row execute function app.default_owner();
create trigger contacts_default_owner before insert on public.contacts for each row execute function app.default_owner();
create trigger leads_default_owner before insert on public.leads for each row execute function app.default_owner();
create trigger deals_default_owner before insert on public.deals for each row execute function app.default_owner();
create trigger tasks_default_owner before insert on public.tasks for each row execute function app.default_owner();

-- Recycle bin: moving a row in or out of it needs delete permission, which is
-- stricter than edit permission. Enforced here because an RLS UPDATE policy
-- cannot tell which column changed.
create or replace function app.guard_soft_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.deleted_at is null) <> (old.deleted_at is null)
     and current_user in ('authenticated', 'anon')
     and not app.can_delete_record(old.organization_id, old.owner_id, old.team_id) then
    raise exception 'not allowed to delete or restore this record' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger companies_soft_delete before update of deleted_at on public.companies for each row execute function app.guard_soft_delete();
create trigger contacts_soft_delete before update of deleted_at on public.contacts for each row execute function app.guard_soft_delete();
create trigger leads_soft_delete before update of deleted_at on public.leads for each row execute function app.guard_soft_delete();
create trigger deals_soft_delete before update of deleted_at on public.deals for each row execute function app.guard_soft_delete();
create trigger tasks_soft_delete before update of deleted_at on public.tasks for each row execute function app.guard_soft_delete();

-- Plan limit on the number of live records (leads + contacts + companies + deals).
create or replace function app.count_record() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_delta integer := 0;
  v_limit numeric;
  v_count bigint;
begin
  if tg_op = 'INSERT' then
    v_org := new.organization_id;
    if new.deleted_at is null then v_delta := 1; end if;
  elsif tg_op = 'DELETE' then
    v_org := old.organization_id;
    if old.deleted_at is null then v_delta := -1; end if;
  else
    v_org := new.organization_id;
    if old.deleted_at is null and new.deleted_at is not null then v_delta := -1;
    elsif old.deleted_at is not null and new.deleted_at is null then v_delta := 1;
    end if;
  end if;

  if v_delta = 0 then
    return null;
  end if;

  update public.org_usage u
     set records_count = greatest(u.records_count + v_delta, 0), updated_at = now()
   where u.organization_id = v_org
   returning u.records_count into v_count;

  -- the organization itself is being deleted
  if not found then
    return null;
  end if;

  if v_delta > 0 then
    v_limit := app.org_limit(v_org, 'max_records');
    if v_limit is not null and v_count > v_limit then
      raise exception 'plan record limit reached (%)', v_limit using errcode = 'P0001', hint = 'limit:max_records';
    end if;
  end if;
  return null;
end;
$$;

create trigger companies_count after insert or delete or update of deleted_at on public.companies for each row execute function app.count_record();
create trigger contacts_count after insert or delete or update of deleted_at on public.contacts for each row execute function app.count_record();
create trigger leads_count after insert or delete or update of deleted_at on public.leads for each row execute function app.count_record();
create trigger deals_count after insert or delete or update of deleted_at on public.deals for each row execute function app.count_record();

-- Plan limits that are checked by counting (small tables).
create or replace function app.enforce_count_limit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_key text := tg_argv[0];
  v_limit numeric := app.org_limit(new.organization_id, v_key);
  v_count bigint;
begin
  if v_limit is null then
    return new;
  end if;
  if tg_table_name = 'pipelines' then
    select count(*) into v_count from public.pipelines p
      where p.organization_id = new.organization_id and p.deleted_at is null and p.id <> new.id;
  elsif tg_table_name = 'field_definitions' then
    select count(*) into v_count from public.field_definitions f
      where f.organization_id = new.organization_id and f.object_type = new.object_type
        and f.is_active and f.id <> new.id;
  else
    raise exception 'enforce_count_limit: unsupported table %', tg_table_name;
  end if;
  if v_count + 1 > v_limit then
    raise exception 'plan limit reached (% = %)', v_key, v_limit using errcode = 'P0001', hint = 'limit:' || v_key;
  end if;
  return new;
end;
$$;

create trigger pipelines_limit before insert on public.pipelines
  for each row execute function app.enforce_count_limit('max_pipelines');
create trigger field_definitions_limit before insert on public.field_definitions
  for each row execute function app.enforce_count_limit('max_custom_fields_per_object');

-- Deal stage bookkeeping: status, probability, closed_at, stage_entered_at.
create or replace function app.sync_deal_stage() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_stage public.stages%rowtype;
begin
  if tg_op = 'UPDATE' and new.stage_id = old.stage_id and new.pipeline_id = old.pipeline_id then
    -- status is derived; do not let a client set it directly
    new.status := old.status;
    return new;
  end if;

  select * into v_stage from public.stages s where s.id = new.stage_id;
  new.status := v_stage.kind;
  new.stage_entered_at := now();
  if tg_op = 'INSERT' or new.probability = old.probability then
    new.probability := v_stage.probability;
  end if;
  if v_stage.kind = 'open' then
    new.closed_at := null;
    new.lost_reason := null;
  else
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  return new;
end;
$$;

create trigger deals_sync_stage before insert or update on public.deals
  for each row execute function app.sync_deal_stage();

-- Timeline entry whenever a deal changes stage or a lead changes status.
-- Two functions, not one: PL/pgSQL raises on new.<column> for a column the
-- firing table does not have, even inside a branch for the other table.
create or replace function app.log_deal_stage_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.activities (organization_id, type, deal_id, metadata, created_by)
    values (new.organization_id, 'stage_change', new.id,
            jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id, 'status', new.status),
            auth.uid());
  end if;
  return null;
end;
$$;

create or replace function app.log_lead_status_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status_id is distinct from old.status_id then
    insert into public.activities (organization_id, type, lead_id, metadata, created_by)
    values (new.organization_id, 'status_change', new.id,
            jsonb_build_object('from_status_id', old.status_id, 'to_status_id', new.status_id),
            auth.uid());
  end if;
  return null;
end;
$$;

create trigger deals_log_stage after update of stage_id on public.deals
  for each row execute function app.log_deal_stage_change();
create trigger leads_log_status after update of status_id on public.leads
  for each row execute function app.log_lead_status_change();

-- Completing a task stamps completed_at.
create or replace function app.sync_task_status() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

create trigger tasks_sync_status before insert or update of status on public.tasks
  for each row execute function app.sync_task_status();
