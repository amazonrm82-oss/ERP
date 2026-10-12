-- =============================================================================
-- Import duplicates: a foreign registration number matches loosely (CON-04)
-- =============================================================================
-- Since 0078 a company outside Israel stores its number trimmed, as typed
-- ("AB 123/4"), while an Israeli one is stored as 9 digits. An import compared
-- numbers only by exact equality, so "ab-1234" in a file never found "AB 123/4".
-- public.import_find_duplicates() keeps its signature, its return type and its
-- grants (callers during the deploy keep working); only the company match grows:
-- * as before, a stored number equal to a value in p_tax_ids matches (whatever
--   the company's country);
-- * new: p_tax_ids may also carry match keys. 'GB:AB1234' finds a company in GB
--   whose number, without case and without spaces, '-', '.' and '/', is AB1234;
--   '*:AB1234' (a file row without a country) finds it in any country outside
--   Israel. A key never matches an Israeli company, so an Israeli number meets a
--   foreign one only when the stored values are equal. A stored number cannot
--   hold ':' (0078 allows Latin letters, digits, space, '-', '.', '/'), so a key
--   is never mistaken for a plain value. Mirrors foreignNumberKey() in
--   src/features/imports/country.ts.
-- Still security invoker (RLS decides what is found). Safe to run twice.

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
          or (o.country <> 'IL' and o.tax_id is not null
              and exists (
                select 1 from unnest(coalesce(p_tax_ids, '{}')) k
                 where k in (o.country || ':' || upper(regexp_replace(o.tax_id, '[ ./-]', '', 'g')),
                             '*:' || upper(regexp_replace(o.tax_id, '[ ./-]', '', 'g')))))
          or lower(o.name) = any (select lower(x) from unnest(coalesce(p_names, '{}')) x))
  limit 5000;
$$;
revoke all on function public.import_find_duplicates(uuid, text, text[], text[], text[], text[]) from public, anon;
grant execute on function public.import_find_duplicates(uuid, text, text[], text[], text[], text[]) to authenticated;
