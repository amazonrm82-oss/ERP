-- =============================================================================
-- 0025 A record joins its owner's team
-- =============================================================================
-- app.default_team(): when a lead, contact, company, deal or task is created
-- without a team, or its owner changes and nobody chose a team, it takes the
-- owner's team, if the owner is in exactly one. So "team" visibility and team
-- managers' rights follow the owner without anyone picking a team, and a team
-- manager can create a record for someone in the team.
-- Runs after app.default_owner() (triggers fire in name order: *_default_owner,
-- then *_default_team), so a record created with no owner gets the creator's team.
-- Every statement is safe to run twice.

create or replace function app.default_team() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_team uuid;
begin
  if new.owner_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' and new.team_id is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.owner_id is not distinct from old.owner_id or new.team_id is distinct from old.team_id) then
    return new;
  end if;
  select min(tm.team_id::text)::uuid into v_team
    from public.team_members tm
   where tm.organization_id = new.organization_id and tm.user_id = new.owner_id
  having count(*) = 1;
  if v_team is not null then
    new.team_id := v_team;
  end if;
  return new;
end;
$$;
revoke all on function app.default_team() from public, anon, authenticated;

create or replace trigger leads_default_team before insert or update of owner_id on public.leads
  for each row execute function app.default_team();
create or replace trigger contacts_default_team before insert or update of owner_id on public.contacts
  for each row execute function app.default_team();
create or replace trigger companies_default_team before insert or update of owner_id on public.companies
  for each row execute function app.default_team();
create or replace trigger deals_default_team before insert or update of owner_id on public.deals
  for each row execute function app.default_team();
create or replace trigger tasks_default_team before insert or update of owner_id on public.tasks
  for each row execute function app.default_team();
