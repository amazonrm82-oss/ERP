-- =============================================================================
-- A merge moves followers and further phones / emails (follow-ups of REC-03, CON-01)
-- =============================================================================
-- app.merge_move_links() (called by public.merge_records() after the picks and
-- before the duplicate is deleted) now also moves:
-- * record_followers (REC-03, 0104): the duplicate's followers follow the kept
--   record when they may read it (app.user_can_read_record() with the kept
--   record's owner and team). A user who follows both keeps their row on the kept
--   record; their row on the duplicate, and the row of a follower who may not read
--   the kept record, stay where they are and go with the duplicate (on delete
--   cascade), so no row is doubled and nothing is deleted here.
-- * contact_channels (CON-01, 0108), for two contacts:
--   - the duplicate's further phones and emails move to the kept contact, after
--     its own ones, except values the kept contact already has (as a further one
--     or as its primary); those stay on the duplicate and go with it;
--   - the duplicate's primary phone and email become further ones of the kept
--     contact (with their type) when they differ from what the kept contact has.
--     A primary that does not validate (a phone with no digits, a bad email) is
--     not copied.
--   A merge may leave more than 10 of a kind: the limit is for a person's insert.
--   Moved and added channels are written to the kept contact's history (the
--   audit trigger now logs a row that moved to another contact as an addition).
--   Known follow-up: when a pick takes the duplicate's primary phone or email,
--   the kept contact's previous one is still lost, as before. Keeping it needs
--   merge_records() to pass the row as it was before the picks, which means
--   redefining merge_records() (it holds a DELETE: a hand-pasted migration).
-- * deal_contacts: the same as before (one row per deal), now done by moving the
--   rows that do not clash; the clashing ones go with the duplicate (cascade), so
--   the function holds no DELETE and can be applied through the connector.
-- The temporary trigger activities_merge_contact_channels (0108) copied the
-- channels when the "merged" timeline entry was written; its function is now a
-- no-op (the trigger stays, so the migration needs no drop).
-- Every other line of merge_move_links() is as in 0053e. Safe to run twice.

-- ----------------------------------------------------------------------------
-- Audit: a channel that moves to another contact is an addition on that contact
-- ----------------------------------------------------------------------------
-- As in 0108, plus the contact_id case (only merge_move_links() moves a channel;
-- clients have no update grant on contact_id).
create or replace function app.audit_contact_channel() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_contact uuid;
  v_kind text;
  v_old text;
  v_new text;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_contact := old.contact_id;
    v_kind := old.kind;
  else
    v_org := new.organization_id;
    v_contact := new.contact_id;
    v_kind := new.kind;
  end if;
  -- gone together with the contact (purge, merge, the organization): the
  -- contact's own entry covers it
  if not exists (select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact) then
    return null;
  end if;
  -- moved here from another contact (a merge): new on this contact
  if tg_op = 'UPDATE' and old.contact_id is distinct from new.contact_id then
    v_old := null;
  elsif tg_op <> 'INSERT' then
    v_old := app.contact_channel_text(old.kind, old.label, old.value);
  end if;
  if tg_op <> 'DELETE' then
    v_new := app.contact_channel_text(new.kind, new.label, new.value);
  end if;
  -- a new position alone is not a change worth a line
  if v_old is not distinct from v_new then
    return null;
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), 'update', 'contacts', v_contact,
          jsonb_build_object(case v_kind when 'phone' then 'extra_phone' else 'extra_email' end,
                             jsonb_build_object('old', to_jsonb(v_old), 'new', to_jsonb(v_new))));
  return null;
