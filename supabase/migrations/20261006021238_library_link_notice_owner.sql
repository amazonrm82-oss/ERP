-- =============================================================================
-- 021238 LIB-02: the first-opening notice when the maker cannot be told (owner, 12 November 2026, answer (299) ב)
-- =============================================================================
-- The first opening of a tracked library link tells, in this order:
-- * the link's maker, while an active member who reads the record (unchanged, 021230);
-- * else the record's CURRENT owner (owner_id of the lead, contact, company or deal), while an active member who is not
--   a viewer and reads the record (app.user_can_read_record); the item's title only, as before;
-- * else the active owners and admins of the business (021230's (296) ג).
-- app.library_link_mark_viewed is 021230's body with the record row read before the maker's check and the owner branch
-- added; nothing else changes (the view count, the one timeline entry a business day, the first-opening rule).
-- Safe to run twice. No drop statement, no row removal.

create or replace function app.library_link_mark_viewed(p_link public.library_links) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_today date := app.library_today(p_link.organization_id);
  v_told uuid;
  v_record record;
  v_owner uuid;
  v_team uuid;
  v_title text;
  v_views integer;
  v_maker boolean := false;
  v_rep uuid;
begin
  update public.library_links l
     set view_count = l.view_count + 1, first_viewed_at = coalesce(l.first_viewed_at, now()), last_viewed_at = now()
   where l.organization_id = p_link.organization_id and l.id = p_link.id
  returning l.view_count into v_views;
  v_record := app.library_link_record(p_link);
  select i.title into v_title from public.library_items i where i.organization_id = p_link.organization_id and i.id = p_link.library_item_id;
  -- (292) ב: one timeline entry a business day, even when two views arrive together (notified_on = the day last written)
  update app.library_link_secrets s set notified_on = v_today
   where s.link_id = p_link.id and s.notified_on is distinct from v_today
  returning s.link_id into v_told;
  if v_told is not null then
    insert into public.activities (organization_id, type, lead_id, contact_id, company_id, deal_id, body, metadata, created_by)
    values (p_link.organization_id, 'system', p_link.lead_id, p_link.contact_id, p_link.company_id, p_link.deal_id,
            'הלקוח פתח את הקישור מהספרייה: ' || coalesce(v_title, 'פריט'),
            jsonb_build_object('kind', 'library_viewed', 'library_link_id', p_link.id), null);
  end if;
  -- (292) ב: the rep is told only on the first opening (the row lock above orders two first views: only one sees 1)
  if v_views is distinct from 1 then
    return;
  end if;
  -- the record's current owner and team (the maker's check and (299)'s current owner read the same row)
  if v_record.record_type = 'lead' then
    select r.owner_id, r.team_id into v_owner, v_team from public.leads r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  elsif v_record.record_type = 'contact' then
    select r.owner_id, r.team_id into v_owner, v_team from public.contacts r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  elsif v_record.record_type = 'company' then
    select r.owner_id, r.team_id into v_owner, v_team from public.companies r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  else
    select r.owner_id, r.team_id into v_owner, v_team from public.deals r where r.organization_id = p_link.organization_id and r.id = v_record.record_id;
  end if;
  if p_link.created_by is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_link.organization_id and m.user_id = p_link.created_by and m.status = 'active') then
    -- the rep still reads the record (the notice opens it)
    v_maker := coalesce(app.user_can_read_record(p_link.organization_id, p_link.created_by, v_owner, v_team), false)
            or app.user_deputy_reads(p_link.organization_id, p_link.created_by, v_record.record_type, v_record.record_id);
  end if;
  -- (299) ב: else the record's current owner, while an active member who is not a viewer and reads the record
  if not v_maker and v_owner is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_link.organization_id and m.user_id = v_owner
                    and m.status = 'active' and m.role <> 'viewer')
     and coalesce(app.user_can_read_record(p_link.organization_id, v_owner, v_owner, v_team), false) then
    v_rep := v_owner;
  end if;
  if v_maker then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (p_link.organization_id, p_link.created_by, 'library_viewed', 'הלקוח פתח את הקישור ששלחת מהספרייה',
            -- no personal data: a later privacy erasure does not reach notification bodies
            v_title, v_record.record_type, v_record.record_id);
  elsif v_rep is not null then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (p_link.organization_id, v_rep, 'library_viewed', 'הלקוח פתח קישור שנשלח מהספרייה',
            v_title, v_record.record_type, v_record.record_id);
  else
    -- (296) ג: the maker left or no longer reads the record, and the record has no usable owner (299): the active owners
    -- and admins are told instead
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    select p_link.organization_id, m.user_id, 'library_viewed', 'הלקוח פתח קישור שנשלח מהספרייה',
           v_title, v_record.record_type, v_record.record_id
      from public.memberships m
     where m.organization_id = p_link.organization_id and m.status = 'active' and m.role in ('owner', 'admin');
  end if;
end;
$$;
revoke all on function app.library_link_mark_viewed(public.library_links) from public, anon, authenticated, service_role;
