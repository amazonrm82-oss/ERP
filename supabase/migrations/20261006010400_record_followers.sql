-- =============================================================================
-- Followers of a record (REC-03)
-- =============================================================================
-- A user follows a lead, contact, company or deal and is told (notification
-- kind 'follow', USR-06, migration 0068) when
--   * a lead's status or a deal's stage changes,
--   * the record's owner changes,
--   * a person logs a new entry on it (a note, a call, a meeting, an email, a
--     WhatsApp message, an SMS: app.contact_types()).
--
-- * public.record_followers: one row per user and record (one of lead_id,
--   contact_id, company_id, deal_id). user_id comes from the session (column
--   default, no insert grant on it). A user follows only a record they may read,
--   and only for themselves; they stop following by deleting their own row.
--   Whoever may read the record sees who follows it (the count on the page); a
--   user always sees their own rows, so they can stop following a record they no
--   longer see (nobody is told about it meanwhile). No updates. Following is explicit: nobody follows a record automatically.
-- * The rows go with the record (purge), with the membership (a person removed
--   from the organization) and with the organization: composite foreign keys,
--   on delete cascade.
-- * Who is told: every follower who may read the record now
--   (app.user_can_read_record(), migration 0099), except the person who made the
--   change. A follower who becomes the new owner is not told about the owner
--   change (they get 'assigned' from app.notify_assignment()). A follower whom
--   the new entry mentions is not told twice (they get 'mention', REC-02).
-- * What is not announced:
--   - a handover of someone's records (app.bulk_transfer on, migration 0024): an
--     admin's clean-up when someone leaves, not news about the record;
--   - a record in the recycle bin;
--   - an entry a server function writes (a status-change entry, the meeting entry
--     of 0069): the entry triggers fire for a person's own browser write only
--     (current_user = 'authenticated', as the mention triggers of 0099);
--   - a private note (GAP-05): only its author and owners/admins may read it,
--     and a notification would show others that it exists. A note made public
--     later is not a new entry and is not announced.
--   Changes an automation makes are announced (without a name for who did it):
--   a follower wants to know the stage moved, whoever moved it. Imported rows are
--   new records, which nobody follows yet; an import that updates an existing
--   record is a change like a person's and is announced.
-- * What a notification says: the kind of record and its name; who did what; the
--   new status, stage or owner. Never any text of an entry: it may be edited,
--   deleted or made private later, and a push shows it on a locked phone.
-- Every statement is safe to run twice.

create table if not exists public.record_followers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null default auth.uid(),
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint record_followers_once unique nulls not distinct (user_id, lead_id, contact_id, company_id, deal_id),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade,
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete cascade,
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete cascade,
  constraint record_followers_one_subject check (num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1)
);
create index if not exists record_followers_lead_idx on public.record_followers (organization_id, lead_id) where lead_id is not null;
create index if not exists record_followers_contact_idx on public.record_followers (organization_id, contact_id) where contact_id is not null;
create index if not exists record_followers_company_idx on public.record_followers (organization_id, company_id) where company_id is not null;
create index if not exists record_followers_deal_idx on public.record_followers (organization_id, deal_id) where deal_id is not null;

