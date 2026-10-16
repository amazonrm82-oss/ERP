-- =============================================================================
-- Relations between contacts: spouse, parent, referrer; a referrals report (CON-06)
-- =============================================================================
-- * public.contact_relation_types: a managed list per business (12 October rule), like deal_contact_roles.
--   A type reads from the first contact: "A <name> B" (הורה של), and from the second: "B <reverse_name> A"
--   (ילד/ה של); reverse_name null = the same both ways (בן/בת זוג של). Members read; owners and admins of a
--   writable organization write; names unique per organization ignoring case; at most 20 (hint
--   'contact_relation_types:max'; an outsider gets RLS's plain refusal first). `key` is server-only: the seed
--   marks its four defaults ('spouse', 'family', 'parent', 'referral'); the referrals report counts the type with key
--   'referral', under whatever name the business gives it. A type in use cannot be deleted (foreign key, no
--   action: hint the app maps to "hide it instead"); a hidden type (is_active false) stays on its relations.
--   Audited. Defaults: app.seed_contact_relation_types(org), the trigger organizations_seed_contact_relation_types
--   for new organizations, and existing organizations whose list is empty, once; mirrored by
--   DEFAULT_CONTACT_RELATION_TYPES in src/features/contact-relations/types.ts (unit test). "בן/בת משפחה של" (owner,
--   15 October 2026) is also added, last, to a list that has neither its key nor its name; no other type is touched.
-- * public.contact_relations (contact_id | lead_id, related_contact_id, type_id): one row per relation, two different
--   contacts of the same business, or a lead that referred a contact (owner, 15 October 2026: the lead is the first
--   side of the type with key 'referral', hint 'contact_relation:lead_type'); composite foreign keys, cascade with
--   either side. Seen only by whoever reads both sides; added and removed by whoever may edit one side (and reads the
--   other), in a writable organization, both outside the recycle bin, a lead also not converted (adding). No update:
--   a relation is changed by removing and adding. On conversion the lead's relations move to its new contact.
--   The same type between the same two people once, in either direction (hint 'contact_relation:exists'); a
--   person picks only an active type (hint 'contact_relation:type'); at most 50 relations per contact from the
--   browser (hint 'contact_relation:max').
-- * Audit: a relation added or removed is written as a change of both sides (field relation: the phrase of that
--   side, plus related_contact_id / related_lead_id as context; a lead's entry is on the lead). The other person's name is never stored in the
--   entry, so a privacy erasure of one contact leaves nothing personal of them in the other's history.
-- * Merge: until app.merge_move_links() (shared ground) moves them, the "merged" timeline entry of a contact merge
--   carries the duplicate's relations to the kept contact (skipping a relation with the kept contact itself and
--   one it already has); the duplicate's rows then go by cascade. A merge of two leads does the same with referrals.
-- * Sample data (USR-04): app.sample_untouched() (body of contact_companies, 020070, plus a line for contacts and one for
--   leads): any relation keeps a sample contact or lead (sample data makes none). Undo of one's own import (PRM-01):
--   app.import_record_worked() (body of contact_companies, 020070, plus the same two lines): a relation made after the
--   import is work on the contact or lead.
-- * public.report_referrals(org, from, to): security invoker (RLS decides, like every report): the relations of
--   the referral type made in the period, by referrer (a contact, or a lead not converted): referred, customers
--   (referred contacts with a deal won after the referral was recorded; owner, 15 October 2026) and their won amount. public.log_export() (body of meeting_reports, 020050) accepts the report key.
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- The types
-- ----------------------------------------------------------------------------
create table if not exists public.contact_relation_types (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  reverse_name    text check (reverse_name is null or (char_length(reverse_name) between 1 and 40 and reverse_name = btrim(reverse_name))),
  key             text check (key is null or key in ('spouse', 'family', 'parent', 'referral')),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists contact_relation_types_name_idx on public.contact_relation_types (organization_id, lower(name));
create unique index if not exists contact_relation_types_key_idx on public.contact_relation_types (organization_id, key) where key is not null;
create index if not exists contact_relation_types_org_idx on public.contact_relation_types (organization_id, position);

alter table public.contact_relation_types enable row level security;

revoke all on public.contact_relation_types from anon, authenticated;
grant select, delete on public.contact_relation_types to authenticated;
grant insert (organization_id, name, reverse_name, position, is_active) on public.contact_relation_types to authenticated;
grant update (name, reverse_name, position, is_active) on public.contact_relation_types to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_relation_types' and policyname = 'contact_relation_types_select') then
    create policy contact_relation_types_select on public.contact_relation_types for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_relation_types' and policyname = 'contact_relation_types_insert') then
    create policy contact_relation_types_insert on public.contact_relation_types for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_relation_types' and policyname = 'contact_relation_types_update') then
    create policy contact_relation_types_update on public.contact_relation_types for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_relation_types' and policyname = 'contact_relation_types_delete') then
    create policy contact_relation_types_delete on public.contact_relation_types for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger contact_relation_types_touch before update on public.contact_relation_types
  for each row execute function app.touch_row();
create or replace trigger contact_relation_types_audit after insert or update or delete on public.contact_relation_types
  for each row execute function app.audit_row();

create or replace function app.contact_relation_types_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider gets RLS's plain refusal and learns nothing about the organization
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('contact_relation_types:' || new.organization_id::text, 0));
  if (select count(*) from public.contact_relation_types t where t.organization_id = new.organization_id) >= 20 then
    raise exception 'too many contact relation types' using errcode = 'P0001', hint = 'contact_relation_types:max';
  end if;
  return new;
end;
$$;
revoke all on function app.contact_relation_types_cap() from public, anon, authenticated;

create or replace trigger contact_relation_types_cap before insert on public.contact_relation_types
  for each row execute function app.contact_relation_types_cap();

-- ----------------------------------------------------------------------------
-- The relations
-- ----------------------------------------------------------------------------
-- The first side is a contact (contact_id) or a lead (lead_id), exactly one; the second side is always a contact.
-- A lead takes part only as the referrer of a referral (owner, 15 October 2026): the first side of the type with
-- key 'referral', so its contact reads "הופנה/תה על ידי <lead>" with the type's own phrases, and the conversion
-- puts the new contact in the lead's place on the same side.
create table if not exists public.contact_relations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  contact_id         uuid,
  lead_id            uuid,
  related_contact_id uuid not null,
  type_id            uuid not null,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint contact_relations_once unique (organization_id, contact_id, related_contact_id, type_id),
  constraint contact_relations_two_people check (contact_id <> related_contact_id),
  constraint contact_relations_one_first_side check (num_nonnulls(contact_id, lead_id) = 1),
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, related_contact_id) references public.contacts (organization_id, id) on delete cascade,
  -- no action: a type in use is hidden, not deleted
  foreign key (organization_id, type_id) references public.contact_relation_types (organization_id, id)
);

