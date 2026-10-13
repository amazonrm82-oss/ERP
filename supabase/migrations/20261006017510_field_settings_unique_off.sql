-- =============================================================================
-- Field settings, part 2 (FLD-07): forgetting a unique field's values removes them
-- =============================================================================
-- To be pasted by the owner in the SQL Editor (it holds a DELETE, which the
-- connector does not apply; see CLAUDE.md, Migrations).
-- Migration field_settings sets a forgotten field's rows in app.custom_unique_values
-- to null (unique switched off, field hidden or retyped). That is correct but slow on
-- big lists: switching unique on again then rewrites every row (about 2 s per
-- 100,000 records). Removing them instead keeps both directions fast (switching on
-- writes fresh rows). Until this file runs, the null version works the same way,
-- only slower. Nothing else changes. Safe to run twice.

create or replace function app.custom_unique_forget(p_field uuid) returns void
language sql security definer
set search_path = ''
as $$
  delete from app.custom_unique_values v where v.field_id = p_field;
$$;
revoke all on function app.custom_unique_forget(uuid) from public, anon, authenticated;
