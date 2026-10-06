-- =============================================================================
-- 0004 Row Level Security: policies and grants
-- =============================================================================
-- Rules of this file (a test fails the build when they are broken):
--   1. Every table in schema public has RLS enabled.
--   2. Role `anon` has no privilege on any table and cannot execute any function.
--   3. Role `authenticated` gets only the privileges granted explicitly below.
--   4. Columns a client must never write (status, plan, counters) are protected
--      with column-level UPDATE grants, not with policies.

create or replace function app.shares_org(p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid() and mine.status = 'active'
      and theirs.user_id = p_user
  )
$$;

-- ----------------------------------------------------------------------------
-- Start from zero
-- ----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;
revoke all on schema app from public, anon;

grant usage on schema app to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter table public.plans              enable row level security;
alter table public.organizations      enable row level security;
alter table public.profiles           enable row level security;
alter table public.memberships        enable row level security;
alter table public.teams              enable row level security;
alter table public.team_members       enable row level security;
alter table public.invitations        enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.org_usage          enable row level security;
alter table public.pipelines          enable row level security;
alter table public.stages             enable row level security;
alter table public.lead_statuses      enable row level security;
alter table public.lead_sources       enable row level security;
alter table public.tags               enable row level security;
alter table public.companies          enable row level security;
alter table public.contacts           enable row level security;
alter table public.leads              enable row level security;
alter table public.deals              enable row level security;
alter table public.deal_contacts      enable row level security;
alter table public.activities         enable row level security;
alter table public.tasks              enable row level security;
alter table public.field_definitions  enable row level security;
alter table public.saved_views        enable row level security;
alter table public.audit_log          enable row level security;
alter table public.outbox_events      enable row level security;
alter table public.notifications      enable row level security;

-- ----------------------------------------------------------------------------
-- Reference data
-- ----------------------------------------------------------------------------
grant select on public.plans to authenticated;
create policy plans_select on public.plans for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- Organizations: created through create_organization() only; an admin edits
-- the profile columns; status and lifecycle belong to the server.
-- ----------------------------------------------------------------------------
grant select on public.organizations to authenticated;
grant update (name, industry, team_size, phone, locale, timezone, currency, record_visibility)
  on public.organizations to authenticated;

create policy organizations_select on public.organizations for select to authenticated
  using (app.is_member(id));
create policy organizations_update on public.organizations for update to authenticated
  using (app.is_admin(id)) with check (app.is_admin(id));

-- ----------------------------------------------------------------------------
-- Profiles
-- ----------------------------------------------------------------------------
grant select on public.profiles to authenticated;
grant update (full_name, phone, avatar_url, locale) on public.profiles to authenticated;

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or app.shares_org(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- Memberships: rows are created by accept_invitation() / create_organization().
-- The guard trigger adds the rules about owners, self-changes and seats.
-- ----------------------------------------------------------------------------
grant select, delete on public.memberships to authenticated;
grant update (role, seat_type, status, is_available) on public.memberships to authenticated;

create policy memberships_select on public.memberships for select to authenticated
  using (app.is_member(organization_id));
create policy memberships_update on public.memberships for update to authenticated
  using (app.is_admin(organization_id) or user_id = (select auth.uid()))
  with check (app.is_admin(organization_id) or user_id = (select auth.uid()));
create policy memberships_delete on public.memberships for delete to authenticated
  using (app.is_admin(organization_id) or user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- Teams
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.teams, public.team_members to authenticated;

create policy teams_select on public.teams for select to authenticated
  using (app.is_member(organization_id));
create policy teams_insert on public.teams for insert to authenticated
  with check (app.is_admin(organization_id) and app.org_writable(organization_id));
create policy teams_update on public.teams for update to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id))
  with check (app.is_admin(organization_id));
create policy teams_delete on public.teams for delete to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id));

create policy team_members_select on public.team_members for select to authenticated
  using (app.is_member(organization_id));
create policy team_members_insert on public.team_members for insert to authenticated
  with check (app.is_admin(organization_id) and app.org_writable(organization_id));
create policy team_members_update on public.team_members for update to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id))
  with check (app.is_admin(organization_id));
create policy team_members_delete on public.team_members for delete to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id));

