-- =============================================================================
-- 0027 Erasing a person's details from the audit log (privacy requests)
-- =============================================================================
-- A permanently deleted record still lives in the audit log: its delete entry
-- keeps the full row, and its updates keep old and new values. When a person
-- asks a business to delete their details, an owner or admin first deletes the
-- record for good (recycle bin), then erases it from the log here:
-- * public.audit_erase_candidates(org, query): deleted leads, contacts,
--   companies and deals in the log that match a name, phone or email
--   (security invoker: the audit log's RLS, admins only).
-- * public.audit_erase_record(org, type, id): the entries of that record and of
--   the tasks and files deleted with it keep who, what and when, but their
--   contents become {"erased": true}. Also emptied: the merge snapshot of it on
--   the record it was merged into, and lead form submissions with its email or
--   phone. A new entry records the erasure itself (no personal details).
-- * Purging a lead now also empties its form submissions (app.purge_links).
-- Every statement is safe to run twice.

create or replace function app.purge_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_col text := case tg_table_name
                  when 'leads' then 'lead_id'
                  when 'contacts' then 'contact_id'
                  when 'companies' then 'company_id'
                  when 'deals' then 'deal_id'
                end;
begin
  execute format(
    'delete from public.activities where organization_id = $1 and %I = $2
       and num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1', v_col)
    using old.organization_id, old.id;
  execute format(
    'delete from public.tasks where organization_id = $1 and %I = $2
       and num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1', v_col)
    using old.organization_id, old.id;
  delete from public.notifications n
   where n.organization_id = old.organization_id and n.entity_id = old.id;
  -- what the person typed into a lead form goes with the lead
  if tg_table_name = 'leads' then
    update public.form_submissions s set payload = '{}'::jsonb, user_agent = null
     where s.organization_id = old.organization_id and s.lead_id = old.id;
  end if;
  return old;
end;
$$;
revoke all on function app.purge_links() from public, anon, authenticated;

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

create or replace function public.audit_erase_record(p_org uuid, p_type text, p_id uuid) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_col text := case p_type when 'leads' then 'lead_id' when 'contacts' then 'contact_id'
                            when 'companies' then 'company_id' when 'deals' then 'deal_id' end;
  v_exists boolean;
  v_row jsonb;
  v_child record;
  v_children text[] := '{}';
  v_count integer;
  v_more integer;
begin
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if v_col is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;

  -- the deleted row, for the form submissions below (before it is erased)
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;

  -- tasks and files that were linked to it and no longer exist
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org
     and ((a.entity_type = p_type and a.entity_id = p_id) or (a.entity_type || ':' || a.entity_id) = any (v_children))
     and a.action <> 'erase'
     and a.changes is distinct from '{"erased": true}'::jsonb;
  get diagnostics v_count = row_count;

  -- the copy kept by a merge, on the record it was merged into
  update public.activities ac
     set metadata = ac.metadata - 'merged', body = 'מוזג עם רשומה כפולה (הפרטים נמחקו)'
   where ac.organization_id = p_org and ac.metadata ->> 'merged_id' = p_id::text and ac.metadata ? 'merged';
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  v_count := v_count + app.erase_submissions(p_org, v_row);

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;

revoke all on function public.audit_erase_candidates(uuid, text) from public, anon;
grant execute on function public.audit_erase_candidates(uuid, text) to authenticated;
revoke all on function public.audit_erase_record(uuid, text, uuid) from public, anon;
grant execute on function public.audit_erase_record(uuid, text, uuid) to authenticated;
