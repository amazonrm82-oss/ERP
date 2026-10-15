-- =============================================================================
-- 0192 Meeting types (CAL-08)
-- =============================================================================
-- * public.meeting_types: a managed list of the kinds of meeting a business holds
--   ("פגישת היכרות", "פגישת מכירה", "שיחת טלפון"): name, duration, how it is held
--   (meeting_format: the values of meetings.meeting_type, or null), location, a
--   linked service from the catalogue (product_id), the free time kept before and
--   after it (buffers) and a colour (a palette key, the same list as
--   stages.color, mirrored by src/features/deals/stage-colors.ts).
--   Configuration, like deal_loss_reasons (0121): members read, owners and admins
--   of a writable organization write; a hidden type (is_active = false) is no
--   longer offered for new meetings; names unique per organization ignoring case;
--   at most 50 per organization (hint 'meeting_types:max'). Audited.
--   No plan key: the calendar is core (question to the owner in the report).
-- * The linked service is optional. A person may link only an offerable product
--   of the same organization (active and not archived; hint
--   'meeting_type:product'), and only while the plan has the 'products' flag
--   (hint 'feature:products'). Deleting a product clears the link (set null).
-- * meetings.meeting_type_id: the type a meeting was set from (composite FK, set
--   null when the type is deleted; column grants). A person may pick only an
--   active type (hint 'meeting:type'); a meeting keeps a type that was hidden
--   later. Picking a type fills the form's duration, format and location in the
--   app; the database does not copy them.
-- * Buffers count as busy (CAL-05): public.meeting_busy() now answers for a
--   meeting whose time plus its type's buffers overlaps the asked window, and
--   returns that stretch as busy_from / busy_to next to the meeting's own times.
--   The app asks with the new meeting's own buffers added, and from the rows
--   decides the clash (src/features/meetings/conflicts.ts): a meeting may not fall
--   into another meeting's buffers nor its buffers on another meeting; two
--   buffers may overlap each other. Adding columns to the
--   result is a new return type, which create or replace cannot make and a
--   migration here may not drop: the 0093 function is first moved out of the API
--   (renamed, moved into schema app, all grants revoked), as in 0180.
-- * Defaults: app.seed_meeting_types(org) inserts them while the list is empty;
--   the trigger organizations_seed_meeting_types seeds every new organization
--   (create_organization is not changed), and existing organizations are seeded
--   once at the end. The rows mirror DEFAULT_MEETING_TYPES in
--   src/features/meeting-types/schema.ts (tests/db/99-meeting-types.test.ts).
-- Every statement is safe to run twice. No deletes, no drops.

create table if not exists public.meeting_types (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  name                  text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  duration_minutes      integer not null default 30 check (duration_minutes between 5 and 720),
  meeting_format        text check (meeting_format in ('in_person', 'phone', 'video', 'other')),
  location              text check (char_length(location) between 1 and 500),
  product_id            uuid,
  buffer_before_minutes integer not null default 0 check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes  integer not null default 0 check (buffer_after_minutes between 0 and 240),
  color                 text check (color in ('accent', 'success', 'warning', 'danger', 'neutral')),
  position              integer not null default 0,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, id),
  constraint meeting_types_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id) on delete set null (product_id)
);

create unique index if not exists meeting_types_name_idx on public.meeting_types (organization_id, lower(name));
create index if not exists meeting_types_org_idx on public.meeting_types (organization_id, position);
create index if not exists meeting_types_product_idx on public.meeting_types (organization_id, product_id) where product_id is not null;

alter table public.meeting_types enable row level security;

revoke all on public.meeting_types from anon, authenticated;
grant select, delete on public.meeting_types to authenticated;
grant insert (organization_id, name, duration_minutes, meeting_format, location, product_id, buffer_before_minutes,
              buffer_after_minutes, color, position, is_active)
  on public.meeting_types to authenticated;
grant update (name, duration_minutes, meeting_format, location, product_id, buffer_before_minutes,
              buffer_after_minutes, color, position, is_active)
  on public.meeting_types to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meeting_types' and policyname = 'meeting_types_select') then
    create policy meeting_types_select on public.meeting_types for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meeting_types' and policyname = 'meeting_types_insert') then
    create policy meeting_types_insert on public.meeting_types for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meeting_types' and policyname = 'meeting_types_update') then
    create policy meeting_types_update on public.meeting_types for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meeting_types' and policyname = 'meeting_types_delete') then
    create policy meeting_types_delete on public.meeting_types for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger meeting_types_touch before update on public.meeting_types
  for each row execute function app.touch_row();
create or replace trigger meeting_types_audit after insert or update or delete on public.meeting_types
  for each row execute function app.audit_row();

