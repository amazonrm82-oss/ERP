-- =============================================================================
-- REC-03 follow-up: the owner follows their record; imports tell no follower
-- =============================================================================
-- Owner, 14 October 2026 (DECISIONS.md "מעקב אוטומטי של האחראי", "ייבוא שמעדכן רשומות קיימות"):
-- * The record's owner is a built-in follower: they get the 'follow' notices like a follower,
--   without a record_followers row, under the same rules (may read the record, never about their own
--   action, the new owner not about the owner change (they get 'assigned'), not someone the entry
--   mentions, nothing while the record is in the bin). A change of owner moves it to the new owner
--   (the old one is no longer told, unless they follow the record). An owner who also has a
--   follower row gets one notice. HEB-08: a deputy is not an owner; the absent owner is still told.
-- * A change an import makes tells no follower (like app.bulk_transfer). Imported inserts never reach
--   the change trigger (it fires on update), and imports never write activities, so entries are always
--   told. An import that updates existing records sends the header x-crm-import = its job id with each
--   update (src/features/imports/server.ts); app.import_write_running(org, kind) accepts it only for a
--   job of the signed-in caller, in that organization, of that record type, in update mode, running,
--   and created less than 2 hours ago (created_at is not client-writable), so the header cannot hide a
--   person's own edits beyond a genuine update import's window (review of b494c6a).
-- * import_jobs.status is one-way: once done, failed or undone it never goes back to running (trigger
--   import_jobs_status_one_way, any writer, hint import:status). The app only touches a running job
--   (running -> running) and the stale-import cron moves running -> failed.
-- Redefined from the bodies of record_followers (0104), their latest: app.notify_followers_of_change,
-- app.notify_followers_of_entry. Every statement is safe to run twice.

-- Is this request an update of the caller's own running update-mode import of this record type, made in
-- the last 2 hours (header x-crm-import = the job id)?
create or replace function app.import_write_running(p_org uuid, p_kind text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_job text;
begin
  if auth.uid() is null or p_org is null or p_kind is null then
    return false;
  end if;
  begin
    v_job := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-crm-import';
  exception when others then
    return false;
  end;
  if v_job is null or v_job !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  return exists (select 1 from public.import_jobs j
                  where j.organization_id = p_org and j.id = v_job::uuid
                    and j.created_by = auth.uid() and j.status = 'running'
                    and j.entity_type = p_kind and j.duplicate_mode = 'update'
                    and j.created_at > now() - interval '2 hours');
end;
$$;
revoke all on function app.import_write_running(uuid, text) from public, anon, authenticated;

-- import_jobs.status never goes back to running (a finished, failed or undone job stays so).
create or replace function app.import_jobs_status_one_way() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'running' and old.status <> 'running' then
    raise exception 'a finished import cannot run again' using errcode = 'P0001', hint = 'import:status';
  end if;
  return new;
end;
$$;
revoke all on function app.import_jobs_status_one_way() from public, anon, authenticated;

create or replace trigger import_jobs_status_one_way before update of status on public.import_jobs
  for each row execute function app.import_jobs_status_one_way();

-- app.notify_followers_of_change: the body of record_followers (0104).
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
  -- REC-03 (owner, 14 October 2026): a change an import makes tells no follower, like bulk_transfer
  if app.import_write_running(new.organization_id, v_kind) then
    return null;
  end if;
  if new.deleted_at is not null then
    return null;
  end if;
  -- most records have no followers: nothing else to look up (the owner is a built-in follower)
  if new.owner_id is null and not exists (
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

  -- the followers, and the record's (new) owner as a built-in follower; each person once
  for v_follower in
    select f.user_id
      from public.record_followers f
     where f.organization_id = new.organization_id
       and ((v_kind = 'lead' and f.lead_id = new.id) or (v_kind = 'contact' and f.contact_id = new.id)
            or (v_kind = 'company' and f.company_id = new.id) or (v_kind = 'deal' and f.deal_id = new.id))
    union
    select new.owner_id where new.owner_id is not null
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
revoke all on function app.notify_followers_of_change() from public, anon, authenticated;

-- app.notify_followers_of_entry: the body of record_followers (0104).
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

  -- each follower once, on the first record of the entry they follow and may read; the owner of
  -- each record of the entry is a built-in follower of it (REC-03, owner 14 October 2026)
  for v_row in
    select x.user_id, x.kind, x.record_id, x.rank
      from (
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
        union all
        select l.owner_id, 'lead', l.id, 1 from public.leads l
         where new.lead_id is not null and l.organization_id = new.organization_id and l.id = new.lead_id and l.owner_id is not null
        union all
        select c.owner_id, 'contact', c.id, 2 from public.contacts c
         where new.contact_id is not null and c.organization_id = new.organization_id and c.id = new.contact_id and c.owner_id is not null
        union all
        select co.owner_id, 'company', co.id, 3 from public.companies co
         where new.company_id is not null and co.organization_id = new.organization_id and co.id = new.company_id and co.owner_id is not null
        union all
        select d.owner_id, 'deal', d.id, 4 from public.deals d
         where new.deal_id is not null and d.organization_id = new.organization_id and d.id = new.deal_id and d.owner_id is not null
      ) x
     order by x.user_id, x.rank
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
revoke all on function app.notify_followers_of_entry() from public, anon, authenticated;
