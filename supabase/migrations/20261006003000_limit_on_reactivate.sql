-- =============================================================================
-- 0030 Plan limits also apply when something comes back
-- =============================================================================
-- The plan's limits on custom fields per record type and on pipelines count
-- only what is in use (visible fields, pipelines not deleted), but were checked
-- only on insert. Hiding a field and showing it again, or deleting a pipeline
-- and bringing it back, could go past the limit. The same check
-- (app.enforce_count_limit) now runs on those updates too.
-- Every statement is safe to run twice.

drop trigger if exists field_definitions_limit_reactivate on public.field_definitions;
create trigger field_definitions_limit_reactivate before update of is_active on public.field_definitions
  for each row when (new.is_active and not old.is_active)
  execute function app.enforce_count_limit('max_custom_fields_per_object');

drop trigger if exists pipelines_limit_restore on public.pipelines;
create trigger pipelines_limit_restore before update of deleted_at on public.pipelines
  for each row when (old.deleted_at is not null and new.deleted_at is null)
  execute function app.enforce_count_limit('max_pipelines');
