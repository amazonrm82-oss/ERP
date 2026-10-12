-- =============================================================================
-- Editing and deleting a note: the author for 24 hours, then only an admin (REC-05)
-- =============================================================================
-- * activities_update / activities_delete: an owner or admin of a writable
--   organization may change or delete any entry, as before. Anyone else only an
--   entry they logged themselves (note, call, meeting, email, WhatsApp, SMS);
--   a refused change touches 0 rows, as RLS does.
-- * Delete: the author only within 24 hours of logging it (in the policy).
-- * Update: the author may pin and unpin their entry at any time (REC-01 as
--   shipped), but after 24 hours may change nothing else: trigger
--   activities_edit_window refuses any other column change by a user who is not
--   an owner/admin (42501, hint 'note:edit_window').
-- * The window counts from created_at, which a browser can no longer choose:
--   trigger activities_created_now stamps it on every insert by a signed-in
--   user (touch_row already keeps it on update). occurred_at stays editable.
-- * The audit log records an edit (body, occurred_at, metadata) or a delete made
--   by a user, with the record the entry belonged to (app.audit_activity()).
--   Server-side changes (conversion, merge, purge, erasure) run as the function
--   owner and are not logged here, exactly as before.
-- * public.audit_erase_record() also erases the entries of deleted activities of
--   the erased record, like its tasks and files (otherwise as in 0027).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- created_at is the server's clock
-- ----------------------------------------------------------------------------
create or replace function app.activities_created_now() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user in ('authenticated', 'anon') then
    new.created_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.activities_created_now() from public, anon, authenticated;

create or replace trigger activities_created_now before insert on public.activities
  for each row execute function app.activities_created_now();

-- ----------------------------------------------------------------------------
-- Policies
-- ----------------------------------------------------------------------------
-- alter, not drop and create: the policies exist since 0004 (rls.sql)
alter policy activities_update on public.activities
  using (app.can_write(organization_id)
         and (app.is_admin(organization_id)
              or (created_by = (select auth.uid())
                  and type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms'))))
  with check (app.can_write(organization_id));

-- after 24 hours only owners and admins change what an entry says; the author may still pin it
create or replace function app.activities_edit_window() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  -- columns the server stamps itself (touch_row), and the one the author may always change
  v_free constant text[] := array['is_pinned', 'updated_at'];
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user in ('authenticated', 'anon')
     and old.created_at <= now() - interval '24 hours'
     and (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free)
     and not app.is_admin(old.organization_id) then
    raise exception 'note edit window closed' using errcode = '42501', hint = 'note:edit_window';
  end if;
  return new;
end;
$$;
revoke all on function app.activities_edit_window() from public, anon, authenticated;

create or replace trigger activities_edit_window before update on public.activities
  for each row execute function app.activities_edit_window();

alter policy activities_delete on public.activities
  using (app.can_write(organization_id)
         and (app.is_admin(organization_id)
              or (created_by = (select auth.uid())
                  and created_at > now() - interval '24 hours'
                  and type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms'))));

-- ----------------------------------------------------------------------------
-- Audit log
-- ----------------------------------------------------------------------------
create or replace function app.audit_activity() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
begin
  if tg_op = 'DELETE' then
    if not app.org_exists(old.organization_id) then
      return null;
    end if;
    v_changes := v_old - 'updated_at';
  else
    v_new := to_jsonb(new);
    foreach v_key in array array['body', 'occurred_at', 'metadata'] loop
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    -- what the entry belongs to, so a privacy erasure of that record finds this entry too
    v_changes := v_changes || jsonb_strip_nulls(jsonb_build_object(
      'type', old.type, 'lead_id', old.lead_id, 'contact_id', old.contact_id,
      'company_id', old.company_id, 'deal_id', old.deal_id));
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (old.organization_id, auth.uid(), lower(tg_op), 'activities', old.id, v_changes);
  return null;
end;
$$;
revoke all on function app.audit_activity() from public, anon, authenticated;

-- only what a user does through the API; current_user is the function owner inside
-- conversion, merge, purge and erasure
create or replace trigger activities_audit_update after update on public.activities
  for each row
  when (current_user = 'authenticated'
        and (old.body is distinct from new.body
             or old.occurred_at is distinct from new.occurred_at
             or old.metadata is distinct from new.metadata))
  execute function app.audit_activity();

create or replace trigger activities_audit_delete after delete on public.activities
  for each row
  when (current_user = 'authenticated')
  execute function app.audit_activity();

-- ----------------------------------------------------------------------------
-- Privacy erasure covers deleted activities (as in 0027, plus 'activities')
-- ----------------------------------------------------------------------------
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

  -- tasks, files and activities that were linked to it and no longer exist
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities') and a.entity_id is not null
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

revoke all on function public.audit_erase_record(uuid, text, uuid) from public, anon;
grant execute on function public.audit_erase_record(uuid, text, uuid) to authenticated;
