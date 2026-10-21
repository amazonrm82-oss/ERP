-- =============================================================================
-- Removing a person erases the old name of a deal it renames (RVW-46)
-- =============================================================================
-- public.privacy_erase_person (PRV-03, 020530) makes the caller rename a kept deal whose name holds the person's name, but
-- app.audit_row recorded the rename as changes.name {old: <the old name>, new: ...}, and earlier renames of that deal kept
-- the person's name the same way; owners and admins see them in the deal's history. Now every audit entry of a deal this
-- call renamed that carries a name change becomes {"erased": true} (its time, actor and action stay), as the call already
-- does for the meetings it cleans. `changes ? 'name'` also matches an entry whose changes hold a whole row snapshot with a
-- name (the deal's creation), so that snapshot is erased too: accepted, since it may hold the person's name as well (review
-- of this file, low). The deal's other entries stay. The body is that of 020530 plus this update; the deletes
-- stay in app.person_erase_delete_rows (020535, pasted by the owner), which this file does not touch. Safe to run twice.
-- No drops, no row removal.

create or replace function public.privacy_erase_person(p_org uuid, p_type text, p_id uuid, p_extra jsonb, p_reason text,
                                                       p_deal_names jsonb default '{}'::jsonb,
                                                       p_person_request boolean default true)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_leads uuid[];
  v_contacts uuid[];
  v_tokens text[];
  v_kept uuid[];
  v_deal record;
  v_key text;
  v_name text;
  v_meetings uuid[];
  v_id uuid;
  v_inquiries integer := 0;
  v_leads_n integer := 0;
  v_contacts_n integer := 0;
  v_renamed integer := 0;
  -- RVW-46: the deals this call renamed
  v_renamed_ids uuid[] := '{}';
  v_paused boolean := false;
  v_counts jsonb;
  v_deleted jsonb;
begin
  perform app.person_erase_allowed(p_org);
  if p_type not in ('leads', 'contacts') then
    raise exception 'a lead or a contact' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'a reason is required' using errcode = 'P0001', hint = 'person_erase:reason';
  end if;
  if p_deal_names is not null and jsonb_typeof(p_deal_names) <> 'object' then
    raise exception 'deal names are an object' using errcode = '22023', hint = 'person_erase:deal_name';
  end if;

  -- the set, read once and locked
  select coalesce(array_agg(f.record_id order by f.record_id) filter (where f.record_type = 'leads'), '{}'),
         coalesce(array_agg(f.record_id order by f.record_id) filter (where f.record_type = 'contacts'), '{}')
    into v_leads, v_contacts
    from app.person_erase_full(p_org, p_type, p_id, p_extra) f;
  if not (p_id = any (case p_type when 'leads' then v_leads else v_contacts end)) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform 1 from public.leads l where l.organization_id = p_org and l.id = any (v_leads) order by l.id for update;
  perform 1 from public.contacts c where c.organization_id = p_org and c.id = any (v_contacts) order by c.id for update;
  -- linked meanwhile: retry
  if exists (select 1 from app.person_erase_full(p_org, p_type, p_id, p_extra) f
              where not (f.record_id = any (v_leads || v_contacts))) then
    raise exception 'the records changed' using errcode = '40001', hint = 'person_erase:changed';
  end if;

  -- kept deals: a deal that holds the person's name must be renamed, to a name that does not
  v_tokens := app.person_erase_name_tokens(p_org, v_leads, v_contacts);
  select coalesce(array_agg(k.deal_id), '{}') into v_kept from app.person_erase_kept_deals(p_org, v_leads, v_contacts) k;
  for v_key in select jsonb_object_keys(coalesce(p_deal_names, '{}'::jsonb)) loop
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not (v_key::uuid = any (v_kept)) then
      raise exception 'not a deal that stays' using errcode = '22023', hint = 'person_erase:deal_name';
    end if;
  end loop;
  for v_deal in select d.id, d.name from public.deals d where d.organization_id = p_org and d.id = any (v_kept) order by d.id for update loop
    v_name := nullif(btrim(coalesce(p_deal_names ->> v_deal.id::text, '')), '');
    if v_name is null then
      if app.person_erase_name_hit(v_deal.name, v_tokens) then
        raise exception 'the deal''s name holds the person''s name' using errcode = 'P0001', hint = 'person_erase:deal_name';
      end if;
      continue;
    end if;
    if char_length(v_name) > 200 or app.person_erase_name_hit(v_name, v_tokens) then
      raise exception 'not a usable deal name' using errcode = 'P0001', hint = 'person_erase:deal_name';
    end if;
    if v_name is distinct from v_deal.name then
      update public.deals d set name = v_name where d.organization_id = p_org and d.id = v_deal.id;
      v_renamed := v_renamed + 1;
      v_renamed_ids := v_renamed_ids || v_deal.id;
    end if;
  end loop;
  -- RVW-46: the history of those deals keeps no name they had (the rename just made included); other entries stay
  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org and a.entity_type = 'deals' and a.entity_id = any (v_renamed_ids)
     and a.changes ? 'name';

  -- meetings stay without the person's details
  with changed as (
    update public.meetings m
       set title = 'פגישה (לקוח נמחק)', description = null, location = null, outcome = null, lead_id = null, contact_id = null
     where m.organization_id = p_org and (m.lead_id = any (v_leads) or m.contact_id = any (v_contacts))
    returning m.id
  )
  select coalesce(array_agg(c.id), '{}') into v_meetings from changed c;
  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org and a.entity_type = 'meetings' and a.entity_id = any (v_meetings)
     and a.changes is distinct from '{"erased": true}'::jsonb;
  update public.notifications n set title = 'פגישה (לקוח נמחק)', body = null
   where n.organization_id = p_org and n.entity_type = 'meeting' and n.entity_id = any (v_meetings);

  v_counts := jsonb_build_object(
    'channels', (select count(*) from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = any (v_contacts)),
    'files', (select count(*) from public.files fi where fi.organization_id = p_org and (fi.lead_id = any (v_leads) or fi.contact_id = any (v_contacts))));

  -- the form inquiries of the person's leads, then the leads and contacts (binned, then deleted for good): the one helper
  -- that deletes rows, app.person_erase_delete_rows (20261006020535_person_erase.sql, pasted by the owner)
  v_deleted := app.person_erase_delete_rows(p_org, v_leads, v_contacts);
  v_inquiries := (v_deleted ->> 'inquiries')::integer;
  v_leads_n := (v_deleted ->> 'leads')::integer;
  v_contacts_n := (v_deleted ->> 'contacts')::integer;

  -- erased from the audit log
  foreach v_id in array v_leads loop
    if public.audit_erase_request(p_org, 'leads', v_id, coalesce(p_person_request, true)) = -1 then
      v_paused := true;
    end if;
  end loop;
  foreach v_id in array v_contacts loop
    if public.audit_erase_request(p_org, 'contacts', v_id, coalesce(p_person_request, true)) = -1 then
      v_paused := true;
    end if;
  end loop;

  v_counts := v_counts || jsonb_build_object('leads', v_leads_n, 'contacts', v_contacts_n, 'inquiries', v_inquiries,
                                             'meetings', cardinality(v_meetings), 'deals_renamed', v_renamed);
  -- the action itself: no record id or name, only why and how much
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'person_erase', 'person_erase', null,
          jsonb_build_object('reason', v_reason, 'person_request', coalesce(p_person_request, true), 'counts', v_counts));

  return v_counts || jsonb_build_object('paused', v_paused);
end;
$$;
revoke all on function public.privacy_erase_person(uuid, text, uuid, jsonb, text, jsonb, boolean) from public, anon;
grant execute on function public.privacy_erase_person(uuid, text, uuid, jsonb, text, jsonb, boolean) to authenticated;
