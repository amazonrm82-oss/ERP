-- =============================================================================
-- A lead nobody answered in time goes to the next rep (SPD-03)
-- =============================================================================
-- Builds on CAP-10 (migration response_target):
-- * lead_response_settings.breach_action also takes 'pass_on', and
--   max_passes (1..5, default 2) says how many times one lead may be passed on.
--   Choosing 'pass_on' needs the plan flag auto_reassign (basic and up, owner's
--   pricing of 13 October 2026; hint feature:auto_reassign). If the plan later
--   loses the flag, the job only notifies.
-- * app.check_lead_responses() (redefined; everything else as in CAP-10): when
--   the action is 'pass_on', the flag is on, nobody pressed "לקחתי" on the lead
--   (leads.taken_at, SPD-01) and it was passed fewer than max_passes times, the
--   lead goes to app.next_lead_owner(org, lead's team) (CAP-09: in hours, not
--   on leave, available, a full seat), never back to its current owner or to
--   someone it was already taken from. Those people are skipped and their turn
--   in the rotation is given back (last_lead_assigned_at restored), so only the
--   new owner's turn moves. Then:
--     - the new owner gets notify_assignment's normal 'assigned' notification;
--     - the previous owner and the managers (app.response_managers, as in
--       CAP-10, without the previous and the new owner) get 'response_overdue';
--     - the lead's timeline gets one 'system' entry (metadata.kind =
--       'response_pass'); it is not contact and notifies nobody;
--     - the new owner's clock starts (trigger leads_response_owner);
--     - the lead's open call-back task (SPD-05, marked in app.intake_callback_tasks)
--       that belonged to the previous owner moves to the new owner silently, as
--       on "לקחתי" (app.intake_follow; owner's rule for CAP-09/SPD-01).
--   Nobody to pass to, a taken lead, the passes used up, or no flag: the
--   managers are notified once, as with 'notify'. A contacted, closed or
--   converted lead is never moved; a read-only or suspended organization is
--   left alone; a lead locked by a handover (transfer_records) or a "לקחתי" at
--   that moment is looked at a minute later.
-- * app.lead_response_checks gets passes and passed_from.
-- * The plan check starts with the quota triggers' guard (review H1): a writer
--   with a session who is not an owner or admin of the business gets RLS's plain
--   42501, never the plan hint.
-- Every statement is safe to run twice.

alter table public.lead_response_settings add column if not exists max_passes integer not null default 2;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.lead_response_settings'::regclass and conname = 'lead_response_settings_passes_range') then
    alter table public.lead_response_settings add constraint lead_response_settings_passes_range check (max_passes between 1 and 5);
  end if;
end;
$$;

alter table public.lead_response_settings
  drop constraint if exists lead_response_settings_action_check,
  add constraint lead_response_settings_action_check check (breach_action in ('notify', 'pass_on', 'none'));

grant insert (max_passes), update (max_passes) on public.lead_response_settings to authenticated;

comment on column public.lead_response_settings.max_passes is
  'SPD-03: how many times one lead may be passed on to the next rep before the managers are only notified (1..5).';

-- 'pass_on' needs the plan flag; checked when it is chosen, not when other
-- columns change, so a business whose plan lost the flag can still edit.
create or replace function app.lead_response_settings_feature() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- RLS refuses this writer right after; answer nothing about the plan (review H1,
  -- the guard of the quota triggers)
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.breach_action = 'pass_on'
     and (tg_op = 'INSERT' or old.breach_action is distinct from 'pass_on')
     and not app.org_has_feature(new.organization_id, 'auto_reassign') then
    raise exception 'passing leads on is not in the plan' using errcode = 'P0001', hint = 'feature:auto_reassign';
  end if;
  return new;
end;
$$;
revoke all on function app.lead_response_settings_feature() from public, anon, authenticated;

create or replace trigger lead_response_settings_feature before insert or update of breach_action on public.lead_response_settings
  for each row execute function app.lead_response_settings_feature();

alter table app.lead_response_checks add column if not exists passes integer not null default 0;
alter table app.lead_response_checks add column if not exists passed_from uuid[] not null default '{}';

-- ----------------------------------------------------------------------------
-- The job, with passing on
-- ----------------------------------------------------------------------------
create or replace function app.check_lead_responses() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_lead record;
  v_target integer;
  v_action text;
  v_max integer;
  v_due timestamptz;
  v_owner_name text;
  v_new_name text;
  v_excluded uuid[];
  v_turns jsonb;
  v_tried jsonb;
  v_stamp timestamptz;
  v_pick uuid;
  v_new uuid;
  v_done integer := 0;
  i integer;
begin
  for v_row in
    select d.lead_id, d.organization_id, d.window_start, d.created_at, d.passes, d.passed_from
      from (
        select c.lead_id, c.organization_id, c.window_start, c.created_at, c.next_check_at, c.passes, c.passed_from,
               row_number() over (partition by c.organization_id order by c.next_check_at, c.created_at) as n
          from app.lead_response_checks c
         where c.resolved_at is null and c.next_check_at <= now()
      ) d
     where d.n <= app.response_check_per_org()
     order by d.next_check_at, d.created_at
     limit app.response_check_limit()
  loop
    begin
      begin
        select l.owner_id, l.team_id, l.deleted_at, l.converted_at, l.taken_at,
               coalesce(nullif(btrim(l.full_name), ''), nullif(btrim(l.company_name), ''), l.phone, l.email, 'ליד ללא שם') as name,
               s.kind as status_kind
          into v_lead
          from public.leads l
          join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
         where l.organization_id = v_row.organization_id and l.id = v_row.lead_id
           for update of l nowait;
      exception when lock_not_available then
        -- a handover or a "לקחתי" holds the lead: look again in a minute (never waits)
        perform app.response_check_later(v_row.lead_id, interval '1 minute');
        continue;
      end;

      if not found or v_lead.deleted_at is not null or v_lead.converted_at is not null or v_lead.status_kind <> 'open' then
        update app.lead_response_checks set resolved_at = now(), outcome = 'closed' where lead_id = v_row.lead_id;
      elsif exists (
        select 1 from public.activities a
         where a.organization_id = v_row.organization_id and a.lead_id = v_row.lead_id
           and a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private) then
        update app.lead_response_checks set resolved_at = now(), outcome = 'contacted' where lead_id = v_row.lead_id;
      elsif v_row.created_at < now() - interval '14 days' then
        update app.lead_response_checks set resolved_at = now(), outcome = 'expired' where lead_id = v_row.lead_id;
      elsif not app.org_writable(v_row.organization_id) then
        update app.lead_response_checks set next_check_at = now() + interval '15 minutes' where lead_id = v_row.lead_id;
      elsif v_lead.owner_id is null then
        -- nobody owns it yet (SPD-01, CAP-09): the owner trigger wakes the row
        update app.lead_response_checks set next_check_at = now() + interval '1 day' where lead_id = v_row.lead_id;
      else
        v_target := app.response_target_minutes(v_row.organization_id);
        v_due := app.response_deadline(v_row.organization_id, v_row.window_start, v_target);
        if v_due is null then
          update app.lead_response_checks set next_check_at = now() + interval '1 day' where lead_id = v_row.lead_id;
        elsif v_due > now() then
          -- at most 15 minutes ahead, so a changed target or calendar is seen soon
          update app.lead_response_checks set next_check_at = least(v_due, now() + interval '15 minutes') where lead_id = v_row.lead_id;
        else
          select coalesce(s.breach_action, 'notify'), coalesce(s.max_passes, 2) into v_action, v_max
            from (select 1) one
            left join public.lead_response_settings s on s.organization_id = v_row.organization_id;
          select nullif(btrim(p.full_name), '') into v_owner_name from public.profiles p where p.id = v_lead.owner_id;

          -- SPD-03: pass it on, when allowed and someone qualifies
          v_new := null;
          if v_action = 'pass_on' and v_lead.taken_at is null and v_row.passes < v_max
             and app.org_has_feature(v_row.organization_id, 'auto_reassign') then
            v_excluded := array_append(v_row.passed_from, v_lead.owner_id);
            select coalesce(jsonb_object_agg(m.user_id::text, m.last_lead_assigned_at), '{}'::jsonb) into v_turns
              from public.memberships m
             where m.organization_id = v_row.organization_id and m.user_id = any (v_excluded);
            v_tried := '{}'::jsonb;
            for i in 1 .. cardinality(v_excluded) + 1 loop
              v_pick := app.next_lead_owner(v_row.organization_id, v_lead.team_id);
              exit when v_pick is null;
              if not (v_pick = any (v_excluded)) then
                v_new := v_pick;
                exit;
              end if;
              -- an excluded member was picked: put them behind everyone stamped in this
              -- transaction (now() is constant here, review L2), and note the stamp
              v_stamp := clock_timestamp();
              update public.memberships set last_lead_assigned_at = v_stamp
               where organization_id = v_row.organization_id and user_id = v_pick;
              v_tried := v_tried || jsonb_build_object(v_pick::text, jsonb_build_object(
                'old', coalesce(v_tried -> v_pick::text -> 'old', v_turns -> v_pick::text), 'stamp', v_stamp));
            end loop;
            -- whoever this loop picked and skipped keeps their place in the rotation, unless
            -- their turn changed since (review L1: only where our own stamp is still there)
            update public.memberships m
               set last_lead_assigned_at = (v_tried -> m.user_id::text ->> 'old')::timestamptz
             where m.organization_id = v_row.organization_id
               and v_tried ? m.user_id::text
               and m.last_lead_assigned_at = (v_tried -> m.user_id::text ->> 'stamp')::timestamptz;
          end if;

          if v_action = 'none' then
            update app.lead_response_checks set resolved_at = now(), outcome = 'no_action' where lead_id = v_row.lead_id;
          elsif v_new is not null then
            -- notify_assignment tells the new owner ('assigned'); leads_response_owner starts their clock
            update public.leads set owner_id = v_new
             where organization_id = v_row.organization_id and id = v_row.lead_id and owner_id = v_lead.owner_id;
            -- the lead's open SPD-05 call task follows it, as on "לקחתי" (marked in
            -- app.intake_callback_tasks; app.intake_follow keeps notify_assignment quiet)
            perform set_config('app.intake_follow', 'on', true);
            update public.tasks t
               set owner_id = v_new
             where t.organization_id = v_row.organization_id and t.lead_id = v_row.lead_id
               and t.owner_id = v_lead.owner_id and t.status = 'open' and t.deleted_at is null
               and exists (select 1 from app.intake_callback_tasks ct
                            where ct.organization_id = v_row.organization_id and ct.task_id = t.id);
            perform set_config('app.intake_follow', '', true);
            select nullif(btrim(p.full_name), '') into v_new_name from public.profiles p where p.id = v_new;
            insert into public.activities (organization_id, type, lead_id, body, metadata)
            values (v_row.organization_id, 'system', v_row.lead_id,
                    left('הליד הועבר' || coalesce(' מ' || v_owner_name, '') || coalesce(' ל' || v_new_name, '')
                         || ' כי לא נוצר קשר בתוך ' || v_target || ' דקות', 500),
                    jsonb_build_object('kind', 'response_pass', 'from_user_id', v_lead.owner_id, 'to_user_id', v_new,
                                       'target_minutes', v_target, 'pass', v_row.passes + 1));
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            values (v_row.organization_id, v_lead.owner_id, 'response_overdue',
                    'ליד הועבר לנציג אחר',
                    left(v_lead.name || ' · לא נוצר קשר בתוך ' || v_target || ' דקות', 500),
                    'lead', v_row.lead_id);
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            select v_row.organization_id, r.user_id, 'response_overdue',
                   left('ליד לא נענה בתוך ' || v_target || ' דקות והועבר', 200),
                   left(v_lead.name || coalesce(' · מ' || v_owner_name, '') || coalesce(' ל' || v_new_name, ''), 500),
                   'lead', v_row.lead_id
              from app.response_managers(v_row.organization_id, v_lead.team_id, v_new) r
             -- the new owner already got 'assigned' (review L7)
             where r.user_id <> v_lead.owner_id and r.user_id <> v_new;
            update app.lead_response_checks
               set passes = passes + 1,
                   passed_from = v_excluded,
                   next_check_at = now() + interval '1 minute'
             where lead_id = v_row.lead_id;
            v_done := v_done + 1;
          else
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            select v_row.organization_id, r.user_id, 'response_overdue',
                   left('ליד מחכה למענה יותר מ-' || v_target || ' דקות', 200),
                   left(v_lead.name || coalesce(' · באחריות ' || v_owner_name, ''), 500),
                   'lead', v_row.lead_id
              from app.response_managers(v_row.organization_id, v_lead.team_id, v_lead.owner_id) r;
            update app.lead_response_checks set resolved_at = now(), notified_at = now(), outcome = 'notified'
             where lead_id = v_row.lead_id;
            v_done := v_done + 1;
          end if;
        end if;
      end if;
    exception when others then
      -- this row's changes are rolled back; look at it again later (never waits), go on with the others
      begin
        perform app.response_check_later(v_row.lead_id, interval '10 minutes');
      exception when others then
        null;
      end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.check_lead_responses() from public, anon, authenticated;