create unique index if not exists contact_relations_lead_once_idx on public.contact_relations (organization_id, lead_id, related_contact_id, type_id)
  where lead_id is not null;
create index if not exists contact_relations_related_idx on public.contact_relations (organization_id, related_contact_id);
create index if not exists contact_relations_type_idx on public.contact_relations (organization_id, type_id, created_at);

alter table public.contact_relations enable row level security;
revoke all on public.contact_relations from anon, authenticated;
grant select, delete on public.contact_relations to authenticated;
grant insert (organization_id, contact_id, lead_id, related_contact_id, type_id) on public.contact_relations to authenticated;

do $$
begin
  -- whoever reads both sides (the sub-selects run under the contacts and leads policies)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_relations' and policyname = 'contact_relations_select') then
    create policy contact_relations_select on public.contact_relations for select to authenticated
      using ((exists (select 1 from public.contacts c
                       where c.organization_id = contact_relations.organization_id and c.id = contact_relations.contact_id)
              or exists (select 1 from public.leads l
                          where l.organization_id = contact_relations.organization_id and l.id = contact_relations.lead_id))
             and exists (select 1 from public.contacts c
                          where c.organization_id = contact_relations.organization_id and c.id = contact_relations.related_contact_id));
  end if;
  -- whoever may edit one side and reads the other, both live (a lead also not converted), in a writable organization
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_relations' and policyname = 'contact_relations_insert') then
    create policy contact_relations_insert on public.contact_relations for insert to authenticated
      with check (app.can_write(organization_id)
                  and (exists (select 1 from public.contacts a
                                where a.organization_id = contact_relations.organization_id and a.id = contact_relations.contact_id
                                  and a.deleted_at is null)
                       or exists (select 1 from public.leads l
                                   where l.organization_id = contact_relations.organization_id and l.id = contact_relations.lead_id
                                     and l.deleted_at is null and l.converted_at is null))
                  and exists (select 1 from public.contacts b
                               where b.organization_id = contact_relations.organization_id and b.id = contact_relations.related_contact_id
                                 and b.deleted_at is null)
                  and (exists (select 1 from public.contacts c
                                where c.organization_id = contact_relations.organization_id
                                  and c.id in (contact_relations.contact_id, contact_relations.related_contact_id)
                                  and app.can_edit_record(c.organization_id, c.owner_id, c.team_id))
                       or exists (select 1 from public.leads l
                                   where l.organization_id = contact_relations.organization_id and l.id = contact_relations.lead_id
                                     and app.can_edit_record(l.organization_id, l.owner_id, l.team_id))));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_relations' and policyname = 'contact_relations_delete') then
    create policy contact_relations_delete on public.contact_relations for delete to authenticated
      using (app.can_write(organization_id)
             and (exists (select 1 from public.contacts a
                           where a.organization_id = contact_relations.organization_id and a.id = contact_relations.contact_id)
                  or exists (select 1 from public.leads l
                              where l.organization_id = contact_relations.organization_id and l.id = contact_relations.lead_id))
             and exists (select 1 from public.contacts b
                          where b.organization_id = contact_relations.organization_id and b.id = contact_relations.related_contact_id)
             and (exists (select 1 from public.contacts c
                           where c.organization_id = contact_relations.organization_id
                             and c.id in (contact_relations.contact_id, contact_relations.related_contact_id)
                             and c.deleted_at is null
                             and app.can_edit_record(c.organization_id, c.owner_id, c.team_id))
                  or exists (select 1 from public.leads l
                              where l.organization_id = contact_relations.organization_id and l.id = contact_relations.lead_id
                                and l.deleted_at is null
                                and app.can_edit_record(l.organization_id, l.owner_id, l.team_id))));
  end if;
