-- =============================================================================
-- RVW-25 / HEB-08: an employee who picks their own deputy tells their manager
-- =============================================================================
-- Owner, 19 October 2026, answer (ב): the employee still picks; the manager of their team (or the owner when there is
-- no team manager) gets a notice, and the choice is written to the audit log. Who may pick is unchanged.
-- * Fires after a person's own write of their own leave (auth.uid() = user_id) that sets a deputy, changes it, or
--   changes the dates while a deputy is set. A leave written for someone else by an owner or admin is not "picked for
--   oneself" and tells nobody (the generic audit entry of member_leaves still records it).
-- * Recipients: the managers of every team the employee is in, and of the teams above them (the rule of
--   app.manages_team, ten levels), active, not the employee; when there is none, the active owners, not the employee.
--   One `system` notice each, with names and dates only; no link (the hours page is for owners and admins).
-- * Audit: one entry, action `deputy_chosen`, entity member_leaves, changes {user_id, deputy_id, starts_on, ends_on}.
-- Additive only. Safe to run twice.

create or replace function app.member_leaves_deputy_notice() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_name text;
  v_deputy text;
  v_title text;
  v_body text;
  v_told int;
begin
  if v_me is null or new.user_id is distinct from v_me or new.deputy_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.deputy_id is not distinct from old.deputy_id
     and new.starts_on = old.starts_on and new.ends_on = old.ends_on then
    return null;
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'עובד') into v_name from public.profiles p where p.id = new.user_id;
  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'עובד') into v_deputy from public.profiles p where p.id = new.deputy_id;
  v_title := left('ממלא מקום בהיעדרות: ' || coalesce(v_name, 'עובד'), 200);
  v_body := left('נבחר ממלא מקום על ידי ' || coalesce(v_name, 'עובד') || ': ' || coalesce(v_deputy, 'עובד') || ', מ-'
                 || to_char(new.starts_on, 'DD.MM.YYYY') || ' עד ' || to_char(new.ends_on, 'DD.MM.YYYY')
                 || '. ממלא המקום רואה בזמן הזה את הרשומות של המשימות הפתוחות והלידים שלא נענו.', 500);

  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select distinct new.organization_id, tm.user_id, 'system', v_title, v_body, 'member_leaves', new.id
    from (
      with recursive chain as (
        select t.id, t.parent_team_id, 1 as depth
          from public.team_members mine
          join public.teams t on t.organization_id = mine.organization_id and t.id = mine.team_id
         where mine.organization_id = new.organization_id and mine.user_id = new.user_id
        union all
        select t.id, t.parent_team_id, c.depth + 1
          from public.teams t
          join chain c on t.id = c.parent_team_id
         where c.depth < 10 and t.organization_id = new.organization_id
      )
      select distinct tm.user_id
        from chain c
        join public.team_members tm on tm.organization_id = new.organization_id and tm.team_id = c.id and tm.is_manager
    ) tm
    join public.memberships m on m.organization_id = new.organization_id and m.user_id = tm.user_id and m.status = 'active'
   where tm.user_id <> new.user_id;
  get diagnostics v_told = row_count;

  if v_told = 0 then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    select new.organization_id, m.user_id, 'system', v_title, v_body, 'member_leaves', new.id
      from public.memberships m
     where m.organization_id = new.organization_id and m.role = 'owner' and m.status = 'active'
       and m.user_id <> new.user_id;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (new.organization_id, v_me, 'deputy_chosen', 'member_leaves', new.id,
          jsonb_build_object('user_id', new.user_id, 'deputy_id', new.deputy_id,
                             'starts_on', new.starts_on, 'ends_on', new.ends_on));
  return null;
end;
$$;
revoke all on function app.member_leaves_deputy_notice() from public, anon, authenticated;

create or replace trigger member_leaves_deputy_notice after insert or update of deputy_id, starts_on, ends_on on public.member_leaves
  for each row execute function app.member_leaves_deputy_notice();
