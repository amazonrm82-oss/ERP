-- =============================================================================
-- Notification retention, the index part (FXD-06)
-- =============================================================================
-- Owner, 18 October 2026: read notifications are removed 90 days after they were made, unread ones after 180 days
-- (the audit log keeps the facts). The removal itself, app.purge_old_notifications(), and its nightly pg_cron job
-- are in 20261006020355_retention_purge.sql, which the owner pastes in the SQL Editor (the connector stops on a
-- migration that holds a delete statement).
-- * notifications_created_idx: the removal takes the oldest rows first in batches; without it every run would scan
--   the whole table. Safe to run twice.

create index if not exists notifications_created_idx on public.notifications (created_at);
