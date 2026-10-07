-- =============================================================================
-- 0017 Global search
-- =============================================================================
-- public.search_records(org, query): leads, contacts, companies, deals and timeline
-- notes in one call, for the search box in the top bar (Ctrl+K or /).
-- * Runs with the caller's rights (security invoker): RLS decides what is found,
--   exactly as in the lists.
-- * Forgives Hebrew typing: niqqud, geresh and quotes are ignored, final letters
--   match their regular form (app.search_norm), and a near miss still matches
--   (pg_trgm word similarity). Phones match by digits in any format.
-- * Trigram indexes on the normalized text keep it fast on large tables.
-- Every statement is safe to run twice.

create extension if not exists pg_trgm with schema extensions;

-- lower case, no niqqud, no geresh or quotes, final letters as regular ones
create or replace function app.search_norm(p_text text) returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select translate(lower(regexp_replace(coalesce(p_text, ''), '[֑-ׇ]', '', 'g')), 'ךםןףץ׳״''"', 'כמנפצ');
$$;

create index if not exists leads_search_idx on public.leads
  using gin (app.search_norm(coalesce(full_name, '') || ' ' || coalesce(company_name, '') || ' ' || coalesce(email, '')) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists contacts_search_idx on public.contacts
  using gin (app.search_norm(coalesce(full_name, '') || ' ' || coalesce(email, '')) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists companies_search_idx on public.companies
  using gin (app.search_norm(name || ' ' || coalesce(tax_id, '') || ' ' || coalesce(email, '')) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists deals_search_idx on public.deals
  using gin (app.search_norm(name) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists activities_search_idx on public.activities
  using gin (app.search_norm(body) extensions.gin_trgm_ops)
  where body is not null;
create index if not exists leads_phone_trgm_idx on public.leads using gin (phone_e164 extensions.gin_trgm_ops) where deleted_at is null;
create index if not exists contacts_phone_trgm_idx on public.contacts using gin (phone_e164 extensions.gin_trgm_ops) where deleted_at is null;
create index if not exists companies_phone_trgm_idx on public.companies using gin (phone_e164 extensions.gin_trgm_ops) where deleted_at is null;

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

-- timeline notes and logged calls, meetings and messages (not system entries)
create or replace function app.search_notes(p_org uuid, p_q text, p_like text, p_limit integer) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select a.id, a.type, left(a.body, 160) as body, a.occurred_at, a.lead_id, a.contact_id, a.company_id, a.deal_id
      from public.activities a
     where a.organization_id = p_org and a.body is not null
       and a.type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
       and (app.search_norm(a.body) like p_like or p_q operator(extensions.<%) app.search_norm(a.body))
     order by a.occurred_at desc
     limit p_limit) x;
$$;

create or replace function public.search_records(p_org uuid, p_query text, p_limit integer default 6) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_q      text := app.search_norm(trim(coalesce(p_query, '')));
  v_like   text;
  -- phone digits without the leading 0 or 972, so 050-1234567 finds +972501234567
  v_digits text := regexp_replace(regexp_replace(coalesce(p_query, ''), '\D', '', 'g'), '^(972|0)', '');
  v_limit  integer := least(greatest(coalesce(p_limit, 6), 1), 20);
begin
  if char_length(v_q) < 2 then
    return jsonb_build_object('leads', '[]'::jsonb, 'contacts', '[]'::jsonb, 'companies', '[]'::jsonb, 'deals', '[]'::jsonb, 'notes', '[]'::jsonb);
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if char_length(v_digits) < 4 then
    v_digits := null;
  end if;
  -- a near miss: one or two wrong letters in a word still match
  perform set_config('pg_trgm.word_similarity_threshold', '0.45', true);
  return jsonb_build_object(
    'leads', app.search_leads(p_org, v_q, v_like, v_digits, v_limit),
    'contacts', app.search_contacts(p_org, v_q, v_like, v_digits, v_limit),
    'companies', app.search_companies(p_org, v_q, v_like, v_digits, v_limit),
    'deals', app.search_deals(p_org, v_q, v_like, v_limit),
    'notes', app.search_notes(p_org, v_q, v_like, v_limit));
end;
$$;

revoke all on function public.search_records(uuid, text, integer) from public, anon;
grant execute on function public.search_records(uuid, text, integer) to authenticated;
revoke all on function app.search_norm(text) from public, anon;
grant execute on function app.search_norm(text) to authenticated, service_role;
revoke all on function app.search_leads(uuid, text, text, text, integer) from public, anon;
revoke all on function app.search_contacts(uuid, text, text, text, integer) from public, anon;
revoke all on function app.search_companies(uuid, text, text, text, integer) from public, anon;
revoke all on function app.search_deals(uuid, text, text, integer) from public, anon;
revoke all on function app.search_notes(uuid, text, text, integer) from public, anon;
grant execute on function app.search_leads(uuid, text, text, text, integer) to authenticated;
grant execute on function app.search_contacts(uuid, text, text, text, integer) to authenticated;
grant execute on function app.search_companies(uuid, text, text, text, integer) to authenticated;
grant execute on function app.search_deals(uuid, text, text, integer) to authenticated;
grant execute on function app.search_notes(uuid, text, text, integer) to authenticated;
