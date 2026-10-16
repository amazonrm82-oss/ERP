-- =============================================================================
-- 020150 Segments (SEG-01)
-- =============================================================================
-- "סגמנט דינמי הוא סינון שמור (LST-05) על לידים או אנשי קשר. סגמנט סטטי הוא רשימה ידנית."
-- Plan (owner, 13 October 2026): flag `segments` in every plan; quota `max_segments` 3 / 10 / 50 / 200 (wave 2 keys, 0146).
--
-- * public.segments: one per name the business keeps, on leads or on contacts (object_type, fixed), dynamic or static
--   (kind, fixed). A dynamic segment holds the list filter (LST-05 tree, checked by the app's schema; here an object of at
--   most 16 kB); a static one holds no filter and has members. Every member reads them; owners, admins and managers of a
--   writable business write them (app.segments_writable). Audited. The flag and the quota by a definer trigger with the
--   outsider guard first and an advisory lock per business.
-- * public.segment_members: a static segment's leads or contacts (exactly one, of the segment's type), each once; at most
--   10,000 per segment. A row is seen only with its record (the record's own RLS decides); adding needs a record the
--   person reads; the segment's writers add and remove. Cascades with the segment and with the record.
-- * Merges carry a duplicate's memberships to the kept record through the `merged` timeline entry (as CON-05), and
--   app.sample_untouched and app.import_record_worked (both last redefined in 020105) count a membership as real work.
-- * A dynamic segment's members are worked out by the app with the person's own session (the list's query), so each
--   person sees only what they may see.
-- No delete statement, no drop statement. Safe to run twice.

-- Who writes segments: owners, admins and managers of a writable business
create or replace function app.segments_writable(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.can_write(p_org)
     and (app.is_admin(p_org) or coalesce(app.membership_role(p_org) = 'manager', false))
$$;
revoke all on function app.segments_writable(uuid) from public, anon;
grant execute on function app.segments_writable(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Segments
-- ----------------------------------------------------------------------------
create table if not exists public.segments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  object_type     text not null check (object_type in ('lead', 'contact')),
  kind            text not null check (kind in ('dynamic', 'static')),
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  filter          jsonb,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint segments_filter_shape check (
    (kind = 'dynamic') = (filter is not null)
    and (filter is null or (jsonb_typeof(filter) = 'object' and pg_column_size(filter) <= 16384)))
);
create index if not exists segments_org_idx on public.segments (organization_id, object_type);

alter table public.segments enable row level security;
revoke all on public.segments from anon, authenticated;
grant select, delete on public.segments to authenticated;
grant insert (organization_id, object_type, kind, name, filter) on public.segments to authenticated;
grant update (name, filter) on public.segments to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'segments' and policyname = 'segments_select') then
    create policy segments_select on public.segments for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'segments' and policyname = 'segments_insert') then
    create policy segments_insert on public.segments for insert to authenticated
      with check (app.segments_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'segments' and policyname = 'segments_update') then
    create policy segments_update on public.segments for update to authenticated
      using (app.segments_writable(organization_id))
      with check (app.segments_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'segments' and policyname = 'segments_delete') then
    create policy segments_delete on public.segments for delete to authenticated
      using (app.segments_writable(organization_id));
  end if;
end;
$$;

create or replace trigger segments_touch before update on public.segments
  for each row execute function app.touch_row();
create or replace trigger segments_audit after insert or update or delete on public.segments
  for each row execute function app.audit_row();

-- The flag and the quota (business-wide); an outsider is refused by RLS right after (plain 42501)
create or replace function app.segments_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  if auth.uid() is not null and not app.segments_writable(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'segments') then
    raise exception 'segments are not in the plan' using errcode = 'P0001', hint = 'feature:segments';
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_segments');
  if v_limit is not null then
    perform pg_advisory_xact_lock(hashtextextended('segments:' || new.organization_id::text, 0));
    if (select count(*) from public.segments s where s.organization_id = new.organization_id) >= v_limit then
      raise exception 'segment limit reached' using errcode = 'P0001', hint = 'limit:max_segments';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.segments_quota() from public, anon, authenticated;

create or replace trigger segments_quota before insert on public.segments
  for each row execute function app.segments_quota();

-- ----------------------------------------------------------------------------
-- Static segment members
-- ----------------------------------------------------------------------------
create table if not exists public.segment_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  segment_id      uuid not null,
  lead_id         uuid,
  contact_id      uuid,
  added_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint segment_members_one_record check (num_nonnulls(lead_id, contact_id) = 1),
  constraint segment_members_segment_fk foreign key (organization_id, segment_id)
    references public.segments (organization_id, id) on delete cascade,
  constraint segment_members_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete cascade,
  constraint segment_members_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade
);
create unique index if not exists segment_members_lead_once on public.segment_members (segment_id, lead_id) where lead_id is not null;
create unique index if not exists segment_members_contact_once on public.segment_members (segment_id, contact_id) where contact_id is not null;
create index if not exists segment_members_lead_idx on public.segment_members (organization_id, lead_id) where lead_id is not null;
create index if not exists segment_members_contact_idx on public.segment_members (organization_id, contact_id) where contact_id is not null;
-- a full index for the segment's foreign key (FXD-06, test 130): the partial unique indexes above do not serve it
create index if not exists segment_members_segment_idx on public.segment_members (organization_id, segment_id);

