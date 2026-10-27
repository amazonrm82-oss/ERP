-- =============================================================================
-- RVW-58 (weekly review 27 October 2026): organizations.timezone had no validity check. Owners hold an update grant on
-- the column (0004), so any string could be stored through the API, and dozens of functions read it as it is
-- (`at time zone o.timezone`): an unknown zone would break that business's public form, quotes, orders and reports.
-- Like profiles (0066, app.profiles_check), a new or changed zone must be a name in pg_timezone_names AND have the shape
-- app.intake_zone (011900) accepts (UTC or an IANA area/location name), for every writer (hint org:timezone): so
-- 'localtime', 'Factory', 'posixrules' (refused by the app's Intl) and 'Japan', 'GMT', 'EST5EDT' (which intake_zone would
-- turn into Jerusalem while the app used the stored zone) are refused. Existing rows are not touched or rewritten: the trigger fires only when a write names the column,
-- and judges only a value that changes (create_organization stores the column default 'Asia/Jerusalem').
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.organizations_timezone_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.timezone is distinct from old.timezone)
     and (new.timezone is null or char_length(new.timezone) > 64
          or new.timezone !~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$'
          or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone)) then
    raise exception 'organization timezone unknown' using errcode = 'P0001', hint = 'org:timezone';
  end if;
  return new;
end;
$$;
revoke all on function app.organizations_timezone_check() from public, anon;
grant execute on function app.organizations_timezone_check() to authenticated, service_role;

create or replace trigger organizations_timezone_check before insert or update of timezone on public.organizations
  for each row execute function app.organizations_timezone_check();