end;
$$;

create or replace trigger contact_relations_touch before insert on public.contact_relations
  for each row execute function app.touch_row();

-- Every writer: the same type between the same two people once, in either direction. A person: an active type,
-- at most 50 relations per contact. Security invoker on purpose: current_user tells a person's write from the
-- server's; both contacts are readable to a person whose insert the policy lets through.
-- How many relations a contact or a lead has, all of them (the cap must not depend on what the writer reads).
-- Security definer; answers only a member of the organization.
create or replace function app.contact_relation_count(p_org uuid, p_contact uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then
           (select count(*)::integer from public.contact_relations r
             where r.organization_id = p_org and p_contact in (r.contact_id, r.lead_id, r.related_contact_id))
         else 0 end;
$$;
revoke all on function app.contact_relation_count(uuid, uuid) from public, anon;
grant execute on function app.contact_relation_count(uuid, uuid) to authenticated;

create or replace function app.check_contact_relation() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  -- the first side: a contact, or a lead (ids are unique across tables)
  v_first uuid := coalesce(new.contact_id, new.lead_id);
begin
  -- a person who may not write in this organization gets RLS's plain refusal right after, and learns nothing
  if current_user in ('authenticated', 'anon') and not app.can_write(new.organization_id) then
    return new;
  end if;
  -- one write at a time per pair, so the reverse check cannot race
  perform pg_advisory_xact_lock(hashtextextended(
    'contact_relations:' || new.organization_id::text || ':' || least(v_first, new.related_contact_id)::text
    || ':' || greatest(v_first, new.related_contact_id)::text, 0));
  if exists (select 1 from public.contact_relations r
              where r.organization_id = new.organization_id and r.type_id = new.type_id
                and ((coalesce(r.contact_id, r.lead_id) = v_first and r.related_contact_id = new.related_contact_id)
                     or (r.contact_id = new.related_contact_id and r.related_contact_id = v_first))) then
    raise exception 'this relation is already there' using errcode = 'P0001', hint = 'contact_relation:exists';
  end if;
  -- every writer: a lead is only the referrer of a referral
  if new.lead_id is not null
     and not exists (select 1 from public.contact_relation_types t
                      where t.organization_id = new.organization_id and t.id = new.type_id and t.key = 'referral') then
    raise exception 'a lead takes part only as a referrer' using errcode = 'P0001', hint = 'contact_relation:lead_type';
  end if;
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if not exists (select 1 from public.contact_relation_types t
                  where t.organization_id = new.organization_id and t.id = new.type_id and t.is_active) then
    raise exception 'this relation type is not on the list' using errcode = 'P0001', hint = 'contact_relation:type';
  end if;
  -- every relation of each side, also those with people this person cannot read
  if app.contact_relation_count(new.organization_id, v_first) >= 50
     or app.contact_relation_count(new.organization_id, new.related_contact_id) >= 50 then
    raise exception 'too many relations for one contact' using errcode = 'P0001', hint = 'contact_relation:max';
  end if;
  return new;
end;
$$;
revoke all on function app.check_contact_relation() from public, anon, authenticated;

create or replace trigger contact_relations_check before insert on public.contact_relations
  for each row execute function app.check_contact_relation();

-- Audit: a change of each of the two sides (a contact, or the referring lead), with that side's phrase and no name
create or replace function app.audit_contact_relation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.contact_relations;
  v_name text;
  v_reverse text;
  v_side record;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;
  if not app.org_exists(v_row.organization_id) then
    return null;
  end if;
  select t.name, coalesce(t.reverse_name, t.name) into v_name, v_reverse
    from public.contact_relation_types t
   where t.organization_id = v_row.organization_id and t.id = v_row.type_id;
  for v_side in
    select coalesce(v_row.contact_id, v_row.lead_id) as me,
           case when v_row.lead_id is null then 'contacts' else 'leads' end as entity,
           'related_contact_id' as other_key, v_row.related_contact_id as other, v_name as phrase
    union all
    select v_row.related_contact_id, 'contacts',
           case when v_row.lead_id is null then 'related_contact_id' else 'related_lead_id' end,
           coalesce(v_row.contact_id, v_row.lead_id), v_reverse
  loop
    -- gone together with the record (purge, merge): its own entry covers it
    continue when v_side.entity = 'contacts'
      and not exists (select 1 from public.contacts c where c.organization_id = v_row.organization_id and c.id = v_side.me);
    continue when v_side.entity = 'leads'
      and not exists (select 1 from public.leads l where l.organization_id = v_row.organization_id and l.id = v_side.me);
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (v_row.organization_id, auth.uid(), 'update', v_side.entity, v_side.me,
            jsonb_build_object(
              'relation', jsonb_build_object(
                'old', case when tg_op = 'DELETE' then to_jsonb(v_side.phrase) end,
                'new', case when tg_op = 'INSERT' then to_jsonb(v_side.phrase) end),
              v_side.other_key, v_side.other));
  end loop;
  return null;
end;
$$;
revoke all on function app.audit_contact_relation() from public, anon, authenticated;

create or replace trigger contact_relations_audit after insert or delete on public.contact_relations
  for each row execute function app.audit_contact_relation();

-- ----------------------------------------------------------------------------
-- Merge: the duplicate's relations stay with the kept contact
-- ----------------------------------------------------------------------------
-- merge_records() (security definer) writes a 'system' entry with metadata.merged_id on the kept record after
-- app.merge_move_links() and before the duplicate is removed. This trigger trusts any 'system' entry that carries
-- metadata.merged_id: only merge_records() writes one today, and clients cannot write 'system' entries (0072); a new
-- server writer of such entries must keep that meaning. The function still checks that both contacts exist.
create or replace function app.merge_contact_relations() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_keep uuid := new.contact_id;
  v_rel record;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if v_merged = v_keep
     or not exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = v_keep)
     or not exists (select 1 from public.contacts m where m.organization_id = new.organization_id and m.id = v_merged) then
    return null;
  end if;
  for v_rel in
    select case when r.contact_id = v_merged then v_keep else r.contact_id end as a,
           r.lead_id,
           case when r.related_contact_id = v_merged then v_keep else r.related_contact_id end as b,
           r.type_id
      from public.contact_relations r
     where r.organization_id = new.organization_id and v_merged in (r.contact_id, r.related_contact_id)
  loop
    -- not a relation of the kept contact with itself, and not one it already has (either direction)
    continue when v_rel.a = v_rel.b;
    continue when exists (select 1 from public.contact_relations x
                           where x.organization_id = new.organization_id and x.type_id = v_rel.type_id
                             and ((coalesce(x.contact_id, x.lead_id) = coalesce(v_rel.a, v_rel.lead_id) and x.related_contact_id = v_rel.b)
                                  or (x.contact_id = v_rel.b and x.related_contact_id = v_rel.a)));
    insert into public.contact_relations (organization_id, contact_id, lead_id, related_contact_id, type_id)
    values (new.organization_id, v_rel.a, v_rel.lead_id, v_rel.b, v_rel.type_id);
  end loop;
  return null;
