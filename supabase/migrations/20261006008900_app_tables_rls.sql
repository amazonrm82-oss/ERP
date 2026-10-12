-- RVW-15: row level security on every table of schema app, as on the live project.
--
-- On the hosted project RLS was switched on for the first seven tables of schema app when
-- the early migrations were run by hand in the SQL Editor; the repo never did it, so local
-- and CI databases differed from live. This makes them the same, and covers the app tables
-- added since then.
--
-- No policies, on purpose: clients have no grants on schema app tables, and the functions
-- that use them are security definer, owned by the table owner, which bypasses RLS (RLS is
-- not FORCEd). Safe to run twice: enabling RLS that is already on is a no-op.

alter table app.settings enable row level security;
alter table app.platform_staff enable row level security;
alter table app.platform_log enable row level security;
alter table app.mfa_recovery_codes enable row level security;
alter table app.mfa_recovery_attempts enable row level security;
alter table app.agreement_signatures enable row level security;
alter table app.orphan_files enable row level security;
alter table app.automation_scan_cursors enable row level security;
alter table app.activity_audit_links enable row level security;
