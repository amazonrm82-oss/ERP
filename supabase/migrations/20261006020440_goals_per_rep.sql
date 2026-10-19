-- RVW-22 (weekly review of 15 October 2026): the plan key goals_per_rep is checked.
--
-- Owner, 13 October 2026: one goal for the business on every plan; a goal per rep and per
-- team from "מקצועי" up (plans.features.goals_per_rep). Until now nothing read the key.
--
-- * Trigger goals_per_rep (before insert or update, security definer) refuses, for every
--   writer, a new goal with scope 'user' or 'team' and a change of such a goal's target or
--   identity while the business lacks the flag (P0001, hint feature:goals_per_rep).
-- * Goals of those scopes that already exist in a business without the flag stay as they
--   are: they are still read, counted and may be removed; an update that changes nothing
--   (target and identity equal) passes, so a no-op write never fails.
-- * Outsider guard first: a signed-in caller who is not a member of the goal's business
--   gets RLS's plain 42501 and learns nothing about that business's plan. The guard asks
--   for membership, not admin, because managers write goals of their teams too (the
--   "Price lists" rule's is_admin form would let every manager past the check).
--
-- Additive only. Safe to run twice.

create or replace function app.goals_per_rep_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return new;
  end if;
  if new.scope not in ('user', 'team') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.organization_id = old.organization_id
     and new.scope = old.scope
     and new.user_id is not distinct from old.user_id
     and new.team_id is not distinct from old.team_id
     and new.period = old.period
     and new.period_start = old.period_start
     and new.metric = old.metric
     and new.target = old.target then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'goals_per_rep') then
    raise exception 'a goal per rep or per team is not included in the plan'
      using errcode = 'P0001', hint = 'feature:goals_per_rep';
  end if;
  return new;
end;
$$;
revoke all on function app.goals_per_rep_check() from public, anon, authenticated;

create or replace trigger goals_per_rep before insert or update on public.goals
  for each row execute function app.goals_per_rep_check();