-- at most 50 per organization
create or replace function app.meeting_types_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider is refused by RLS (plain 42501) right after; answering here would tell about the business
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('meeting_types:' || new.organization_id::text, 0));
  if (select count(*) from public.meeting_types t where t.organization_id = new.organization_id) >= 50 then
    raise exception 'too many meeting types' using errcode = 'P0001', hint = 'meeting_types:max';
  end if;
  return new;
end;
$$;
revoke all on function app.meeting_types_cap() from public, anon, authenticated;

create or replace trigger meeting_types_cap before insert on public.meeting_types
  for each row execute function app.meeting_types_cap();

-- the linked service: an offerable product, while the plan holds products
create or replace function app.meeting_types_product_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user not in ('authenticated', 'anon') or new.product_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.product_id is not distinct from old.product_id then
    return new;
  end if;
  -- a writer who is not a member of this business is refused by RLS (plain 42501) right after
  -- this trigger; answering here would tell an outsider about the business's products or plan
  if not app.is_member(new.organization_id) then
    return new;
  end if;
  -- read with the caller's rights (products: members read)
  if not exists (
    select 1 from public.products p
    where p.organization_id = new.organization_id
      and p.id = new.product_id
      and p.is_active
      and p.archived_at is null
  ) then
    raise exception 'the linked service is not available' using errcode = 'P0001', hint = 'meeting_type:product';
  end if;
  if not app.org_has_feature(new.organization_id, 'products') then
    raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
  end if;
  return new;
end;
$$;
revoke all on function app.meeting_types_product_check() from public, anon, authenticated;

create or replace trigger meeting_types_product_check before insert or update of product_id on public.meeting_types
  for each row execute function app.meeting_types_product_check();

comment on table public.meeting_types is
  'CAL-08: the kinds of meeting a business holds (managed list): duration, format, location, linked service, buffers, colour.';

-- ----------------------------------------------------------------------------
-- The meeting's type
-- ----------------------------------------------------------------------------
alter table public.meetings add column if not exists meeting_type_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.meetings'::regclass and conname = 'meetings_meeting_type_fk') then
    alter table public.meetings add constraint meetings_meeting_type_fk foreign key (organization_id, meeting_type_id)
      references public.meeting_types (organization_id, id) on delete set null (meeting_type_id);
  end if;
end;
$$;

create index if not exists meetings_meeting_type_idx on public.meetings (organization_id, meeting_type_id) where meeting_type_id is not null;

grant insert (meeting_type_id), update (meeting_type_id) on public.meetings to authenticated;

create or replace function app.meetings_type_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user not in ('authenticated', 'anon') or new.meeting_type_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.meeting_type_id is not distinct from old.meeting_type_id then
    return new;
  end if;
  -- an outsider is refused by RLS right after this trigger
  if not app.is_member(new.organization_id) then
    return new;
  end if;
  if not exists (
    select 1 from public.meeting_types t
    where t.organization_id = new.organization_id
      and t.id = new.meeting_type_id
      and t.is_active
  ) then
    raise exception 'pick a meeting type from the list' using errcode = 'P0001', hint = 'meeting:type';
  end if;
  return new;
end;
$$;
revoke all on function app.meetings_type_check() from public, anon, authenticated;

create or replace trigger meetings_type_check before insert or update of meeting_type_id on public.meetings
  for each row execute function app.meetings_type_check();

comment on column public.meetings.meeting_type_id is
  'CAL-08: the meeting type it was set from (public.meeting_types); a person may pick only an active type.';

-- ----------------------------------------------------------------------------
-- Busy times count the buffers (CAL-05)
-- ----------------------------------------------------------------------------
do $$
begin
  -- the 0093 function returns five columns; it is moved out of the API once
  if to_regprocedure('public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid)') is not null
     and pg_catalog.pg_get_function_result('public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid)'::regprocedure) not like '%busy_from%' then
    alter function public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid) rename to meeting_busy_0192_retired;
    alter function public.meeting_busy_0192_retired(uuid, uuid[], timestamptz, timestamptz, uuid) set schema app;
    revoke all on function app.meeting_busy_0192_retired(uuid, uuid[], timestamptz, timestamptz, uuid) from public, anon, authenticated, service_role;
  end if;
end;
$$;

