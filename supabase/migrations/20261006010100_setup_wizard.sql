-- =============================================================================
-- 0101 Setup wizard progress (USR-03)
-- =============================================================================
-- After a business is created, its owner goes through a four-step setup wizard
-- (business details, industry, import, invite the team). Every step can be
-- skipped, and the wizard can be left and resumed, so the organization keeps
-- the step to show next:
--   organizations.setup_step  1..4 = the next step; null = finished or skipped.
-- Organizations that exist before this migration get null (they never see the
-- wizard); the column default of 1 applies to every organization created from
-- now on by create_organization(), which is not changed.
-- Owners and admins write it like the other profile columns (policy
-- organizations_update = app.is_admin); everyone else gets 0 rows.
-- A change is a normal update of the organization and is audited as one.
-- Every statement is safe to run twice.

alter table public.organizations
  add column if not exists setup_step smallint
    constraint organizations_setup_step_check check (setup_step between 1 and 4);

alter table public.organizations alter column setup_step set default 1;

comment on column public.organizations.setup_step is
  'USR-03: next step of the setup wizard (1..4); null = finished, skipped, or created before the wizard.';

grant update (setup_step) on public.organizations to authenticated;
