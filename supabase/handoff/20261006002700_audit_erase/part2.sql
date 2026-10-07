-- 20261006002700_audit_erase: part 2 of 3. Run the parts in order.
create or replace function public.audit_erase_candidates(p_org uuid, p_query text) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(c order by c ->> 'deleted_at' desc), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'entity_type', a.entity_type,
               'entity_id', a.entity_id,
               'deleted_at', a.created_at,
               'name', coalesce(nullif(a.changes ->> 'full_name', ''), nullif(a.changes ->> 'name', ''),
                                nullif(btrim(concat_ws(' ', a.changes ->> 'first_name', a.changes ->> 'last_name')), '')),
               'email', a.changes ->> 'email',
               'phone', a.changes ->> 'phone') as c
        from public.audit_log a
       where a.organization_id = p_org
         and a.action = 'delete'
         and a.entity_type in ('leads', 'contacts', 'companies', 'deals')
         and char_length(btrim(coalesce(p_query, ''))) >= 2
         and a.changes::text ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
       order by a.created_at desc
       limit 20
    ) t;
$$;

-- lead form submissions no longer linked to a lead that carry the deleted row's email or phone
create or replace function app.erase_submissions(p_org uuid, p_row jsonb) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := lower(nullif(p_row ->> 'email', ''));
  v_phone text := case when char_length(coalesce(p_row ->> 'phone', '')) >= 7 then p_row ->> 'phone' end;
  v_count integer;
begin
  if v_email is null and v_phone is null then
    return 0;
  end if;
  update public.form_submissions s set payload = '{}'::jsonb, user_agent = null
   where s.organization_id = p_org and s.lead_id is null and s.payload <> '{}'::jsonb
     and ((v_email is not null and position(v_email in lower(s.payload::text)) > 0)
       or (v_phone is not null and position(v_phone in s.payload::text) > 0));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.erase_submissions(uuid, jsonb) from public, anon, authenticated;
