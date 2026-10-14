-- HEB-08, part of the absence-with-a-deputy change: see 20261006018700_absence_deputy.sql for the whole design.
-- Apply after it, in name order; every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- app.check_lead_responses: the body of lead_pass_on (0168); the pass-on picks through
-- app.next_lead_turn() and stamps / puts back the turn of whoever's turn it was (HEB-08).
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
  v_turn uuid;
  v_turn_was timestamptz;
  v_rounds integer;
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
            -- HEB-08: a round may also skip an absent member whose deputy is excluded, so the
            -- bound counts every member the rotation can visit (plus the excluded ones)
            select count(*)::integer into v_rounds
              from public.memberships m
             where m.organization_id = v_row.organization_id
               and m.status = 'active' and m.is_available and m.role <> 'viewer' and m.seat_type = 'full'
               and (v_lead.team_id is null or exists (
                 select 1 from public.team_members tm where tm.team_id = v_lead.team_id and tm.user_id = m.user_id));
            for i in 1 .. v_rounds + cardinality(v_excluded) + 1 loop
              -- HEB-08: the turn may be an absent member's, whose deputy gets the lead
              select t.owner_id, t.turn_user, t.turn_was into v_pick, v_turn, v_turn_was
                from app.next_lead_turn(v_row.organization_id, v_lead.team_id, now()) t;
              exit when v_pick is null;
              if not (v_pick = any (v_excluded)) then
                v_new := v_pick;
                exit;
              end if;
              -- an excluded member was picked: put them behind everyone stamped in this
              -- transaction (now() is constant here, review L2), and note the stamp
              v_stamp := clock_timestamp();
              -- (the stamp and the turn put back are those of whoever's turn it was: HEB-08)
              update public.memberships set last_lead_assigned_at = v_stamp
               where organization_id = v_row.organization_id and user_id = v_turn;
              v_tried := v_tried || jsonb_build_object(v_turn::text, jsonb_build_object(
                'old', coalesce(v_tried -> v_turn::text -> 'old', v_turns -> v_turn::text, to_jsonb(v_turn_was)), 'stamp', v_stamp));
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

-- ----------------------------------------------------------------------------
-- app.send_task_reminders: the body of lead_new_notifications (0128); the deputy of an
-- absent owner is reminded too (HEB-08).
-- ----------------------------------------------------------------------------
create or replace function app.send_task_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_more integer;
  v_due record;
begin
  -- SPD-01: a lead's call-back task without an owner whose reminder is due goes
  -- to the lead's owner first, when the lead has a usable one (fallback for a
  -- task that did not follow), and is then reminded like any task
  for v_due in
    select distinct t.organization_id, t.lead_id
      from public.tasks t
     where t.reminded_at is null and t.status = 'open' and t.deleted_at is null
       and t.owner_id is null and t.lead_id is not null
       and t.remind_at <= now() and t.remind_at > now() - interval '1 day'
       and exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = t.organization_id and ct.task_id = t.id)
       and app.org_writable(t.organization_id)
  loop
    perform app.intake_callback_task_follow(v_due.organization_id, v_due.lead_id);
  end loop;

  with due as (
    update public.tasks t
       set reminded_at = now()
     where t.reminded_at is null and t.status = 'open' and t.deleted_at is null
       and t.owner_id is not null
       and t.remind_at <= now() and t.remind_at > now() - interval '1 day'
       and app.org_writable(t.organization_id)
    returning t.organization_id, t.owner_id, t.id, t.title
  )
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select d.organization_id, d.owner_id, 'task_reminder', left('תזכורת: ' || d.title, 200), null, 'task', d.id
    from due d
  union all
  -- HEB-08: the deputy of an absent owner gets the same reminder (the task stays the owner's)
  select d.organization_id, x.deputy, 'task_reminder', left('תזכורת: ' || d.title, 200),
         left('בשביל ' || coalesce(nullif(btrim(p.full_name), ''), p.email, 'עמית שנעדר'), 500), 'task', d.id
    from due d
    cross join lateral (select app.deputy_for(d.organization_id, d.owner_id, now()) as deputy) x
    left join public.profiles p on p.id = d.owner_id
   where x.deputy is not null;
  get diagnostics v_count = row_count;

  -- SPD-01: a lead's call-back task nobody owns yet: whoever may take the lead,
  -- as 'lead_new' about the lead (the push carries "לקחתי"); once (reminded_at).
  -- (A lead with a usable owner had its task moved to that owner above.)
  with due as (
    update public.tasks t
       set reminded_at = now()
     where t.reminded_at is null and t.status = 'open' and t.deleted_at is null
       and t.owner_id is null and t.lead_id is not null
       and t.remind_at <= now() and t.remind_at > now() - interval '1 day'
       and exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = t.organization_id and ct.task_id = t.id)
       and app.org_writable(t.organization_id)
    returning t.organization_id, t.id, t.title, t.lead_id
  ), lead_due as (
    select d.organization_id, d.title, l.id as lead_id, l.team_id
      from due d
      join public.leads l on l.organization_id = d.organization_id and l.id = d.lead_id
     where l.deleted_at is null and l.converted_at is null
       and exists (select 1 from public.lead_statuses s
                    where s.organization_id = l.organization_id and s.id = l.status_id and s.kind = 'open')
  )
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select x.organization_id, r.user_id, 'lead_new', left('תזכורת: ' || x.title, 200), 'הליד עוד לא אצל אף אחד', 'lead', x.lead_id
    from lead_due x
    cross join lateral app.intake_unowned_recipients(x.organization_id, x.team_id) r;
  get diagnostics v_more = row_count;
  return v_count + v_more;