end;
$$;
revoke all on function app.merge_contact_relations() from public, anon, authenticated;

create or replace trigger activities_merge_contact_relations after insert on public.activities
  for each row
  when (new.type = 'system' and new.contact_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_contact_relations();

-- Merge of two leads: the duplicate's referrals stay with the kept lead (the same "merged" entry, on the kept lead;
-- the duplicate's rows then go by cascade). Same trust as above.
create or replace function app.merge_lead_relations() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_keep uuid := new.lead_id;
  v_rel record;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if v_merged = v_keep
     or not exists (select 1 from public.leads l where l.organization_id = new.organization_id and l.id = v_keep)
     or not exists (select 1 from public.leads m where m.organization_id = new.organization_id and m.id = v_merged) then
    return null;
  end if;
  for v_rel in
    select r.related_contact_id as b, r.type_id
      from public.contact_relations r
     where r.organization_id = new.organization_id and r.lead_id = v_merged
  loop
    continue when exists (select 1 from public.contact_relations x
                           where x.organization_id = new.organization_id and x.type_id = v_rel.type_id
                             and x.lead_id = v_keep and x.related_contact_id = v_rel.b);
    insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id)
    values (new.organization_id, v_keep, v_rel.b, v_rel.type_id);
  end loop;
  return null;
