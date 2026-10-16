-- =============================================================================
-- Indexes for foreign keys and for the nightly scans (FXD-06, first part)
-- =============================================================================
-- * Every foreign key in schemas public and app now has an index that a lookup by the referenced row can use
--   (its columns lead the index, or its key column behind organization_id does), so deleting or merging a
--   record, a team, a source or a membership no longer scans the referring tables. Foreign keys to auth.users
--   that only record who did something (created_by, updated_by and the like, ON DELETE SET NULL) are left
--   without one on purpose: deleting a user account is rare, and an index on every such column would slow every
--   write. A partial index counts only when its condition is "<key column> is not null"; an index limited to live
--   records (deleted_at is null) misses the rows in the recycle bin. Also left out: app.org_suspensions and
--   app.trial_end_transitions (a few rows per business at most). tests/db/130-foreign-key-indexes.test.ts keeps
--   the rule for every new table.
-- * Two partial indexes for the nightly jobs: the records in the recycle bin (app.purge_trash() deletes by
--   deleted_at) and the notifications of a record (app.purge_links() and merges look them up by entity_id).
--   The task reminders already have one (tasks_reminder_due_idx).
-- Not here (FXD-06 follow-ups): purging in batches and removing old notifications. Both need delete statements
-- (a file pasted by hand), and the second needs a decision on how long a notification is kept.
-- Every statement is safe to run twice. No drops, no row removal.

create index if not exists absence_waiting_leads_organization_fk_idx on app.absence_waiting_leads (organization_id);  -- absence_waiting_leads_organization_id_fkey -> public.organizations
create index if not exists consent_pending_address_organization_fk_idx on app.consent_pending_address (organization_id);  -- consent_pending_address_organization_id_fkey -> public.organizations
create index if not exists lead_response_checks_organization_fk_idx on app.lead_response_checks (organization_id);  -- lead_response_checks_organization_id_fkey -> public.organizations
create index if not exists rotation_waiting_leads_organization_fk_idx on app.rotation_waiting_leads (organization_id);  -- rotation_waiting_leads_organization_id_fkey -> public.organizations
create index if not exists support_sessions_organization_fk_idx on app.support_sessions (organization_id);  -- support_sessions_organization_id_fkey -> public.organizations
create index if not exists companies_team_id_fk_idx on public.companies (organization_id, team_id);  -- companies_organization_id_team_id_fkey -> public.teams
create index if not exists contacts_source_id_fk_idx on public.contacts (organization_id, source_id);  -- contacts_organization_id_source_id_fkey -> public.lead_sources
create index if not exists contacts_team_id_fk_idx on public.contacts (organization_id, team_id);  -- contacts_organization_id_team_id_fkey -> public.teams
create index if not exists deals_source_id_fk_idx on public.deals (organization_id, source_id);  -- deals_organization_id_source_id_fkey -> public.lead_sources
create index if not exists deals_team_id_fk_idx on public.deals (organization_id, team_id);  -- deals_organization_id_team_id_fkey -> public.teams
create index if not exists forms_owner_id_fk_idx on public.forms (organization_id, owner_id);  -- forms_organization_id_owner_id_fkey -> public.memberships
create index if not exists forms_source_id_fk_idx on public.forms (organization_id, source_id);  -- forms_organization_id_source_id_fkey -> public.lead_sources
create index if not exists forms_team_id_fk_idx on public.forms (organization_id, team_id);  -- forms_organization_id_team_id_fkey -> public.teams
create index if not exists leads_converted_company_id_fk_idx on public.leads (organization_id, converted_company_id);  -- leads_organization_id_converted_company_id_fkey -> public.companies
create index if not exists leads_converted_contact_id_fk_idx on public.leads (organization_id, converted_contact_id);  -- leads_organization_id_converted_contact_id_fkey -> public.contacts
create index if not exists leads_converted_deal_id_fk_idx on public.leads (organization_id, converted_deal_id);  -- leads_organization_id_converted_deal_id_fkey -> public.deals
create index if not exists leads_source_id_fk_idx on public.leads (organization_id, source_id);  -- leads_organization_id_source_id_fkey -> public.lead_sources
create index if not exists leads_team_id_fk_idx on public.leads (organization_id, team_id);  -- leads_organization_id_team_id_fkey -> public.teams
create index if not exists outbox_events_organization_fk_idx on public.outbox_events (organization_id);  -- outbox_events_organization_id_fkey -> public.organizations
create index if not exists saved_views_owner_id_fk_idx on public.saved_views (organization_id, owner_id);  -- saved_views_organization_id_owner_id_fkey -> public.memberships
create index if not exists saved_views_team_id_fk_idx on public.saved_views (organization_id, team_id);  -- saved_views_organization_id_team_id_fkey -> public.teams
create index if not exists subscriptions_plan_key_fk_idx on public.subscriptions (plan_key);  -- subscriptions_plan_key_fkey -> public.plans
create index if not exists tasks_team_id_fk_idx on public.tasks (organization_id, team_id);  -- tasks_organization_id_team_id_fkey -> public.teams
create index if not exists teams_parent_team_id_fk_idx on public.teams (organization_id, parent_team_id);  -- teams_organization_id_parent_team_id_fkey -> public.teams

-- the recycle bin, for app.purge_trash()
create index if not exists leads_bin_idx on public.leads (deleted_at) where deleted_at is not null;
create index if not exists contacts_bin_idx on public.contacts (deleted_at) where deleted_at is not null;
create index if not exists companies_bin_idx on public.companies (deleted_at) where deleted_at is not null;
create index if not exists deals_bin_idx on public.deals (deleted_at) where deleted_at is not null;
create index if not exists tasks_bin_idx on public.tasks (deleted_at) where deleted_at is not null;

-- the notifications of a record, for app.purge_links() and app.merge_move_links()
create index if not exists notifications_entity_idx on public.notifications (organization_id, entity_id) where entity_id is not null;

-- keys whose only index so far was limited to live records (where deleted_at is null): removing a member, a status, a
-- pipeline or a stage must also find the rows in the recycle bin, so these need a full index of their own
create index if not exists leads_owner_id_fk_idx on public.leads (organization_id, owner_id);  -- leads_organization_id_owner_id_fkey -> public.memberships
create index if not exists leads_status_id_fk_idx on public.leads (organization_id, status_id);  -- leads_organization_id_status_id_fkey -> public.lead_statuses
create index if not exists contacts_owner_id_fk_idx on public.contacts (organization_id, owner_id);  -- contacts_organization_id_owner_id_fkey -> public.memberships
create index if not exists companies_owner_id_fk_idx on public.companies (organization_id, owner_id);  -- companies_organization_id_owner_id_fkey -> public.memberships
create index if not exists deals_owner_id_fk_idx on public.deals (organization_id, owner_id);  -- deals_organization_id_owner_id_fkey -> public.memberships
create index if not exists deals_pipeline_id_fk_idx on public.deals (organization_id, pipeline_id);  -- deals_organization_id_pipeline_id_fkey -> public.pipelines
create index if not exists deals_stage_id_fk_idx on public.deals (pipeline_id, stage_id);  -- deals_pipeline_id_stage_id_fkey -> public.stages
create index if not exists tasks_owner_id_fk_idx on public.tasks (organization_id, owner_id);  -- tasks_organization_id_owner_id_fkey -> public.memberships