end;
$$;
revoke all on function app.send_task_reminders() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Mentions: the bodies of record_mentions (0099); a deputy may be mentioned on, and
-- mention from, a record they read as a deputy (HEB-08).
-- ----------------------------------------------------------------------------
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
       and (app.user_can_read_record(p_org, p_user, l.owner_id, l.team_id)
            or app.user_deputy_reads(p_org, p_user, 'lead', l.id));
    if entity_id is not null then return; end if;
  end if;
  if p_contact is not null then
    select 'contact', c.id, coalesce(c.full_name, 'איש קשר')
      into entity_type, entity_id, name
      from public.contacts c
     where c.organization_id = p_org and c.id = p_contact
       and (app.user_can_read_record(p_org, p_user, c.owner_id, c.team_id)
            or app.user_deputy_reads(p_org, p_user, 'contact', c.id));
    if entity_id is not null then return; end if;
  end if;
  if p_company is not null then
    select 'company', co.id, co.name
      into entity_type, entity_id, name
      from public.companies co
     where co.organization_id = p_org and co.id = p_company
       and (app.user_can_read_record(p_org, p_user, co.owner_id, co.team_id)
            or app.user_deputy_reads(p_org, p_user, 'company', co.id));
    if entity_id is not null then return; end if;
  end if;
  if p_deal is not null then
    select 'deal', d.id, d.name
      into entity_type, entity_id, name
      from public.deals d
     where d.organization_id = p_org and d.id = p_deal
       and (app.user_can_read_record(p_org, p_user, d.owner_id, d.team_id)
            or app.user_deputy_reads(p_org, p_user, 'deal', d.id));
  end if;
end;
$$;
revoke all on function app.mention_subject(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

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
  if not coalesce(v_found, false)
     or not (app.can_read_record(p_org, v_owner, v_team)
             or exists (select 1 from app.deputy_readable(p_kind) r where r.organization_id = p_org and r.id = p_id)) then
    return;
  end if;

  return query
    select m.user_id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'משתמש')::text
      from public.memberships m
      left join public.profiles p on p.id = m.user_id
     where m.organization_id = p_org and m.status = 'active'
       and m.user_id is distinct from auth.uid()
       and (app.user_can_read_record(p_org, m.user_id, v_owner, v_team)
            or app.user_deputy_reads(p_org, m.user_id, p_kind, p_id))
     order by 2, 1;
end;
$$;
revoke all on function public.mention_candidates(uuid, text, uuid) from public, anon;
grant execute on function public.mention_candidates(uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';