-- ----------------------------------------------------------------------------
-- Invitations: created by create_invitation(); admins list, revoke and delete.
-- ----------------------------------------------------------------------------
grant select, delete on public.invitations to authenticated;
grant update (revoked_at) on public.invitations to authenticated;

create policy invitations_select on public.invitations for select to authenticated
  using (app.is_admin(organization_id));
create policy invitations_update on public.invitations for update to authenticated
  using (app.is_admin(organization_id)) with check (app.is_admin(organization_id));
create policy invitations_delete on public.invitations for delete to authenticated
  using (app.is_admin(organization_id));

-- ----------------------------------------------------------------------------
-- Billing state: read-only for members, written by the server.
-- ----------------------------------------------------------------------------
grant select on public.subscriptions, public.org_usage to authenticated;

create policy subscriptions_select on public.subscriptions for select to authenticated
  using (app.is_member(organization_id));
create policy org_usage_select on public.org_usage for select to authenticated
  using (app.is_member(organization_id));

-- ----------------------------------------------------------------------------
-- Configuration tables: everyone in the organization reads, admins write.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete
  on public.pipelines, public.stages, public.lead_statuses, public.lead_sources, public.field_definitions
  to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['pipelines', 'stages', 'lead_statuses', 'lead_sources', 'field_definitions'] loop
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated using (app.is_member(organization_id))', t);
    execute format(
      'create policy %1$s_insert on public.%1$I for insert to authenticated with check (app.is_admin(organization_id) and app.org_writable(organization_id))', t);
    execute format(
      'create policy %1$s_update on public.%1$I for update to authenticated using (app.is_admin(organization_id) and app.org_writable(organization_id)) with check (app.is_admin(organization_id))', t);
    execute format(
      'create policy %1$s_delete on public.%1$I for delete to authenticated using (app.is_admin(organization_id) and app.org_writable(organization_id))', t);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- Tags
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.tags to authenticated;

create policy tags_select on public.tags for select to authenticated
  using (app.is_member(organization_id));
create policy tags_insert on public.tags for insert to authenticated
  with check (app.can_write(organization_id));
create policy tags_update on public.tags for update to authenticated
  using (app.can_write(organization_id) and (app.is_admin(organization_id) or created_by = (select auth.uid())))
  with check (app.can_write(organization_id));
create policy tags_delete on public.tags for delete to authenticated
  using (app.can_write(organization_id) and (app.is_admin(organization_id) or created_by = (select auth.uid())));

-- ----------------------------------------------------------------------------
-- Business records: leads, contacts, companies, deals.
--   read   -> app.can_read_record   (role + organization visibility + teams)
--   write  -> app.can_edit_record   (own / managed team / admin)
--   trash  -> UPDATE of deleted_at, checked by the guard_soft_delete trigger
--   purge  -> hard DELETE, admins only, and only from the recycle bin
-- ----------------------------------------------------------------------------
grant select, insert, update, delete
  on public.companies, public.contacts, public.leads, public.deals
  to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['companies', 'contacts', 'leads', 'deals'] loop
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated using (app.can_read_record(organization_id, owner_id, team_id))', t);
    execute format(
      'create policy %1$s_insert on public.%1$I for insert to authenticated with check (app.can_edit_record(organization_id, owner_id, team_id))', t);
    execute format(
      'create policy %1$s_update on public.%1$I for update to authenticated using (app.can_edit_record(organization_id, owner_id, team_id)) with check (app.can_edit_record(organization_id, owner_id, team_id))', t);
    execute format(
      'create policy %1$s_delete on public.%1$I for delete to authenticated using (deleted_at is not null and app.is_admin(organization_id) and app.org_writable(organization_id))', t);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- Tasks: same as records, and the creator always sees what they handed out.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.tasks to authenticated;

create policy tasks_select on public.tasks for select to authenticated
  using (app.can_read_record(organization_id, owner_id, team_id)
         or (created_by = (select auth.uid()) and app.is_member(organization_id)));
-- any writer may hand a task to a colleague
create policy tasks_insert on public.tasks for insert to authenticated
  with check (app.can_write(organization_id));