alter table public.segment_members enable row level security;
revoke all on public.segment_members from anon, authenticated;
grant select, delete on public.segment_members to authenticated;
grant insert (organization_id, segment_id, lead_id, contact_id) on public.segment_members to authenticated;

do $$
begin
  -- a row is seen only with its record: the record's own RLS decides
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'segment_members' and policyname = 'segment_members_select') then
    create policy segment_members_select on public.segment_members for select to authenticated
      using (app.is_member(organization_id)
             and (exists (select 1 from public.leads l where l.organization_id = segment_members.organization_id and l.id = segment_members.lead_id)
                  or exists (select 1 from public.contacts c where c.organization_id = segment_members.organization_id and c.id = segment_members.contact_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'segment_members' and policyname = 'segment_members_insert') then
    create policy segment_members_insert on public.segment_members for insert to authenticated
      with check (app.segments_writable(organization_id)
                  and (exists (select 1 from public.leads l where l.organization_id = segment_members.organization_id and l.id = segment_members.lead_id)
                       or exists (select 1 from public.contacts c where c.organization_id = segment_members.organization_id and c.id = segment_members.contact_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'segment_members' and policyname = 'segment_members_delete') then
    -- like insert: only members whose record the writer reads (a bare DELETE reaches nothing else)
    create policy segment_members_delete on public.segment_members for delete to authenticated
      using (app.segments_writable(organization_id)
             and (exists (select 1 from public.leads l where l.organization_id = segment_members.organization_id and l.id = segment_members.lead_id)
                  or exists (select 1 from public.contacts c where c.organization_id = segment_members.organization_id and c.id = segment_members.contact_id)));
  end if;
end;
$$;

-- A member of a static segment of its type, each once (the unique indexes), at most 10,000 per segment
create or replace function app.segment_members_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_segment public.segments;
begin
  if auth.uid() is not null and not app.segments_writable(new.organization_id) then
    return new;
  end if;
  select * into v_segment from public.segments s where s.organization_id = new.organization_id and s.id = new.segment_id;
  if not found then
    -- the foreign key refuses it
    return new;
  end if;
  if v_segment.kind <> 'static'
     or (v_segment.object_type = 'lead' and new.lead_id is null)
     or (v_segment.object_type = 'contact' and new.contact_id is null) then
    raise exception 'only a static segment of the record''s type takes members' using errcode = '22023', hint = 'segment_member:invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('segment_members:' || new.segment_id::text, 0));
  if (select count(*) from public.segment_members m where m.organization_id = new.organization_id and m.segment_id = new.segment_id) >= 10000 then
    raise exception 'at most 10,000 in a segment' using errcode = 'P0001', hint = 'segment_members:max';
  end if;
  return new;
end;
$$;
revoke all on function app.segment_members_check() from public, anon, authenticated;

create or replace trigger segment_members_check before insert on public.segment_members
  for each row execute function app.segment_members_check();

-- A merge carries the duplicate's memberships to the kept record (the `merged` entry that merge_records writes, as
-- CON-05's app.merge_contact_companies; until app.merge_move_links takes it over)
create or replace function app.merge_segment_members() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.lead_id is not null then
    if v_merged = new.lead_id
       or not exists (select 1 from public.leads l where l.organization_id = new.organization_id and l.id = new.lead_id)
       or not exists (select 1 from public.leads m where m.organization_id = new.organization_id and m.id = v_merged) then
      return null;
    end if;
    insert into public.segment_members (organization_id, segment_id, lead_id, added_by)
    select sm.organization_id, sm.segment_id, new.lead_id, sm.added_by
      from public.segment_members sm
     where sm.organization_id = new.organization_id and sm.lead_id = v_merged
    on conflict do nothing;
  elsif new.contact_id is not null then
    if v_merged = new.contact_id
       or not exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id)
       or not exists (select 1 from public.contacts m where m.organization_id = new.organization_id and m.id = v_merged) then
      return null;
    end if;
    insert into public.segment_members (organization_id, segment_id, contact_id, added_by)
    select sm.organization_id, sm.segment_id, new.contact_id, sm.added_by
      from public.segment_members sm
     where sm.organization_id = new.organization_id and sm.contact_id = v_merged
    on conflict do nothing;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_segment_members() from public, anon, authenticated;

create or replace trigger activities_merge_segment_members after insert on public.activities
  for each row
  when (new.type = 'system' and (new.lead_id is not null or new.contact_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_segment_members();

-- ----------------------------------------------------------------------------
-- Sample data: a record a person put in a list is kept (020105's body, two lines added)
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
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
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id);
  end if;
end;
$$;

revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Undoing one's own import (PRM-01) keeps a record a person put in a static segment: the body of 020105 (020125 and
-- 020140 do not change it) with the segment checks
create or replace function app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamptz, p_job uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- an imported task has no records linked to it; its own row is the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job));
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