-- Same as 0093, except: a meeting is busy from its start minus its type's buffer
-- before until its end plus the buffer after (busy_from, busy_to), and that
-- stretch is what must overlap the asked window. A meeting with no type, or whose
-- type was deleted, has no buffers. Buffers are at most 240 minutes each.
create or replace function public.meeting_busy(
  p_org uuid,
  p_users uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_exclude uuid default null
) returns table (user_id uuid, meeting_id uuid, title text, starts_at timestamptz, ends_at timestamptz,
                 busy_from timestamptz, busy_to timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_org is null or not app.is_member(p_org) or not app.can_write(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if p_users is null or p_from is null or p_to is null
     or cardinality(p_users) > 51 or p_to <= p_from or p_to > p_from + interval '15 days' then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;

  return query
  with people as (
    select distinct m.user_id
    from public.memberships m
    where m.organization_id = p_org
      and m.status = 'active'
      and m.user_id = any (p_users)
  ),
  candidates as (
    -- the largest buffer is 240 minutes (the buffer checks on meeting_types; tests/db/99-meeting-types keeps the
    -- two equal): a wider first cut keeps the index on starts_at in use
    select mt.id, mt.owner_id, mt.starts_at, mt.ends_at,
           mt.starts_at - make_interval(mins => coalesce(ty.buffer_before_minutes, 0)) as busy_from,
           mt.ends_at + make_interval(mins => coalesce(ty.buffer_after_minutes, 0)) as busy_to
    from public.meetings mt
    left join public.meeting_types ty on ty.organization_id = mt.organization_id and ty.id = mt.meeting_type_id
    where mt.organization_id = p_org
      and mt.status not in ('cancelled', 'no_show')
      and mt.starts_at < p_to + interval '240 minutes' and mt.ends_at > p_from - interval '240 minutes'
  ),
  busy as (
    select c.* from candidates c where c.busy_from < p_to and c.busy_to > p_from
  ),
  taken as (
    -- organized
    select b.owner_id as user_id, b.id as meeting_id, b.starts_at, b.ends_at, b.busy_from, b.busy_to
    from busy b
    join people p on p.user_id = b.owner_id
    union
    -- taken part in
    select mp.user_id, b.id, b.starts_at, b.ends_at, b.busy_from, b.busy_to
    from busy b
    join public.meeting_participants mp on mp.organization_id = p_org and mp.meeting_id = b.id
    join people p on p.user_id = mp.user_id
  )
  select t.user_id,
         case when v.readable then mt.id end,
         case when v.readable then mt.title end,
         t.starts_at, t.ends_at, t.busy_from, t.busy_to
  from taken t
  join public.meetings mt on mt.organization_id = p_org and mt.id = t.meeting_id
  -- MUST stay in step with the meetings_select policy (migrations
  -- 20261006005320_meetings_policies.sql and
  -- 20261006009300_team_manager_internal_meetings.sql): the same expression on
  -- the row, so the id and title come back exactly when the caller could select
  -- the row.
  cross join lateral (
    select (app.can_read_record(mt.organization_id, mt.owner_id, null)
            or app.manages_meeting_organizer(mt.organization_id, mt.owner_id)
            or (app.is_member(mt.organization_id)
                and (mt.created_by = (select auth.uid()) or app.is_meeting_participant(mt.organization_id, mt.id)))
            or app.meeting_subject_ok(mt.organization_id, mt.lead_id, mt.contact_id, mt.company_id, mt.deal_id, false)) as readable
  ) v
  -- the meeting being edited is left out only when the caller may read it:
  -- excluding a hidden meeting by its id would tell who is in it
  where p_exclude is null or t.meeting_id <> p_exclude or not coalesce(v.readable, false)
  order by t.starts_at, t.ends_at, t.user_id, t.meeting_id
  limit 500;
end;
$$;

revoke all on function public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Default types: an organization starts with these and renames or deletes them
-- ----------------------------------------------------------------------------
create or replace function app.seed_meeting_types(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.meeting_types (organization_id, name, duration_minutes, meeting_format, color, position)
  select p_org, d.name, d.minutes, d.format, d.color, d.pos
    from (values ('פגישת היכרות', 30, 'in_person', 'accent', 0),
                 ('פגישת מכירה', 60, 'in_person', 'success', 1),
                 ('שיחת טלפון', 15, 'phone', 'warning', 2),
                 ('שיחת וידאו', 30, 'video', 'danger', 3)) as d(name, minutes, format, color, pos)
   where not exists (select 1 from public.meeting_types t where t.organization_id = p_org)
   order by d.pos;
end;
$$;
revoke all on function app.seed_meeting_types(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_meeting_types() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_meeting_types(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_meeting_types() from public, anon, authenticated;

create or replace trigger organizations_seed_meeting_types after insert on public.organizations
  for each row execute function app.organizations_seed_meeting_types();

-- existing organizations: once (an organization that already has types is left alone).
-- A re-run seeds again only a list that is empty then, which is what the owner asked for (managed lists rule).
select app.seed_meeting_types(o.id) from public.organizations o;

notify pgrst, 'reload schema';