alter table public.record_followers enable row level security;
revoke all on public.record_followers from anon, authenticated;
grant select, delete on public.record_followers to authenticated;
grant insert (organization_id, lead_id, contact_id, company_id, deal_id) on public.record_followers to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_followers' and policyname = 'record_followers_select') then
    create policy record_followers_select on public.record_followers for select to authenticated
      using (app.is_member(organization_id)
             and (user_id = (select auth.uid()) or app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_followers' and policyname = 'record_followers_insert') then
    create policy record_followers_insert on public.record_followers for insert to authenticated
      with check (user_id = (select auth.uid()) and app.is_member(organization_id)
                  and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_followers' and policyname = 'record_followers_delete') then
    create policy record_followers_delete on public.record_followers for delete to authenticated
      using (user_id = (select auth.uid()) and app.is_member(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
-- a person's display name (null for null)
create or replace function app.follow_person_name(p_user uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'משתמש')
    from public.profiles p where p.id = p_user;
$$;

-- the record's name, owner, team and whether it is in the recycle bin
create or replace function app.follow_record(
  p_org uuid, p_kind text, p_id uuid,
  out name text, out owner_id uuid, out team_id uuid, out in_trash boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_kind = 'lead' then
    select coalesce(nullif(btrim(l.full_name), ''), nullif(btrim(l.company_name), ''), 'ליד'), l.owner_id, l.team_id, l.deleted_at is not null
      into name, owner_id, team_id, in_trash
      from public.leads l where l.organization_id = p_org and l.id = p_id;
  elsif p_kind = 'contact' then
    select coalesce(c.full_name, 'איש קשר'), c.owner_id, c.team_id, c.deleted_at is not null
      into name, owner_id, team_id, in_trash
      from public.contacts c where c.organization_id = p_org and c.id = p_id;
  elsif p_kind = 'company' then
    select co.name, co.owner_id, co.team_id, co.deleted_at is not null
      into name, owner_id, team_id, in_trash
      from public.companies co where co.organization_id = p_org and co.id = p_id;
  elsif p_kind = 'deal' then
    select d.name, d.owner_id, d.team_id, d.deleted_at is not null
      into name, owner_id, team_id, in_trash
      from public.deals d where d.organization_id = p_org and d.id = p_id;
  end if;
end;
$$;

create or replace function app.follow_title(p_kind text, p_name text) returns text
language sql immutable
set search_path = ''
as $$
  select left(case p_kind
                when 'lead' then 'עדכון בליד שבמעקב: '
                when 'contact' then 'עדכון באיש קשר שבמעקב: '
                when 'company' then 'עדכון בחברה שבמעקב: '
                else 'עדכון בעסקה שבמעקב: ' end || coalesce(p_name, ''), 200);
$$;

-- ----------------------------------------------------------------------------
-- A record's status, stage or owner changed
-- ----------------------------------------------------------------------------
-- One function for the four tables; columns are read through jsonb, so a table
-- without status_id or stage_id never raises (the PL/pgSQL gotcha in CLAUDE.md).
create or replace function app.notify_followers_of_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text := tg_argv[0];
  v_new jsonb;
  v_old jsonb;
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_stage_text text;
  v_owner_text text;
  v_owner_changed boolean;
  v_new_owner uuid := new.owner_id;
  v_title text;
  v_body text;
  v_follower uuid;
begin
  if current_setting('app.bulk_transfer', true) = 'on' then
    return null;
  end if;
  if new.deleted_at is not null then
    return null;
  end if;
  -- most records have no followers: nothing else to look up
  if not exists (
    select 1 from public.record_followers f
     where f.organization_id = new.organization_id
       and ((v_kind = 'lead' and f.lead_id = new.id) or (v_kind = 'contact' and f.contact_id = new.id)
            or (v_kind = 'company' and f.company_id = new.id) or (v_kind = 'deal' and f.deal_id = new.id))
  ) then
    return null;
  end if;
  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  v_actor_name := app.follow_person_name(v_actor);

  if v_kind = 'lead' and (v_new ->> 'status_id') is distinct from (v_old ->> 'status_id') then
    select coalesce(v_actor_name || ' שינה/תה את הסטטוס ל: ', 'הסטטוס השתנה ל: ') || s.name
      into v_stage_text
      from public.lead_statuses s
     where s.organization_id = new.organization_id and s.id = (v_new ->> 'status_id')::uuid;
  elsif v_kind = 'deal' and (v_new ->> 'stage_id') is distinct from (v_old ->> 'stage_id') then
    select coalesce(v_actor_name || ' העביר/ה לשלב: ', 'השלב השתנה ל: ') || s.name
      into v_stage_text
      from public.stages s
     where s.organization_id = new.organization_id and s.id = (v_new ->> 'stage_id')::uuid;
  end if;

  v_owner_changed := new.owner_id is distinct from old.owner_id;
  if v_owner_changed then
    v_owner_text := coalesce(v_actor_name || ' שינה/תה את האחראי ל: ', 'האחראי השתנה ל: ')
                    || coalesce(app.follow_person_name(v_new_owner), 'ללא אחראי');
  end if;

  if v_stage_text is null and v_owner_text is null then
    return null;
  end if;
  v_title := app.follow_title(v_kind, (app.follow_record(new.organization_id, v_kind, new.id)).name);

  for v_follower in
    select f.user_id
      from public.record_followers f
     where f.organization_id = new.organization_id
       and ((v_kind = 'lead' and f.lead_id = new.id) or (v_kind = 'contact' and f.contact_id = new.id)
            or (v_kind = 'company' and f.company_id = new.id) or (v_kind = 'deal' and f.deal_id = new.id))
  loop
    continue when v_follower is not distinct from v_actor;
    continue when not app.user_can_read_record(new.organization_id, v_follower, new.owner_id, new.team_id);
    -- the new owner hears about it as 'assigned'
    if v_owner_changed and v_follower is not distinct from v_new_owner then
      v_body := v_stage_text;
    else
      v_body := concat_ws(' · ', v_stage_text, v_owner_text);
    end if;
    continue when v_body is null;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (new.organization_id, v_follower, 'follow', v_title, left(v_body, 200), v_kind, new.id);
  end loop;
  return null;
end;
$$;

create or replace trigger leads_notify_followers after update of status_id, owner_id on public.leads
  for each row
  when (old.status_id is distinct from new.status_id or old.owner_id is distinct from new.owner_id)
  execute function app.notify_followers_of_change('lead');
create or replace trigger deals_notify_followers after update of stage_id, owner_id on public.deals
  for each row
  when (old.stage_id is distinct from new.stage_id or old.owner_id is distinct from new.owner_id)
  execute function app.notify_followers_of_change('deal');
create or replace trigger contacts_notify_followers after update of owner_id on public.contacts
  for each row
  when (old.owner_id is distinct from new.owner_id)
  execute function app.notify_followers_of_change('contact');
create or replace trigger companies_notify_followers after update of owner_id on public.companies
  for each row
  when (old.owner_id is distinct from new.owner_id)
  execute function app.notify_followers_of_change('company');

-- ----------------------------------------------------------------------------
-- A person logged a new entry on the record
-- ----------------------------------------------------------------------------
create or replace function app.notify_followers_of_entry() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_author_name text;
  v_body text;
  v_mentioned uuid[];
  v_last uuid;
  v_record record;
  v_row record;
begin
  -- what a person logged, in the open (GAP-05: a private note tells nobody)
  if new.created_by is null or new.is_private or not (new.type = any (app.contact_types())) then
    return null;
  end if;
  -- most records have no followers: nothing else to look up
  if not exists (
    select 1 from public.record_followers f
     where f.organization_id = new.organization_id
       and (f.lead_id = new.lead_id or f.contact_id = new.contact_id
            or f.company_id = new.company_id or f.deal_id = new.deal_id)
  ) then
    return null;
  end if;
  v_actor := coalesce(auth.uid(), new.created_by);
  v_mentioned := app.mention_ids(new.body);
  v_author_name := coalesce(app.follow_person_name(new.created_by), 'משתמש');
  v_body := v_author_name || case new.type
              when 'note' then ' הוסיף/ה הערה'
              when 'call' then ' תיעד/ה שיחה'
              when 'meeting' then ' תיעד/ה פגישה'
              when 'email' then ' תיעד/ה אימייל'
              when 'whatsapp' then ' תיעד/ה הודעת WhatsApp'
              else ' תיעד/ה SMS' end;

  -- each follower once, on the first record of the entry they follow and may read
  for v_row in
    select f.user_id,
           case when f.lead_id is not null then 'lead' when f.contact_id is not null then 'contact'
                when f.company_id is not null then 'company' else 'deal' end as kind,
           coalesce(f.lead_id, f.contact_id, f.company_id, f.deal_id) as record_id,
           case when f.lead_id is not null then 1 when f.contact_id is not null then 2
                when f.company_id is not null then 3 else 4 end as rank
      from public.record_followers f
     where f.organization_id = new.organization_id
       and (f.lead_id = new.lead_id or f.contact_id = new.contact_id
            or f.company_id = new.company_id or f.deal_id = new.deal_id)
     order by f.user_id, rank
  loop
    continue when v_row.user_id is not distinct from v_last;
    continue when v_row.user_id is not distinct from v_actor or v_row.user_id is not distinct from new.created_by;
    -- a mentioned follower is told by the mention
    continue when v_row.user_id = any (v_mentioned);
    select * into v_record from app.follow_record(new.organization_id, v_row.kind, v_row.record_id);
    continue when v_record.in_trash is distinct from false;
    continue when not app.user_can_read_record(new.organization_id, v_row.user_id, v_record.owner_id, v_record.team_id);
    v_last := v_row.user_id;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (new.organization_id, v_row.user_id, 'follow', app.follow_title(v_row.kind, v_record.name),
            left(v_body, 200), v_row.kind, v_row.record_id);
  end loop;
  return null;
end;
$$;

-- a person's own write only: in a WHEN clause current_user is the caller of the
-- statement, so a server function (security definer) or a server role never gets here
create or replace trigger activities_notify_followers after insert on public.activities
  for each row
  when (current_user = 'authenticated')
  execute function app.notify_followers_of_entry();

revoke all on function app.follow_person_name(uuid) from public, anon, authenticated;
revoke all on function app.follow_record(uuid, text, uuid) from public, anon, authenticated;
revoke all on function app.follow_title(text, text) from public, anon, authenticated;
revoke all on function app.notify_followers_of_change() from public, anon, authenticated;
revoke all on function app.notify_followers_of_entry() from public, anon, authenticated;
