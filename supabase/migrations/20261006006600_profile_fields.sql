-- =============================================================================
-- Personal profile (USR-01)
-- =============================================================================
-- * profiles gets: phone_e164 (set by trigger from phone, never by a client),
--   timezone (IANA name; null = follow the organization's), working_hours
--   (per weekday one start/end, strict shape, see app.working_hours_ok) and
--   signature (text for messages, up to 500 characters).
-- * The user may update only their own row (policy profiles_update, unchanged)
--   and only the columns full_name, phone, avatar_url, locale, timezone,
--   working_hours, signature (column grants). Colleagues read the row as before.
-- * Trigger profiles_check (security invoker): on every write sets phone_e164;
--   on update checks each changed field: full_name up to 120, phone up to 40,
--   locale 'he' or 'en' ('en' reserved, the app offers Hebrew only), timezone a
--   name Postgres knows, avatar_url an existing object of the user in bucket
--   'avatars'. Hints 'profile:<field>'. Rows written before are not re-checked
--   until that field changes.
-- * Photo: private bucket 'avatars', 2 MB, images only. Objects are named
--   '<user id>/<random uuid>'. A user writes and deletes only in their own
--   folder; the user and colleagues in a shared organization read (as profiles).
--   There is no update policy, so an object is never overwritten: a new photo is
--   a new object and the app deletes the old one. Served by short signed links.
-- Existing rows get phone_e164 the next time they are written (no bulk
-- rewrite here). Every statement is safe to run twice.

alter table public.profiles add column if not exists phone_e164 text;
alter table public.profiles add column if not exists timezone text;
alter table public.profiles add column if not exists working_hours jsonb;
alter table public.profiles add column if not exists signature text;

-- Working hours: {"sun": {"start": "09:00", "end": "17:00"}, ...}. Keys are
-- weekdays (sun..sat), a missing day is a day off; times are HH:MM in 24 hours,
-- start before end. Mirrored by src/features/profile/working-hours.ts.
create or replace function app.working_hours_ok(p_hours jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_day text;
  v_range jsonb;
  v_time constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if p_hours is null then
    return true;
  end if;
  if jsonb_typeof(p_hours) <> 'object' then
    return false;
  end if;
  for v_day, v_range in select e.key, e.value from jsonb_each(p_hours) e loop
    if v_day not in ('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat') then
      return false;
    end if;
    if jsonb_typeof(v_range) <> 'object'
       or (select count(*) from jsonb_object_keys(v_range)) <> 2
       or jsonb_typeof(v_range -> 'start') is distinct from 'string'
       or jsonb_typeof(v_range -> 'end') is distinct from 'string' then
      return false;
    end if;
    if (v_range ->> 'start') !~ v_time or (v_range ->> 'end') !~ v_time then
      return false;
    end if;
    if (v_range ->> 'start') collate "C" >= (v_range ->> 'end') collate "C" then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function app.working_hours_ok(jsonb) from public, anon;
grant execute on function app.working_hours_ok(jsonb) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_working_hours_check') then
    alter table public.profiles add constraint profiles_working_hours_check check (app.working_hours_ok(working_hours));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_signature_check') then
    alter table public.profiles add constraint profiles_signature_check check (signature is null or char_length(signature) <= 500);
  end if;
  -- shape only; the trigger also asks Postgres whether it knows the zone
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_timezone_check') then
    alter table public.profiles add constraint profiles_timezone_check
      check (timezone is null or (char_length(timezone) <= 64 and timezone ~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$'));
  end if;
end;
$$;

-- '<user id>/<uuid>' -> the user id; anything else -> null
create or replace function app.avatar_owner(p_name text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;
revoke all on function app.avatar_owner(text) from public, anon;
grant execute on function app.avatar_owner(text) to authenticated, service_role;

create or replace function app.profiles_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  new.phone_e164 := app.normalize_phone(new.phone);
  if tg_op = 'UPDATE' then
    if new.full_name is distinct from old.full_name and char_length(coalesce(new.full_name, '')) > 120 then
      raise exception 'profile full_name too long' using errcode = 'P0001', hint = 'profile:full_name';
    end if;
    if new.phone is distinct from old.phone and char_length(coalesce(new.phone, '')) > 40 then
      raise exception 'profile phone too long' using errcode = 'P0001', hint = 'profile:phone';
    end if;
    if new.locale is distinct from old.locale and new.locale not in ('he', 'en') then
      raise exception 'profile locale not supported' using errcode = 'P0001', hint = 'profile:locale';
    end if;
    if new.timezone is distinct from old.timezone and new.timezone is not null
       and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
      raise exception 'profile timezone unknown' using errcode = 'P0001', hint = 'profile:timezone';
    end if;
    if new.avatar_url is distinct from old.avatar_url and new.avatar_url is not null
       and (app.avatar_owner(new.avatar_url) is distinct from new.id
            or not exists (select 1 from storage.objects o where o.bucket_id = 'avatars' and o.name = new.avatar_url)) then
      raise exception 'profile avatar must be an own uploaded photo' using errcode = 'P0001', hint = 'profile:avatar';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.profiles_check() from public, anon;
grant execute on function app.profiles_check() to authenticated, service_role;

create or replace trigger profiles_check before insert or update on public.profiles
  for each row execute function app.profiles_check();

-- the user's own editable columns; phone_e164 and email stay server-only
grant update (full_name, phone, avatar_url, locale, timezone, working_hours, signature) on public.profiles to authenticated;

-- ----------------------------------------------------------------------------
-- Photo bucket
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', false, 2097152)
on conflict (id) do update set public = false, file_size_limit = 2097152;

do $$
begin
  -- hosted Supabase has the column; the local test shim does not
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    execute $sql$update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'] where id = 'avatars'$sql$;
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'avatars_select') then
    create policy avatars_select on storage.objects for select to authenticated
      using (bucket_id = 'avatars'
             and (app.avatar_owner(objects.name) = (select auth.uid())
                  or (app.shares_org(app.avatar_owner(objects.name)) and app.session_verified())));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'avatars_insert') then
    create policy avatars_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'avatars' and app.avatar_owner(objects.name) = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'avatars_delete') then
    create policy avatars_delete on storage.objects for delete to authenticated
      using (bucket_id = 'avatars' and app.avatar_owner(objects.name) = (select auth.uid()));
  end if;
end;
$$;