end;
$$;
revoke all on function app.audit_contact_channel() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Contacts: phones and emails of the duplicate
-- ----------------------------------------------------------------------------
create or replace function app.merge_contact_channels_move(p_org uuid, p_keep uuid, p_merge uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_keep public.contacts%rowtype;
  v_dup public.contacts%rowtype;
  v_next integer;
begin
  select * into v_keep from public.contacts c where c.organization_id = p_org and c.id = p_keep;
  select * into v_dup from public.contacts c where c.organization_id = p_org and c.id = p_merge;
  if v_keep.id is null or v_dup.id is null or p_keep = p_merge then
    return;
  end if;

  select coalesce(max(ch.position), -1) + 1 into v_next
    from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_keep;

  -- the duplicate's primary ones
  insert into public.contact_channels (organization_id, contact_id, kind, label, value, position)
  select p_org, p_keep, x.kind, x.label, x.value, least(v_next + (row_number() over (order by x.ord))::integer - 1, 1000)
    from (
      select 0 as ord, 'phone' as kind, coalesce(v_dup.phone_type, 'other') as label, btrim(v_dup.phone) as value
       where v_dup.phone_e164 is not null and char_length(btrim(v_dup.phone)) between 1 and 254
      union all
      select 1, 'email', coalesce(v_dup.email_type, 'other'), lower(btrim(v_dup.email))
       where lower(btrim(v_dup.email)) like '_%@_%._%' and btrim(v_dup.email) !~ '[[:space:]]'
         and char_length(btrim(v_dup.email)) <= 254
    ) x
   -- not the kept contact's primary ones (as they are now, after the picks)
   where not (x.kind = 'phone' and app.normalize_phone(x.value) is not distinct from v_keep.phone_e164)
     and not (x.kind = 'email' and x.value is not distinct from lower(btrim(v_keep.email)))
  on conflict do nothing;

  select coalesce(max(ch.position), -1) + 1 into v_next
    from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_keep;

  -- the duplicate's further ones move, except values the kept contact has already
  -- (those stay on the duplicate and go with it)
  update public.contact_channels ch
     set contact_id = p_keep, position = least(v_next + s.rn - 1, 1000)
    from (
      select d.id, (row_number() over (order by d.kind, d.position, d.id))::integer as rn
        from public.contact_channels d
       where d.organization_id = p_org and d.contact_id = p_merge
         and not (d.kind = 'phone' and d.value_e164 is not distinct from v_keep.phone_e164)
         and not (d.kind = 'email' and d.value is not distinct from lower(btrim(v_keep.email)))
         and not exists (select 1 from public.contact_channels k
                          where k.organization_id = p_org and k.contact_id = p_keep and k.kind = d.kind
                            and coalesce(k.value_e164, k.value) = coalesce(d.value_e164, d.value))
    ) s
   where ch.id = s.id and ch.organization_id = p_org and ch.contact_id = p_merge;
end;
$$;
revoke all on function app.merge_contact_channels_move(uuid, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Merging records: followers and channels follow the kept record
-- ----------------------------------------------------------------------------
-- Same body as in 0053e, plus the followers and channels lines, and deal_contacts
-- moved without a DELETE.
create or replace function app.merge_move_links(p_org uuid, p_type text, p_keep uuid, p_merge uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_col text := p_type || '_id';
  v_owner uuid;
  v_team uuid;
begin
  execute format('update public.activities set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.tasks set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.files set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.meetings set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  update public.notifications set entity_id = p_keep where organization_id = p_org and entity_id = p_merge;
  -- followers who may read the kept record, one row per user; a row that would
  -- clash, or whose user may not read the kept record, stays and goes with the duplicate
  execute format('select owner_id, team_id from public.%I where organization_id = $1 and id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end)
    into v_owner, v_team using p_org, p_keep;
  execute format(
    'update public.record_followers f set %1$I = $1
      where f.organization_id = $2 and f.%1$I = $3
        and app.user_can_read_record($2, f.user_id, $4, $5)
        and not exists (select 1 from public.record_followers k
                         where k.organization_id = $2 and k.user_id = f.user_id and k.%1$I = $1)', v_col)
    using p_keep, p_org, p_merge, v_owner, v_team;

  if p_type = 'lead' then
    update public.form_submissions set lead_id = p_keep where organization_id = p_org and lead_id = p_merge;
  elsif p_type = 'contact' then
    update public.deals set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
    -- one row per deal: a row that would clash stays and goes with the duplicate
    update public.deal_contacts dc set contact_id = p_keep
     where dc.organization_id = p_org and dc.contact_id = p_merge
       and not exists (select 1 from public.deal_contacts k where k.deal_id = dc.deal_id and k.contact_id = p_keep);
    update public.leads set converted_contact_id = p_keep where organization_id = p_org and converted_contact_id = p_merge;
    perform app.merge_contact_channels_move(p_org, p_keep, p_merge);
  elsif p_type = 'company' then
    update public.contacts set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.deals set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.leads set converted_company_id = p_keep where organization_id = p_org and converted_company_id = p_merge;
    update public.companies set parent_company_id = case when id = p_keep then null else p_keep end
     where organization_id = p_org and parent_company_id = p_merge;
  end if;
end;
$$;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The temporary copy on the "merged" timeline entry (0108) is no longer needed
-- ----------------------------------------------------------------------------
-- The trigger activities_merge_contact_channels stays (no drop); it does nothing.
create or replace function app.merge_contact_channels() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  return null;
end;
$$;
revoke all on function app.merge_contact_channels() from public, anon, authenticated;
