-- =============================================================================
-- 0061 The organization's rest days (CAL-03)
-- =============================================================================
-- public.org_calendar_settings: at most one row per organization.
--   rest_weekdays      the weekly days off, 0 = Sunday … 6 = Saturday
--                      (default Friday and Saturday; a business works at least one day)
--   holidays_rest      holidays that are rest days by law are days off (default on)
--   holiday_eves_rest  the erev days of the main holidays are days off (default off)
-- No row means the defaults; the holiday dates themselves are computed in the
-- app (src/features/calendar-days/holidays.ts), not stored.
-- * Everyone in the organization reads it (the calendar marks rest days for all).
-- * Owners and admins write it, while the organization is writable, like the
--   other configuration tables. Audited.
-- * Read-only / suspended organization: reading goes on, nothing changes.
--   No plan limit or feature flag. Handover, merge: not involved. Full export:
--   configuration, like the pipelines.
-- Every statement is safe to run twice.

create table if not exists public.org_calendar_settings (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  rest_weekdays     smallint[] not null default '{5,6}'
                    check (rest_weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]
                           and cardinality(rest_weekdays) <= 6
                           and array_position(rest_weekdays, null) is null),
  holidays_rest     boolean not null default true,
  holiday_eves_rest boolean not null default false,
  updated_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

create or replace trigger org_calendar_settings_touch before insert or update on public.org_calendar_settings
  for each row execute function app.touch_row();
create or replace trigger org_calendar_settings_audit after insert or update or delete on public.org_calendar_settings
  for each row execute function app.audit_row();

alter table public.org_calendar_settings enable row level security;
revoke all on public.org_calendar_settings from anon, authenticated;
grant select, delete on public.org_calendar_settings to authenticated;
grant insert (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest) on public.org_calendar_settings to authenticated;
grant update (rest_weekdays, holidays_rest, holiday_eves_rest) on public.org_calendar_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_calendar_settings' and policyname = 'org_calendar_settings_select') then
    create policy org_calendar_settings_select on public.org_calendar_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_calendar_settings' and policyname = 'org_calendar_settings_insert') then
    create policy org_calendar_settings_insert on public.org_calendar_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_calendar_settings' and policyname = 'org_calendar_settings_update') then
    create policy org_calendar_settings_update on public.org_calendar_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_calendar_settings' and policyname = 'org_calendar_settings_delete') then
    create policy org_calendar_settings_delete on public.org_calendar_settings for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;
