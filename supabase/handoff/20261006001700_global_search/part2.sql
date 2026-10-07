-- 20261006001700_global_search: part 2 of 3. Run the parts in order.
-- One function per kind of record, each run with the caller's rights. p_q is normalized,
-- p_like is '%p_q%' escaped, p_digits the phone digits (or null).
create or replace function app.search_leads(p_org uuid, p_q text, p_like text, p_digits text, p_limit integer) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select l.id, l.full_name as title, coalesce(l.company_name, l.phone, l.email) as subtitle
      from public.leads l
     where l.organization_id = p_org and l.deleted_at is null
       and (app.search_norm(coalesce(l.full_name, '') || ' ' || coalesce(l.company_name, '') || ' ' || coalesce(l.email, '')) like p_like
            or p_q operator(extensions.<%) app.search_norm(coalesce(l.full_name, '') || ' ' || coalesce(l.company_name, '') || ' ' || coalesce(l.email, ''))
            or (p_digits is not null and l.phone_e164 like '%' || p_digits || '%'))
     order by extensions.word_similarity(p_q, app.search_norm(coalesce(l.full_name, ''))) desc, l.created_at desc
     limit p_limit) x;
$$;

create or replace function app.search_contacts(p_org uuid, p_q text, p_like text, p_digits text, p_limit integer) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select c.id, c.full_name as title, coalesce(c.phone, c.email) as subtitle
      from public.contacts c
     where c.organization_id = p_org and c.deleted_at is null
       and (app.search_norm(coalesce(c.full_name, '') || ' ' || coalesce(c.email, '')) like p_like
            or p_q operator(extensions.<%) app.search_norm(coalesce(c.full_name, '') || ' ' || coalesce(c.email, ''))
            or (p_digits is not null and c.phone_e164 like '%' || p_digits || '%'))
     order by extensions.word_similarity(p_q, app.search_norm(coalesce(c.full_name, ''))) desc, c.created_at desc
     limit p_limit) x;
$$;

create or replace function app.search_companies(p_org uuid, p_q text, p_like text, p_digits text, p_limit integer) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select co.id, co.name as title, coalesce(co.city, co.phone) as subtitle
      from public.companies co
     where co.organization_id = p_org and co.deleted_at is null
       and (app.search_norm(co.name || ' ' || coalesce(co.tax_id, '') || ' ' || coalesce(co.email, '')) like p_like
            or p_q operator(extensions.<%) app.search_norm(co.name || ' ' || coalesce(co.tax_id, '') || ' ' || coalesce(co.email, ''))
            or (p_digits is not null and co.phone_e164 like '%' || p_digits || '%'))
     order by extensions.word_similarity(p_q, app.search_norm(co.name)) desc, co.created_at desc
     limit p_limit) x;
$$;

create or replace function app.search_deals(p_org uuid, p_q text, p_like text, p_limit integer) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select d.id, d.name as title, d.amount_agorot, d.currency
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null
       and (app.search_norm(d.name) like p_like or p_q operator(extensions.<%) app.search_norm(d.name))
     order by extensions.word_similarity(p_q, app.search_norm(d.name)) desc, d.created_at desc
     limit p_limit) x;
$$;