end;
$$;
revoke all on function app.merge_lead_relations() from public, anon, authenticated;

create or replace trigger activities_merge_lead_relations after insert on public.activities
  for each row
  when (new.type = 'system' and new.lead_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_lead_relations();

-- ----------------------------------------------------------------------------
-- Conversion: a lead's referrals move to the new contact (like leads_convert_followers, when converted_at is first
-- set, also by a merge). The new contact takes the lead's place on the same side; a relation it would have with
-- itself, or one it already has (either direction), stays behind on the converted lead, where nothing counts it.
-- Not audited: the relation itself does not change.
-- ----------------------------------------------------------------------------
create or replace function app.convert_lead_relations() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_contact uuid := new.converted_contact_id;
  v_rel record;
begin
  if v_contact is null
     or not exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = v_contact) then
    return null;
  end if;
  for v_rel in
    select r.id, r.related_contact_id as b, r.type_id
      from public.contact_relations r
     where r.organization_id = new.organization_id and r.lead_id = new.id
     order by r.created_at, r.id
  loop
    continue when v_rel.b = v_contact;
    continue when exists (select 1 from public.contact_relations x
                           where x.organization_id = new.organization_id and x.type_id = v_rel.type_id
                             and ((x.contact_id = v_contact and x.related_contact_id = v_rel.b)
                                  or (x.contact_id = v_rel.b and x.related_contact_id = v_contact)));
    update public.contact_relations
       set contact_id = v_contact, lead_id = null
     where organization_id = new.organization_id and id = v_rel.id;
  end loop;
  return null;
end;
$$;
revoke all on function app.convert_lead_relations() from public, anon, authenticated;

create or replace trigger leads_convert_relations after update of converted_at on public.leads
  for each row
  when (old.converted_at is null and new.converted_at is not null)
  execute function app.convert_lead_relations();

-- ----------------------------------------------------------------------------
-- Sample data: a relation keeps a sample contact (body of contact_companies, 020070)
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
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id);
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
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id));
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null));
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id);
  end if;
end;
$$;
revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Undo of one's own import: a relation made after the import is work (body of contact_companies, 020070)
-- ----------------------------------------------------------------------------
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
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
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
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
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
    return exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The referrals report
