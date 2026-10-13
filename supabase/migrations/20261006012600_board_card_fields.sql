-- =============================================================================
-- 0126 Fields on a deal card in the board (DEAL-09, the rest)
-- =============================================================================
-- Each user picks which fields the cards of the deals board show. The choice
-- is kept in public.list_preferences (migration 0033) under the new list key
-- 'deal_board': same shape as a list's columns ([{"key", "width"}], width is
-- not used by the board), same rules (own rows only, user_id from the session,
-- per organization because custom fields belong to one). The app checks the
-- keys against the board's catalog (src/features/deals/board-fields.ts).
-- Only the check of allowed list keys changes. Safe to run twice.

alter table public.list_preferences drop constraint if exists list_preferences_object_type_check;
alter table public.list_preferences add constraint list_preferences_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'deal_board'));
