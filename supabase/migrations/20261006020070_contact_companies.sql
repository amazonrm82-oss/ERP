-- =============================================================================
-- A contact linked to several companies, with a role at each and one primary (CON-05)
-- =============================================================================
-- public.contact_companies: one row per contact and company (organization_id, contact_id,
-- company_id, title = the person's role at that company, free text, is_primary).
--
-- The primary company stays contacts.company_id, and it is the one source of truth:
-- is_primary is derived from it by the server and no client writes it. So every reader of
-- company_id (lists, reports, CON-09 domain match, CON-08 billing fallback, merge, the
-- company hierarchy, conversion, imports, sample data) keeps working unchanged. One direction:
-- * a contact whose company_id is set or changed (any writer: the form, a conversion, an import,
--   a merge, the domain match) gets a link row to that company marked primary, and its other
--   rows lose the mark (trigger contacts_company_links, after insert or update of company_id);
--   a cleared company_id only takes the mark away, the link itself stays as a further company
--   (the app removes it when the person asked to remove it);
-- * a link row is primary exactly when its company is the contact's company_id at insert
--   (trigger contact_companies_primary); "make primary" is an update of contacts.company_id.
-- A person may not remove the primary link itself (hint contact_company:primary): the app first
-- clears or changes the contact's company. Rows of a purged contact or company go by cascade.
--
-- Rights follow the contact, like contact_channels (CON-01): a link is seen by whoever reads both
-- the contact and the company; added, changed (title only) and removed by whoever may edit the
-- contact and reads the company, in a writable organization, outside the recycle bin, and a new link
-- needs a live company the person reads. The update and delete policies carry the company check
-- themselves: an UPDATE or DELETE without a WHERE is filtered by its own policy only. At most 50 links per contact from the browser (hint
-- contact_company:max). A title is trimmed; empty = none; at most 80 characters (owner, 15 October 2026).
--
-- Audit: a link added, removed or retitled is written to the audit log as a change of the contact
-- (field company_link, "company (title)"), so it shows in the contact's history and a privacy erasure
-- of the contact covers it. The primary mark alone is not logged: contacts.company_id is.
--
-- Merge: until app.merge_move_links() (shared ground) moves these rows, the "merged" timeline entry
-- merge_records() writes (after the moves, before the duplicate is removed) carries them over:
-- a contact merge copies the duplicate's links onto the kept contact, a company merge copies the
-- links of the duplicate company onto the kept one; an existing link keeps its title, or takes the
-- copied one when it had none. The duplicate's own rows then go by cascade.
--
-- Sample data (USR-04): app.sample_untouched() (body of deal_lines, 0185, plus two lines) counts a link a person made
-- as real work: a further (not primary) link of a sample contact or company, or a primary link with a role. Sample data
-- itself makes only primary links without a role (by trigger), which mirror company_id and its snapshot.
-- Undo of one's own import (PRM-01): app.import_record_worked() (body of undo_own_import, 020010, plus two lines) counts a
-- link made or changed after the import as work on the contact or company.
--
-- Backfill: one primary row for every contact (in the bin too) that has a company_id. Additive
-- insert only, nothing is rewritten. Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.contact_companies (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id      uuid not null,
  company_id      uuid not null,
  title           text,
  is_primary      boolean not null default false,
  created_by      uuid references auth.users (id) on delete set null,
  updated_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint contact_companies_once unique (organization_id, contact_id, company_id),
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete cascade,
  constraint contact_companies_title check (title is null or char_length(title) between 1 and 80)
);

-- one primary company per contact
create unique index if not exists contact_companies_one_primary
  on public.contact_companies (organization_id, contact_id) where is_primary;
-- the company page lists its people
create index if not exists contact_companies_company_idx on public.contact_companies (organization_id, company_id);

alter table public.contact_companies enable row level security;
revoke all on public.contact_companies from anon, authenticated;
grant select, delete on public.contact_companies to authenticated;
grant insert (organization_id, contact_id, company_id, title) on public.contact_companies to authenticated;
grant update (title) on public.contact_companies to authenticated;

do $$
begin
  -- whoever reads the contact and the company (the sub-selects run under their policies)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_companies' and policyname = 'contact_companies_select') then
    create policy contact_companies_select on public.contact_companies for select to authenticated
      using (exists (select 1 from public.contacts c
                      where c.organization_id = contact_companies.organization_id and c.id = contact_companies.contact_id)
             and exists (select 1 from public.companies co
                          where co.organization_id = contact_companies.organization_id and co.id = contact_companies.company_id));
  end if;
  -- whoever may edit the contact, in a writable organization, outside the recycle bin, to a live company they read
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_companies' and policyname = 'contact_companies_insert') then
    create policy contact_companies_insert on public.contact_companies for insert to authenticated
      with check (app.can_write(organization_id)
                  and exists (select 1 from public.contacts c
                               where c.organization_id = contact_companies.organization_id and c.id = contact_companies.contact_id
                                 and c.deleted_at is null
                                 and app.can_edit_record(c.organization_id, c.owner_id, c.team_id))
                  and exists (select 1 from public.companies co
                               where co.organization_id = contact_companies.organization_id and co.id = contact_companies.company_id
                                 and co.deleted_at is null));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_companies' and policyname = 'contact_companies_update') then
    create policy contact_companies_update on public.contact_companies for update to authenticated
      using (app.can_write(organization_id)
             and exists (select 1 from public.contacts c
                          where c.organization_id = contact_companies.organization_id and c.id = contact_companies.contact_id
                            and c.deleted_at is null
                            and app.can_edit_record(c.organization_id, c.owner_id, c.team_id))
             and exists (select 1 from public.companies co
                          where co.organization_id = contact_companies.organization_id and co.id = contact_companies.company_id))
      with check (app.can_write(organization_id)
                  and exists (select 1 from public.contacts c
                               where c.organization_id = contact_companies.organization_id and c.id = contact_companies.contact_id
                                 and c.deleted_at is null
                                 and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_companies' and policyname = 'contact_companies_delete') then
    create policy contact_companies_delete on public.contact_companies for delete to authenticated
      using (app.can_write(organization_id)
             and exists (select 1 from public.contacts c
                          where c.organization_id = contact_companies.organization_id and c.id = contact_companies.contact_id
                            and c.deleted_at is null
                            and app.can_edit_record(c.organization_id, c.owner_id, c.team_id))
             and exists (select 1 from public.companies co
                          where co.organization_id = contact_companies.organization_id and co.id = contact_companies.company_id));
  end if;
end;
$$;

create or replace trigger contact_companies_touch before insert or update on public.contact_companies
  for each row execute function app.touch_row();

-- ----------------------------------------------------------------------------
-- The primary mark follows contacts.company_id
-- ----------------------------------------------------------------------------
-- A new row is primary exactly when its company is the contact's company. Security definer: the
-- contact is read whatever the writer may see (the insert policy has already decided the rest).
create or replace function app.contact_companies_primary() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.title := nullif(btrim(new.title), '');
  if tg_op = 'INSERT' then
    new.is_primary := exists (select 1 from public.contacts c
                               where c.organization_id = new.organization_id and c.id = new.contact_id
                                 and c.company_id = new.company_id);
  end if;
  return new;
end;
$$;
revoke all on function app.contact_companies_primary() from public, anon, authenticated;

create or replace trigger contact_companies_primary before insert or update of title on public.contact_companies
  for each row execute function app.contact_companies_primary();

-- A person's write: at most 50 links per contact; the primary link is not removed directly.
-- Security invoker on purpose: current_user tells a browser write from a server one (a cascade
-- runs as the table owner).
-- How many companies a contact is linked to, all of them (the cap must not depend on what the writer reads).
-- Security definer; answers only a member of the organization.
create or replace function app.contact_company_count(p_org uuid, p_contact uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then
           (select count(*)::integer from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_contact)
         else 0 end;
$$;
revoke all on function app.contact_company_count(uuid, uuid) from public, anon;
grant execute on function app.contact_company_count(uuid, uuid) to authenticated;

create or replace function app.check_contact_company() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.is_primary then
      raise exception 'the primary company is changed on the contact' using errcode = 'P0001', hint = 'contact_company:primary';
    end if;
    return old;
  end if;
  -- a person who may not write in this organization gets RLS's plain refusal right after, and learns nothing
  if not app.can_write(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per contact, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended(
    'contact_companies:' || new.organization_id::text || ':' || new.contact_id::text, 0));
  -- every link of the contact, also those to companies this person cannot read
  if app.contact_company_count(new.organization_id, new.contact_id) >= 50 then
    raise exception 'too many companies for one contact' using errcode = 'P0001', hint = 'contact_company:max';
  end if;
  return new;
end;
$$;
revoke all on function app.check_contact_company() from public, anon, authenticated;

create or replace trigger contact_companies_check before insert or delete on public.contact_companies
  for each row execute function app.check_contact_company();

-- The contact's company is its primary link; the other links lose the mark.
create or replace function app.contact_company_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.company_id is not distinct from old.company_id then
    return null;
  end if;
  update public.contact_companies cc
     set is_primary = false
   where cc.organization_id = new.organization_id and cc.contact_id = new.id and cc.is_primary
     and cc.company_id is distinct from new.company_id;
  if new.company_id is not null then
    insert into public.contact_companies (organization_id, contact_id, company_id, is_primary)
    values (new.organization_id, new.id, new.company_id, true)
    on conflict (organization_id, contact_id, company_id) do update set is_primary = true;
  end if;
  return null;
end;
$$;
revoke all on function app.contact_company_links() from public, anon, authenticated;

create or replace trigger contacts_company_links after insert or update of company_id on public.contacts
  for each row execute function app.contact_company_links();

-- ----------------------------------------------------------------------------
-- Audit: a change of the contact
-- ----------------------------------------------------------------------------
create or replace function app.audit_contact_company() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.contact_companies;
  v_name text;
  v_old text;
  v_new text;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;
  -- gone together with the organization, the contact or the company: their own entries cover it
  if not app.org_exists(v_row.organization_id)
     or not exists (select 1 from public.contacts c where c.organization_id = v_row.organization_id and c.id = v_row.contact_id) then
    return null;
  end if;
  select co.name into v_name from public.companies co
   where co.organization_id = v_row.organization_id and co.id = v_row.company_id;
  if not found then
    return null;
  end if;
  -- the primary link mirrors contacts.company_id, which is logged on its own
  if tg_op = 'INSERT' and new.is_primary then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.title is not distinct from old.title then
    return null;
  end if;
  if tg_op <> 'INSERT' then
    v_old := v_name || coalesce(' (' || old.title || ')', '');
  end if;
  if tg_op <> 'DELETE' then
    v_new := v_name || coalesce(' (' || new.title || ')', '');
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_row.organization_id, auth.uid(), 'update', 'contacts', v_row.contact_id,
          jsonb_build_object('company_link', jsonb_build_object('old', to_jsonb(v_old), 'new', to_jsonb(v_new))));
  return null;
end;
$$;
revoke all on function app.audit_contact_company() from public, anon, authenticated;

create or replace trigger contact_companies_audit after insert or update or delete on public.contact_companies
  for each row execute function app.audit_contact_company();

-- ----------------------------------------------------------------------------
-- Merge: the links stay with the kept record
-- ----------------------------------------------------------------------------
-- merge_records() (security definer) writes a 'system' entry with metadata.merged_id on the kept
-- record after app.merge_move_links() and before the duplicate is removed. This trigger trusts any
-- 'system' entry that carries metadata.merged_id: only merge_records() writes one today, and clients
-- cannot write 'system' entries (0072); a new server writer of such entries must keep that meaning.
-- The function still checks that both records exist in the entry's organization.
create or replace function app.merge_contact_companies() returns trigger
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
  if new.contact_id is not null then
    if v_merged = new.contact_id
       or not exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id)
       or not exists (select 1 from public.contacts m where m.organization_id = new.organization_id and m.id = v_merged) then
      return null;
    end if;
    insert into public.contact_companies (organization_id, contact_id, company_id, title)
    select cc.organization_id, new.contact_id, cc.company_id, cc.title
      from public.contact_companies cc
     where cc.organization_id = new.organization_id and cc.contact_id = v_merged
    on conflict (organization_id, contact_id, company_id)
      do update set title = coalesce(public.contact_companies.title, excluded.title);
  elsif new.company_id is not null then
    if v_merged = new.company_id
       or not exists (select 1 from public.companies c where c.organization_id = new.organization_id and c.id = new.company_id)
       or not exists (select 1 from public.companies m where m.organization_id = new.organization_id and m.id = v_merged) then
      return null;
    end if;
    insert into public.contact_companies (organization_id, contact_id, company_id, title)
    select cc.organization_id, cc.contact_id, new.company_id, cc.title
      from public.contact_companies cc
     where cc.organization_id = new.organization_id and cc.company_id = v_merged
    on conflict (organization_id, contact_id, company_id)
      do update set title = coalesce(public.contact_companies.title, excluded.title);
  end if;
  return null;
end;
$$;
revoke all on function app.merge_contact_companies() from public, anon, authenticated;

create or replace trigger activities_merge_contact_companies after insert on public.activities
  for each row
  when (new.type = 'system' and (new.contact_id is not null or new.company_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_contact_companies();

-- ----------------------------------------------------------------------------
-- Sample data: a link a person made keeps the sample record (body of deal_lines, 0185)
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
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id);
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
                         and (not cc.is_primary or cc.title is not null));
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
-- Undo of one's own import: a link made or changed after the import is work (body of undo_own_import, 020010)
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
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since);
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
-- Backfill: the company a contact already has is its primary link
-- ----------------------------------------------------------------------------
insert into public.contact_companies (organization_id, contact_id, company_id, is_primary)
select c.organization_id, c.id, c.company_id, true
  from public.contacts c
 where c.company_id is not null
on conflict (organization_id, contact_id, company_id) do nothing;

notify pgrst, 'reload schema';