-- ----------------------------------------------------------------------------
-- Security invoker on purpose (every report): RLS decides which relations, contacts and deals are counted.
create or replace function public.report_referrals(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable
set search_path = ''
as $$
  -- the referrer is a contact, or a lead that is not converted (a converted lead's referrals moved to its contact)
  with refs as (
    select coalesce(r.contact_id, r.lead_id) as referrer_id,
           case when r.lead_id is null then 'contact' else 'lead' end as referrer_kind,
           coalesce(a.full_name, l.full_name) as referrer_name,
           r.related_contact_id as referred_id, r.created_at
      from public.contact_relations r
      join public.contact_relation_types t on t.organization_id = r.organization_id and t.id = r.type_id and t.key = 'referral'
      join public.contacts b on b.organization_id = r.organization_id and b.id = r.related_contact_id and b.deleted_at is null
      left join public.contacts a on a.organization_id = r.organization_id and a.id = r.contact_id and a.deleted_at is null
      left join public.leads l on l.organization_id = r.organization_id and l.id = r.lead_id
                              and l.deleted_at is null and l.converted_at is null
     where r.organization_id = p_org and r.created_at >= p_from and r.created_at < p_to
       and (a.id is not null or l.id is not null)
  ), won as (
    -- a customer: a deal of the referred contact won after the referral was recorded (owner, 15 October 2026)
    select f.referrer_id, f.referred_id, d.id as deal_id, d.amount_agorot
      from refs f
      join public.deals d on d.organization_id = p_org and d.contact_id = f.referred_id
                         and d.deleted_at is null and d.status = 'won' and d.closed_at > f.created_at
  ), per as (
    select f.referrer_id, f.referrer_kind, f.referrer_name,
           count(distinct f.referred_id) as referred,
           (select count(distinct w.referred_id) from won w where w.referrer_id = f.referrer_id) as customers,
           (select coalesce(sum(w.amount_agorot), 0) from won w where w.referrer_id = f.referrer_id) as won_amount
      from refs f
     group by f.referrer_id, f.referrer_kind, f.referrer_name
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'referrals', (select count(*) from refs),
      'referrers', (select count(distinct referrer_id) from refs),
      'customers', (select count(distinct referred_id) from won),
      -- a deal once, also when two referrers brought the same person
      'won_amount', (select coalesce(sum(x.amount_agorot), 0) from (select distinct deal_id, amount_agorot from won) x)),
    'by_referrer', coalesce((
      select jsonb_agg(x order by x.referred desc, x.won_amount desc, x.name) from (
        select p.referrer_id, p.referrer_kind, p.referrer_name as name, p.referred, p.customers, p.won_amount
          from per p
         order by p.referred desc, p.won_amount desc, p.referrer_name
         limit 200) x), '[]'::jsonb));
$$;
revoke all on function public.report_referrals(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.report_referrals(uuid, timestamptz, timestamptz) to authenticated;

-- body of meeting_reports (020050); the report keys gain 'referrals'
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
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals') then
      raise exception 'invalid export' using errcode = '22023';
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
-- Default types: an organization starts with these and renames, hides or deletes them
-- ----------------------------------------------------------------------------
create or replace function app.seed_contact_relation_types(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.contact_relation_types (organization_id, name, reverse_name, key, position)
  select p_org, d.name, d.reverse_name, d.key, d.pos
    from (values ('בן/בת זוג של', null, 'spouse', 0),
                 ('בן/בת משפחה של', null, 'family', 1),
                 ('הורה של', 'ילד/ה של', 'parent', 2),
                 ('הפנה/תה את', 'הופנה/תה על ידי', 'referral', 3)) as d(name, reverse_name, key, pos)
   where not exists (select 1 from public.contact_relation_types t where t.organization_id = p_org)
   order by d.pos;
end;
$$;
revoke all on function app.seed_contact_relation_types(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_contact_relation_types() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_contact_relation_types(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_contact_relation_types() from public, anon, authenticated;

create or replace trigger organizations_seed_contact_relation_types after insert on public.organizations
  for each row execute function app.organizations_seed_contact_relation_types();

-- existing organizations whose list is empty: once (a re-run seeds only a list that is empty then)
select app.seed_contact_relation_types(o.id) from public.organizations o;

-- "בן/בת משפחה של" (owner, 15 October 2026) for a list that lacks it: added last, only where no type carries its key
-- or its name and the list has room; no other type is touched, so a renamed list keeps its names
insert into public.contact_relation_types (organization_id, name, reverse_name, key, position)
select o.id, 'בן/בת משפחה של', null, 'family',
       coalesce((select max(t.position) + 1 from public.contact_relation_types t where t.organization_id = o.id), 0)
  from public.organizations o
 where not exists (select 1 from public.contact_relation_types t
                    where t.organization_id = o.id and (t.key = 'family' or lower(t.name) = lower('בן/בת משפחה של')))
   and (select count(*) from public.contact_relation_types t where t.organization_id = o.id) < 20;

notify pgrst, 'reload schema';
