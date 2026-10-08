-- =============================================================================
-- 0044 Import duplicates found in one place; companies an import creates are its own (FXC-02)
-- =============================================================================
-- * public.import_find_duplicates(): the records of an organization that match
--   the phones, emails, tax ids or names of a chunk, read with the caller's
--   rights (security invoker: RLS decides). Emails and names compare without
--   case. The import used to look them up in four queries that ignored errors,
--   so a failed lookup turned "skip duplicates" into "create everything".
-- * A contacts import may tag the companies it creates with its job, so undoing
--   the import removes them too (guard_import_tag, otherwise as in 0012).
-- * Indexes for the company matches.
-- Every statement is safe to run twice.

create or replace function public.import_find_duplicates(
  p_org uuid, p_entity text, p_phones text[], p_emails text[], p_tax_ids text[], p_names text[]
) returns table (id uuid, phone_e164 text, email text, tax_id text, name text)
language sql stable security invoker
set search_path = ''
as $$
  select l.id, l.phone_e164, l.email, null::text, l.full_name
    from public.leads l
   where p_entity = 'lead' and l.organization_id = p_org and l.deleted_at is null and l.converted_at is null
     and (l.phone_e164 = any (coalesce(p_phones, '{}'))
          or lower(l.email) = any (select lower(x) from unnest(coalesce(p_emails, '{}')) x))
  union all
  select c.id, c.phone_e164, c.email, null::text, nullif(concat_ws(' ', c.first_name, c.last_name), '')
    from public.contacts c
   where p_entity = 'contact' and c.organization_id = p_org and c.deleted_at is null
     and (c.phone_e164 = any (coalesce(p_phones, '{}'))
          or lower(c.email) = any (select lower(x) from unnest(coalesce(p_emails, '{}')) x))
  union all
  select o.id, o.phone_e164, o.email, o.tax_id, o.name
    from public.companies o
   where p_entity = 'company' and o.organization_id = p_org and o.deleted_at is null
     and (o.phone_e164 = any (coalesce(p_phones, '{}'))
          or lower(o.email) = any (select lower(x) from unnest(coalesce(p_emails, '{}')) x)
          or o.tax_id = any (coalesce(p_tax_ids, '{}'))
          or lower(o.name) = any (select lower(x) from unnest(coalesce(p_names, '{}')) x))
  limit 5000;
$$;
revoke all on function public.import_find_duplicates(uuid, text, text[], text[], text[], text[]) from public, anon;
grant execute on function public.import_find_duplicates(uuid, text, text[], text[], text[], text[]) to authenticated;

create index if not exists companies_name_lower_idx on public.companies (organization_id, lower(name));
create index if not exists companies_email_idx on public.companies (organization_id, lower(email)) where email is not null;
create index if not exists companies_phone_idx on public.companies (organization_id, phone_e164) where phone_e164 is not null;

-- A record may carry only a running import of the same user and type, set on
-- insert; a company may also carry a running contacts import (the companies it creates).
create or replace function app.guard_import_tag() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.import_job_id is distinct from old.import_job_id and auth.uid() is not null then
      raise exception 'import_job_id cannot be changed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.import_job_id is not null and auth.uid() is not null and not exists (
    select 1 from public.import_jobs j
     where j.organization_id = new.organization_id and j.id = new.import_job_id
       and j.created_by = auth.uid() and j.status = 'running'
       and (j.entity_type = tg_argv[0] or (tg_argv[0] = 'company' and j.entity_type = 'contact'))) then
    raise exception 'not a running import of this user' using errcode = '42501';
  end if;
  return new;
end;
$$;
