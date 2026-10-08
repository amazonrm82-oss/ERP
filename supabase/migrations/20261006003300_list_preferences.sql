-- =============================================================================
-- 0033 Each user's columns for a list (LST-03)
-- =============================================================================
-- public.list_preferences: one row per user, organization and list (leads,
-- contacts, companies). columns is the chosen columns in order, each
-- {"key": "...", "width": "narrow" | "normal" | "wide"}; keys of custom fields
-- are "cf:<field key>". The app checks the keys against the list's columns and
-- the organization's fields; the database keeps the shape and size in check.
-- * Per organization, because custom fields belong to one organization.
-- * A user reads and writes only their own rows; user_id comes from the session.
-- Every statement is safe to run twice.

create table if not exists public.list_preferences (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null default auth.uid(),
  object_type     text not null check (object_type in ('lead', 'contact', 'company')),
  columns         jsonb not null default '[]'::jsonb
                  check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) <= 60 and pg_column_size(columns) <= 8192),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id, object_type),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);

drop trigger if exists list_preferences_touch on public.list_preferences;
create trigger list_preferences_touch before insert or update on public.list_preferences
  for each row execute function app.touch_row();

alter table public.list_preferences enable row level security;
revoke all on public.list_preferences from anon, authenticated;
grant select, delete on public.list_preferences to authenticated;
grant insert (organization_id, object_type, columns) on public.list_preferences to authenticated;
grant update (columns) on public.list_preferences to authenticated;

drop policy if exists list_preferences_select on public.list_preferences;
drop policy if exists list_preferences_insert on public.list_preferences;
drop policy if exists list_preferences_update on public.list_preferences;
drop policy if exists list_preferences_delete on public.list_preferences;
create policy list_preferences_select on public.list_preferences for select to authenticated
  using (user_id = (select auth.uid()) and app.is_member(organization_id));
create policy list_preferences_insert on public.list_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and app.is_member(organization_id));
create policy list_preferences_update on public.list_preferences for update to authenticated
  using (user_id = (select auth.uid()) and app.is_member(organization_id))
  with check (user_id = (select auth.uid()) and app.is_member(organization_id));
create policy list_preferences_delete on public.list_preferences for delete to authenticated
  using (user_id = (select auth.uid()) and app.is_member(organization_id));
