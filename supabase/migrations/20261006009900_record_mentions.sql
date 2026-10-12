-- =============================================================================
-- Mentions in notes (REC-02)
-- =============================================================================
-- A person writes @colleague in what they log on a record (a note, a call, a
-- meeting, a message: the six logged types of app.contact_types()); the colleague
-- gets a notification of kind 'mention' (USR-06, migration 0068) that leads to
-- the record. Only someone who may see the record can be mentioned.
--
-- * Token. The body stays plain text (REC-04 Markdown). A mention is
--       @[Name](user:<uuid>)
--   with a name of 1 to 100 characters without "]" or a line break, and the
--   user's id. The name is what was shown when the mention was written; the
--   screen shows the user's current name. app.mention_ids() reads the ids with
--   the same grammar as src/features/mentions/token.ts; keep the two in step.
-- * Who may be mentioned: an active member of the organization who may read at
--   least one record the entry hangs on (app.user_can_read_activity_subject(),
--   which mirrors app.can_read_record() for a given user, not the caller; keep
--   the two in step). A mention added by an insert or an update that names anyone
--   else is refused (P0001, hint 'mention:forbidden'); at most 20 people per
--   entry ('mention:too_many'). Mentioning yourself is allowed and tells nobody.
--   Mentions that were already in the text before an edit are not checked again,
--   so an old note can still be edited after someone left.
-- * Only a person's own write counts: the triggers run when current_user is
--   'authenticated' (a browser insert or update with the user's session). An entry
--   a server function writes (for example the meeting entry of 0069, whose body is
--   the meeting's title) is neither checked nor announced.
-- * Who is told: every mentioned user who may read the record now, except the
--   person writing and the entry's author, once per entry. app.activity_mentions
--   remembers who was told (no grants, RLS on, rows go with the entry and with the
--   user), so an edit tells only people who were not told before.
-- * What the notification says: the kind of record and its name, and who wrote the
--   entry (its created_by). None of the entry's text: it may be edited, deleted or
--   made private later, and a push shows it on a locked phone.
-- * Private notes (GAP-05): nobody is told while a note is private, because only
--   its author and the owners/admins may read it, and a notification would show
--   others that it exists and what it says. The app refuses a mention in a
--   private note; if the note is made public later, its mentions are told then.
-- * public.mention_candidates(org, kind, id): the people the picker lists, for a
--   caller who sees the record: active members who may read it, without the caller.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Who was told about which entry
-- ----------------------------------------------------------------------------
create table if not exists app.activity_mentions (
  organization_id uuid not null,
  activity_id     uuid not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  notified_at     timestamptz not null default now(),
  primary key (activity_id, user_id),
  foreign key (organization_id, activity_id) references public.activities (organization_id, id) on delete cascade
);
create index if not exists activity_mentions_user_idx on app.activity_mentions (user_id);
alter table app.activity_mentions enable row level security;
revoke all on app.activity_mentions from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The ids in a text, in the token grammar above
-- ----------------------------------------------------------------------------
create or replace function app.mention_ids(p_body text) returns uuid[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct lower(m[1])::uuid), '{}'::uuid[])
    from regexp_matches(coalesce(p_body, ''),
           '@\[[^]\n]{1,100}\]\(user:([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\)',
           'g') as m;
$$;

-- ----------------------------------------------------------------------------
-- app.can_read_record() for a given user instead of the caller
-- ----------------------------------------------------------------------------
-- The same steps as app.can_read_record() (0013): an active membership, owners and
-- admins see everything, the record's owner sees it, visibility 'org', a member of
-- the record's team under visibility 'team', a manager of the team or of a parent
-- team. No support session and no two-step check: this asks about a person who is
-- not the one signed in.
create or replace function app.user_can_read_record(p_org uuid, p_user uuid, p_owner uuid, p_team uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role public.membership_role;
  v_visibility public.record_visibility;
begin
  if p_user is null then
    return false;
  end if;
  select m.role into v_role
    from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_role is null then
    return false;
  end if;
  if v_role in ('owner', 'admin') then
    return true;
  end if;
  if p_owner is not null and p_owner = p_user then
    return true;
  end if;

  select o.record_visibility into v_visibility from public.organizations o where o.id = p_org;
  if v_visibility = 'org' then
    return true;
  end if;
  if p_team is null then
    return false;
  end if;
  if v_visibility = 'team'
     and exists (select 1 from public.team_members tm where tm.team_id = p_team and tm.user_id = p_user) then
    return true;
  end if;
  if v_role = 'manager' and exists (
    with recursive chain as (
      select t.id, t.parent_team_id, 1 as depth
        from public.teams t where t.id = p_team
      union all
      select t.id, t.parent_team_id, c.depth + 1
        from public.teams t
        join chain c on t.id = c.parent_team_id
       where c.depth < 10
    )
    select 1 from chain c
      join public.team_members tm on tm.team_id = c.id
     where tm.user_id = p_user and tm.is_manager
  ) then
    return true;
  end if;
  return false;
end;
$$;

-- the first record of an entry the user may read (lead, contact, company, deal), or null
create or replace function app.mention_subject(
  p_org uuid, p_user uuid, p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid,
  out entity_type text, out entity_id uuid, out name text
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_lead is not null then
    select 'lead', l.id, coalesce(nullif(btrim(l.full_name), ''), nullif(btrim(l.company_name), ''), 'ליד')
      into entity_type, entity_id, name
      from public.leads l
     where l.organization_id = p_org and l.id = p_lead
       and app.user_can_read_record(p_org, p_user, l.owner_id, l.team_id);
    if entity_id is not null then return; end if;
  end if;
  if p_contact is not null then
    select 'contact', c.id, coalesce(c.full_name, 'איש קשר')
      into entity_type, entity_id, name
      from public.contacts c
     where c.organization_id = p_org and c.id = p_contact
       and app.user_can_read_record(p_org, p_user, c.owner_id, c.team_id);
    if entity_id is not null then return; end if;
  end if;
  if p_company is not null then
    select 'company', co.id, co.name
      into entity_type, entity_id, name
      from public.companies co
     where co.organization_id = p_org and co.id = p_company
       and app.user_can_read_record(p_org, p_user, co.owner_id, co.team_id);
    if entity_id is not null then return; end if;
  end if;
  if p_deal is not null then
    select 'deal', d.id, d.name
      into entity_type, entity_id, name
      from public.deals d
     where d.organization_id = p_org and d.id = p_deal
       and app.user_can_read_record(p_org, p_user, d.owner_id, d.team_id);
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The trigger: check new mentions, tell whoever was not told yet
-- ----------------------------------------------------------------------------
create or replace function app.notify_mentions() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_added uuid[];
  v_actor uuid;
  v_user uuid;
  v_subject record;
  v_author_name text;
  v_title text;
begin
  -- what a person logged (the triggers fire for browser writes only)
  if new.created_by is null or not (new.type = any (app.contact_types())) then
    return null;
  end if;
  v_ids := app.mention_ids(new.body);
  if cardinality(v_ids) = 0 then
    return null;
  end if;
  v_actor := coalesce(auth.uid(), new.created_by);

  v_added := v_ids;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(u), '{}'::uuid[]) into v_added
      from unnest(v_ids) as u
     where not (u = any (app.mention_ids(old.body)));
  end if;

  if cardinality(v_added) > 0 then
    if cardinality(v_ids) > 20 then
      raise exception 'too many mentions' using errcode = 'P0001', hint = 'mention:too_many';
    end if;
    foreach v_user in array v_added loop
      if v_user is distinct from v_actor then
        select * into v_subject
          from app.mention_subject(new.organization_id, v_user, new.lead_id, new.contact_id, new.company_id, new.deal_id);
        if v_subject.entity_id is null then
          raise exception 'this person cannot see the record' using errcode = 'P0001', hint = 'mention:forbidden';
        end if;
      end if;
    end loop;
  end if;

  -- GAP-05: nobody is told about a private note
  if new.is_private then
    return null;
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'משתמש') into v_author_name
    from public.profiles p where p.id = new.created_by;

  foreach v_user in array v_ids loop
    continue when v_user is not distinct from v_actor or v_user is not distinct from new.created_by;
    continue when exists (select 1 from app.activity_mentions am where am.activity_id = new.id and am.user_id = v_user);
    -- told only while they may still read the record (a mention older than this edit is not re-checked above)
    select * into v_subject
      from app.mention_subject(new.organization_id, v_user, new.lead_id, new.contact_id, new.company_id, new.deal_id);
    continue when v_subject.entity_id is null;

    insert into app.activity_mentions (organization_id, activity_id, user_id)
    values (new.organization_id, new.id, v_user)
    on conflict do nothing;
    v_title := case v_subject.entity_type
                 when 'lead' then 'הזכירו אתכם בליד: '
                 when 'contact' then 'הזכירו אתכם באיש קשר: '
                 when 'company' then 'הזכירו אתכם בחברה: '
                 else 'הזכירו אתכם בעסקה: ' end || v_subject.name;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (new.organization_id, v_user, 'mention', left(v_title, 200),
            left(coalesce(v_author_name, 'משתמש') || ' הזכיר/ה אתכם', 200),
            v_subject.entity_type, v_subject.entity_id);
  end loop;
  return null;
end;
$$;

-- a person's own write only: in a WHEN clause current_user is the caller of the
-- statement, so a server function (security definer) or a server role never gets here
create or replace trigger activities_notify_mentions_insert after insert on public.activities
  for each row
  when (current_user = 'authenticated')
  execute function app.notify_mentions();
create or replace trigger activities_notify_mentions_update after update of body, is_private on public.activities
  for each row
  when (current_user = 'authenticated'
        and (old.body is distinct from new.body or old.is_private is distinct from new.is_private))
  execute function app.notify_mentions();

-- ----------------------------------------------------------------------------
-- Who the picker lists
-- ----------------------------------------------------------------------------
create or replace function public.mention_candidates(p_org uuid, p_kind text, p_id uuid)
returns table (user_id uuid, name text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_team uuid;
  v_found boolean := false;
begin
  if not app.is_member(p_org) then
    return;
  end if;
  if p_kind = 'lead' then
    select l.owner_id, l.team_id, true into v_owner, v_team, v_found from public.leads l where l.organization_id = p_org and l.id = p_id;
  elsif p_kind = 'contact' then
    select c.owner_id, c.team_id, true into v_owner, v_team, v_found from public.contacts c where c.organization_id = p_org and c.id = p_id;
  elsif p_kind = 'company' then
    select co.owner_id, co.team_id, true into v_owner, v_team, v_found from public.companies co where co.organization_id = p_org and co.id = p_id;
  elsif p_kind = 'deal' then
    select d.owner_id, d.team_id, true into v_owner, v_team, v_found from public.deals d where d.organization_id = p_org and d.id = p_id;
  end if;
  -- nothing about a record the caller does not see
  if not coalesce(v_found, false) or not app.can_read_record(p_org, v_owner, v_team) then
    return;
  end if;

  return query
    select m.user_id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'משתמש')::text
      from public.memberships m
      left join public.profiles p on p.id = m.user_id
     where m.organization_id = p_org and m.status = 'active'
       and m.user_id is distinct from auth.uid()
       and app.user_can_read_record(p_org, m.user_id, v_owner, v_team)
     order by 2, 1;
end;
$$;

revoke all on function app.mention_ids(text) from public, anon, authenticated;
revoke all on function app.user_can_read_record(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function app.mention_subject(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function app.notify_mentions() from public, anon, authenticated;
revoke all on function public.mention_candidates(uuid, text, uuid) from public, anon;
grant execute on function public.mention_candidates(uuid, text, uuid) to authenticated;
