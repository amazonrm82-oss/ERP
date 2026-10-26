-- =============================================================================
-- CNS-06 follow-up (owner, 26 October 2026): an import that ran before the blocked-addresses count is "not counted"
-- =============================================================================
-- public.import_jobs.consents_locked (20261006021025) counts the consents an import kept out because the address is
-- blocked; jobs that ran before it exist show 0, which would read as "none were blocked". The import history now says
-- "לא נספר בייבוא הזה" for such a job when it mapped consent columns (consent_method is set).
-- * public.import_jobs.consents_locked_counted: added with default false, so every existing job reads false, then the
--   default becomes true for every job made from now on. Adding a column with a constant default rewrites no row and
--   updates nothing (no bulk change of existing rows). Server only: clients have column-level insert and update grants
--   on import_jobs and none is given for it; select follows the table's grant.
-- Safe to run twice: the column is added only when missing, and setting the default again changes nothing.

alter table public.import_jobs add column if not exists consents_locked_counted boolean not null default false;
alter table public.import_jobs alter column consents_locked_counted set default true;

comment on column public.import_jobs.consents_locked_counted is
  'CNS-06: false on jobs made before consents_locked was counted (20261006021025): their count is unknown, not 0 (server only)';
