-- =============================================================================
-- PRV-02 Everything about one person, in one file
-- =============================================================================
-- An owner or admin downloads one ZIP with everything the business holds about a
-- lead or a contact: the record, the records made from it by conversion, the
-- timeline, tasks, meetings, files, quotes, consents and form inquiries. The app
-- reads it all with the user's session (RLS decides, as in the full export) and
-- writes this audit entry before it hands the file over: no entry, no file.
-- Privacy is never locked by plan (owner, 13 October 2026): no plan key.
-- Every statement is safe to run twice.

create or replace function public.log_person_export(p_org uuid, p_kind text, p_id uuid, p_rows integer, p_files integer)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not app.is_admin(p_org) then
    raise exception 'exporting a person is for owners and admins' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'contact') or p_id is null
     or p_rows is null or p_rows < 0 or p_rows > 10000000 or p_files is null or p_files < 0 or p_files > 1000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- the record must be of this business (the bin included); another business's id answers like a missing one
  if (p_kind = 'lead' and not exists (select 1 from public.leads l where l.organization_id = p_org and l.id = p_id))
     or (p_kind = 'contact' and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = p_id)) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'person_export', case p_kind when 'lead' then 'leads' else 'contacts' end, p_id,
          jsonb_build_object('rows', p_rows, 'file_count', p_files));
end;
$$;
revoke all on function public.log_person_export(uuid, text, uuid, integer, integer) from public, anon;
grant execute on function public.log_person_export(uuid, text, uuid, integer, integer) to authenticated;
