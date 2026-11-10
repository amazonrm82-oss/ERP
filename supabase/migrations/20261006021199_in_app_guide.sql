-- =============================================================================
-- In-app guide: the first-visit tour's seen mark (UX-05, also TRU-04)
-- =============================================================================
-- SPEC-ADDITIONS chapter 24, UX-05 (א): "סיור כניסה ראשונה, 5 צעדים, אפשר לדלג ולחזור מתפריט החשבון; נשמר ב-profiles
-- (עמודה משלו, column grant)".
--
-- profiles.guide_tour_seen_at: when this person finished or skipped the first-visit tour; null = never seen, so the tour
-- opens by itself on their next visit to a business. Written by the person only, through a column grant (the profiles
-- update policy is the person's own row), like whats_new_seen_on (USR-12). Replaying the tour from the account menu
-- changes nothing here. The app never marks it in a support session (FXS-08): staff only look.
-- The tour's texts, the "?" help of each main screen and the help center's articles are Markdown in the repo (docs/help/),
-- not in the database.
-- Every statement is safe to run twice. No drops, no deletes.

alter table public.profiles add column if not exists guide_tour_seen_at timestamptz;
comment on column public.profiles.guide_tour_seen_at is
  'UX-05: when this person finished or skipped the first-visit tour; null = never seen.';
grant update (guide_tour_seen_at) on public.profiles to authenticated;
