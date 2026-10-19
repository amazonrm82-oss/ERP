-- =============================================================================
-- USR-07: a person's own light or dark mode (owner, 18 October 2026, answer (ג))
-- =============================================================================
-- "לפי המכשיר" is the default; a person may pick light or dark in their profile ("החשבון שלי"), for every business.
-- * profiles.theme: null = by the device (prefers-color-scheme), 'light' or 'dark'. The user updates their own row only
--   (policy profiles_update, unchanged); column grant below.
-- * The app keeps a copy in a cookie per device so the first paint already has the right theme (no flash); the column
--   is what a new device takes the choice from. The dark colours are the design system's (DSN-05), unchanged.
-- No drop statement, no delete, no row changes. Safe to run twice.

alter table public.profiles add column if not exists theme text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_theme_check') then
    alter table public.profiles add constraint profiles_theme_check check (theme is null or theme in ('light', 'dark'));
  end if;
end;
$$;

grant update (theme) on public.profiles to authenticated;
