-- =============================================================================
-- CON-09 follow-up: the company lookup reads only the candidate companies, whatever the planner picks
-- =============================================================================
-- Test 99 ("stays fast under RLS on 20,000 companies") failed in full runs with 20,001 company rows read and ~8 s:
-- the definer app.company_domain_candidates() is estimated at the default 1,000 rows, and in a database of many small
-- businesses a business looks like ~40 companies, so the planner hashed the WHOLE business through
-- companies_organization_id_id_key, with app.can_read_record() on every row, instead of probing the few candidates.
-- Production has many small businesses, so a big business would get the same plan.
-- The join to public.companies now also carries `c.id = any (<the candidates' ids>)`: the index condition is
-- (organization_id, id = any(...)) under any join method, so only the candidates are read. Same signature, same
-- answers; security invoker as before (RLS still decides what the caller reads). Safe to run twice.

create or replace function public.company_domain_matches(p_org uuid, p_email text)
returns table (id uuid, name text, domain text, kind text)
language sql stable security invoker
set search_path = ''
as $$
  with cand as (
    select u.v, u.ord
      from unnest(app.domain_candidates(app.email_domain(p_email))) with ordinality as u(v, ord)
  ),
  pre as materialized (
    select p.company_id, p.domain, p.by_contacts
      from app.company_domain_candidates(p_org, (select coalesce(array_agg(cand.v), '{}') from cand)) p
  ),
  hits as (
    select c.id, c.name, p.domain, cand.ord, p.by_contacts
      from pre p
      join cand on cand.v = p.domain
      join public.companies c on c.organization_id = p_org and c.id = p.company_id
                             -- only the candidates, under any join method (see the header)
                             and c.id = any (array(select x.company_id from pre x))
     where c.deleted_at is null
       and (not p.by_contacts
            or (c.contact_domain_off is null
                and app.company_own_domain(c.website, c.email) is null
                and public.company_contact_domain(p_org, c.id) = p.domain))
  ),
  -- the first tier decides (owner, 14 October 2026): at each level, from the full domain to the
  -- registered one, a company's own domain comes before a domain its contacts give it
  tier as (
    select h.ord, h.by_contacts from hits h order by h.ord, h.by_contacts limit 1
  ),
  best as (
    select distinct on (h.id) h.id, h.name, h.domain, h.by_contacts, h.ord
      from hits h
      join tier t on t.ord = h.ord and t.by_contacts = h.by_contacts
     order by h.id
  )
  select b.id, b.name, b.domain,
         case when b.by_contacts then 'contacts' when b.ord = 1 then 'exact' else 'parent' end
    from best b
   order by b.name, b.id
   limit 7;
$$;

revoke all on function public.company_domain_matches(uuid, text) from public, anon, service_role;
grant execute on function public.company_domain_matches(uuid, text) to authenticated;
