-- 20261006001700_global_search: part 3 of 3. Run the parts in order.
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