create policy tasks_update on public.tasks for update to authenticated
  using (app.can_edit_record(organization_id, owner_id, team_id)
         or (created_by = (select auth.uid()) and app.can_write(organization_id)))
  with check (app.can_write(organization_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (deleted_at is not null and app.is_admin(organization_id) and app.org_writable(organization_id));

-- ----------------------------------------------------------------------------
-- Deal contacts: follow the deal. The sub-select runs under the caller's own
-- policies on deals, so "can see the deal" is evaluated by the deals policy.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.deal_contacts to authenticated;

create policy deal_contacts_select on public.deal_contacts for select to authenticated
  using (exists (select 1 from public.deals d where d.id = deal_contacts.deal_id));
create policy deal_contacts_insert on public.deal_contacts for insert to authenticated
  with check (exists (
    select 1 from public.deals d
    where d.id = deal_contacts.deal_id
      and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)));
create policy deal_contacts_update on public.deal_contacts for update to authenticated
  using (exists (
    select 1 from public.deals d
    where d.id = deal_contacts.deal_id
      and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)))
  with check (exists (
    select 1 from public.deals d
    where d.id = deal_contacts.deal_id
      and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)));
create policy deal_contacts_delete on public.deal_contacts for delete to authenticated
  using (exists (
    select 1 from public.deals d
    where d.id = deal_contacts.deal_id
      and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)));

-- ----------------------------------------------------------------------------
-- Activities: visible to whoever can see at least one record they hang on.
-- Whoever can see a record may add to its timeline.
-- ----------------------------------------------------------------------------
create or replace function app.can_read_activity_subject(
  p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid
) returns boolean
language sql stable
set search_path = ''
as $$
  -- SECURITY INVOKER: each sub-select is filtered by the caller's policies
  select (p_lead is not null and exists (select 1 from public.leads l where l.id = p_lead))
      or (p_contact is not null and exists (select 1 from public.contacts c where c.id = p_contact))
      or (p_company is not null and exists (select 1 from public.companies co where co.id = p_company))
      or (p_deal is not null and exists (select 1 from public.deals d where d.id = p_deal))
$$;

revoke all on function app.can_read_activity_subject(uuid, uuid, uuid, uuid) from public;
grant execute on function app.can_read_activity_subject(uuid, uuid, uuid, uuid) to authenticated, service_role;

grant select, insert, delete on public.activities to authenticated;
grant update (body, metadata, occurred_at, is_pinned) on public.activities to authenticated;

create policy activities_select on public.activities for select to authenticated
  using (app.is_member(organization_id)
         and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id));
create policy activities_insert on public.activities for insert to authenticated
  with check (app.can_write(organization_id)
              and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id));
create policy activities_update on public.activities for update to authenticated
  using (app.can_write(organization_id)
         and (created_by = (select auth.uid()) or app.is_admin(organization_id)))
  with check (app.can_write(organization_id));
create policy activities_delete on public.activities for delete to authenticated
  using (app.can_write(organization_id)
         and (created_by = (select auth.uid()) or app.is_admin(organization_id)));

-- ----------------------------------------------------------------------------
-- Saved views
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.saved_views to authenticated;

create policy saved_views_select on public.saved_views for select to authenticated
  using (owner_id = (select auth.uid())
         or (scope = 'org' and app.is_member(organization_id))
         or (scope = 'team' and app.is_member(organization_id) and app.in_team(team_id)));
create policy saved_views_insert on public.saved_views for insert to authenticated
  with check (app.can_write(organization_id)
              and owner_id = (select auth.uid())
              and (scope = 'private'
                   or (scope = 'team' and (app.in_team(team_id) or app.is_admin(organization_id)))
                   or (scope = 'org' and app.is_admin(organization_id))));
create policy saved_views_update on public.saved_views for update to authenticated
  using (app.can_write(organization_id)
         and (owner_id = (select auth.uid()) or app.is_admin(organization_id)))
  with check (app.can_write(organization_id)
              and (scope <> 'org' or app.is_admin(organization_id)));
create policy saved_views_delete on public.saved_views for delete to authenticated
  using (owner_id = (select auth.uid()) or app.is_admin(organization_id));

-- ----------------------------------------------------------------------------
-- Audit log: admins read. Nobody writes from a client.
-- ----------------------------------------------------------------------------
grant select on public.audit_log to authenticated;
create policy audit_log_select on public.audit_log for select to authenticated
  using (app.is_admin(organization_id));

-- outbox_events: RLS on, no policy and no grant = no client access at all.

-- ----------------------------------------------------------------------------
-- Notifications: strictly personal
-- ----------------------------------------------------------------------------
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));
