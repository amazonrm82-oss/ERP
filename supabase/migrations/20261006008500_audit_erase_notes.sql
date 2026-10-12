-- =============================================================================
-- RVW-4: a privacy erasure reaches every edit of a deleted note, and a list
-- export keeps no text the user typed
-- =============================================================================
-- Notes (activities) have no insert entry in the audit log. Their entries
-- (an edit with old and new text since REC-05, a delete with the whole row)
-- carry the ids of the records the note was linked to at that moment. A note
-- can be linked to more records later: converting a lead links its notes to
-- the new contact and deal, a merge moves them to the kept record. The
-- erasure looked only at the ids inside the entries, so this path kept the old
-- text: a note on a lead is edited, the lead is converted, the lead is purged
-- and erased (the note still exists on the contact, so it is skipped), then
-- the contact and the deal are purged (the note goes with the last one) and
-- erased (the entry names only the lead).
--
-- * app.activity_audit_links (schema app, no API access): every record an
--   audited note was ever linked to, ids only. Filled by app.audit_activity()
--   (the links before and after the change), by trigger activities_audit_links
--   when the links of a note that already has entries change (conversion,
--   merge, an edit), and once here from the existing entries and the notes'
--   current links.
-- * public.audit_erase_record(): as in 0052, and a note that was ever linked to
--   the erased record and no longer exists has all its entries erased, found by
--   the note's id rather than by the ids inside the entries.
-- * public.log_list_export(): as in 0035, but only the shape of the filters is
--   kept (app.export_filters, an allow-list of keys): a search becomes q: true;
--   tag/status only as ids; who as mine/all; picked/ids as numbers; sort as a
--   column key; view/pipeline as an id, else true; any other key is left out.
--   An advanced filter keeps its structure, fields and operators of a known
--   shape, and a value only when it is shaped like an id, a number, a date or a
--   code word (never for contains / not contains / equals, whose value is typed
--   text); any other value becomes true. Existing export entries are not
--   rewritten here.
-- Every statement is safe to run twice.

create table if not exists app.activity_audit_links (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  activity_id     uuid not null,
  record_id       uuid not null,
  primary key (organization_id, activity_id, record_id)
);
create index if not exists activity_audit_links_record_idx on app.activity_audit_links (organization_id, record_id);
revoke all on app.activity_audit_links from public, anon, authenticated;

-- the records a note row is linked to, kept for the erasure
create or replace function app.remember_activity_links(p_org uuid, p_activity uuid, p_ids uuid[]) returns void
language sql volatile security definer
set search_path = ''
as $$
  insert into app.activity_audit_links (organization_id, activity_id, record_id)
  select p_org, p_activity, r from unnest(p_ids) as r where r is not null
  on conflict do nothing;
$$;
revoke all on function app.remember_activity_links(uuid, uuid, uuid[]) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Audit log of notes (as in 0067, plus the links)
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
    foreach v_key in array array['body', 'occurred_at', 'metadata', 'is_private'] loop
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
    -- links set in the same update (activities_audit_links runs before this entry exists)
    perform app.remember_activity_links(old.organization_id, old.id,
      array[new.lead_id, new.contact_id, new.company_id, new.deal_id]);
  end if;

  perform app.remember_activity_links(old.organization_id, old.id,
    array[old.lead_id, old.contact_id, old.company_id, old.deal_id]);

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (old.organization_id, auth.uid(), lower(tg_op), 'activities', old.id, v_changes);
  return null;
end;
$$;
revoke all on function app.audit_activity() from public, anon, authenticated;

-- a note that already has entries and is linked to another record (conversion,
-- merge, an edit): remember that record too. Runs for every caller, since
-- conversion and merge run as the function owner.
create or replace function app.audit_activity_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app.org_exists(new.organization_id) then
    return null;
  end if;
  if exists (select 1 from public.audit_log a
              where a.organization_id = new.organization_id and a.entity_type = 'activities' and a.entity_id = new.id) then
    perform app.remember_activity_links(new.organization_id, new.id,
      array[new.lead_id, new.contact_id, new.company_id, new.deal_id]);
  end if;
  return null;
end;
$$;
revoke all on function app.audit_activity_links() from public, anon, authenticated;

create or replace trigger activities_audit_links
  after update of lead_id, contact_id, company_id, deal_id on public.activities
  for each row
  when ((new.lead_id is not null and new.lead_id is distinct from old.lead_id)
        or (new.contact_id is not null and new.contact_id is distinct from old.contact_id)
        or (new.company_id is not null and new.company_id is distinct from old.company_id)
        or (new.deal_id is not null and new.deal_id is distinct from old.deal_id))
  execute function app.audit_activity_links();

-- what is known today: the ids in the existing entries of notes, and the
-- current links of the notes that still exist (new rows only)
insert into app.activity_audit_links (organization_id, activity_id, record_id)
select distinct a.organization_id, a.entity_id, (a.changes ->> k)::uuid
  from public.audit_log a
  cross join unnest(array['lead_id', 'contact_id', 'company_id', 'deal_id']) as k
 where a.entity_type = 'activities' and a.entity_id is not null
   and coalesce(a.changes ->> k, '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
on conflict do nothing;

insert into app.activity_audit_links (organization_id, activity_id, record_id)
select distinct ac.organization_id, ac.id, r
  from public.activities ac
  cross join unnest(array[ac.lead_id, ac.contact_id, ac.company_id, ac.deal_id]) as r
 where r is not null
   and exists (select 1 from public.audit_log a
                where a.organization_id = ac.organization_id and a.entity_type = 'activities' and a.entity_id = ac.id)
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Privacy erasure (as in 0052, plus notes ever linked to the record)
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

  -- tasks, files and notes that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
    union
    select 'activities', l.activity_id from app.activity_audit_links l
     where l.organization_id = p_org and l.record_id = p_id
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

-- ----------------------------------------------------------------------------
-- List export: only the shape of the filters, never typed text
-- ----------------------------------------------------------------------------
-- None of these raises, whatever the caller sends.

-- a value of a filter condition shaped like an id, a number, a date or a code word
create or replace function app.export_value_ok(p_text text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(
    p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_text ~ '^-?\d{1,15}(\.\d{1,6})?$'
    or p_text ~ '^\d{4}-\d{2}-\d{2}$'
    or p_text ~ '^[a-z0-9_]{1,40}$', false);
$$;

-- one filter value: kept when it is a string (or an array of up to 20 strings)
-- shaped like an id, a number, a date or a code word; anything else becomes
-- true ("a value was given"); no value stays no value
create or replace function app.export_filter_value(p_value jsonb, p_op text) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then null
    -- what these operators compare with is typed text
    when p_op in ('contains', 'not_contains', 'equals') then 'true'::jsonb
    when jsonb_typeof(p_value) = 'string' and app.export_value_ok(p_value #>> '{}') then p_value
    when jsonb_typeof(p_value) = 'array' then
      case when jsonb_array_length(p_value) between 1 and 20
                and not exists (select 1 from jsonb_array_elements(p_value) as v
                                 where jsonb_typeof(v) is distinct from 'string' or not app.export_value_ok(v #>> '{}'))
           then p_value else 'true'::jsonb end
    else 'true'::jsonb
  end;
$$;


-- An advanced filter (LST-05, `f`) as the list sends it: a JSON text or an
-- object {match, groups: [{match, conditions: [{field, op, value}]}]}. Kept:
-- the structure, fields and operators of a known shape, and values as above.
-- Anything unreadable becomes true ("a filter was used").
create or replace function app.export_filter_tree(p_tree jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_tree jsonb := p_tree;
  v_groups jsonb := '[]'::jsonb;
  v_conditions jsonb;
  v_group jsonb;
  v_cond jsonb;
  v_field text;
  v_op text;
begin
  if jsonb_typeof(v_tree) = 'string' then
    begin
      v_tree := (v_tree #>> '{}')::jsonb;
    exception when others then
      return 'true'::jsonb;
    end;
  end if;
  if jsonb_typeof(v_tree) is distinct from 'object' or jsonb_typeof(v_tree -> 'groups') is distinct from 'array' then
    return 'true'::jsonb;
  end if;
  for v_group in select g from jsonb_array_elements(v_tree -> 'groups') as g limit 5 loop
    v_conditions := '[]'::jsonb;
    if jsonb_typeof(v_group) = 'object' and jsonb_typeof(v_group -> 'conditions') = 'array' then
      for v_cond in select c from jsonb_array_elements(v_group -> 'conditions') as c limit 10 loop
        if jsonb_typeof(v_cond) is distinct from 'object' then
          continue;
        end if;
        v_field := case when jsonb_typeof(v_cond -> 'field') = 'string' then v_cond ->> 'field' end;
        v_op := case when jsonb_typeof(v_cond -> 'op') = 'string' then v_cond ->> 'op' end;
        v_conditions := v_conditions || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'field', case when v_field ~ '^[a-z0-9_:.-]{1,60}$' then to_jsonb(v_field) else 'true'::jsonb end,
          'op', case when v_op ~ '^[a-z_]{1,30}$' then to_jsonb(v_op) else 'true'::jsonb end,
          'value', app.export_filter_value(v_cond -> 'value', v_op))));
      end loop;
    end if;
    v_groups := v_groups || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'match', case when v_group ->> 'match' in ('all', 'any') then v_group -> 'match' end,
      'conditions', v_conditions)));
  end loop;
  return jsonb_strip_nulls(jsonb_build_object(
    'match', case when v_tree ->> 'match' in ('all', 'any') then v_tree -> 'match' end,
    'groups', v_groups));
end;
$$;

-- the filters of an export, by an allow-list of keys; every other key is left out
create or replace function app.export_filters(p_filters jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_text text;
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if jsonb_typeof(p_filters) is distinct from 'object' then
    return '{}'::jsonb;
  end if;
  for v_key, v_value in select e.key, e.value from jsonb_each(p_filters) as e loop
    v_text := case when jsonb_typeof(v_value) = 'string' then v_value #>> '{}' end;
    case v_key
      -- the search box: only that a search was used
      when 'q' then
        if coalesce(v_text, '') <> '' or jsonb_typeof(v_value) = 'boolean' and v_value = 'true'::jsonb then
          v_out := v_out || jsonb_build_object('q', true);
        end if;
      when 'f' then
        v_out := v_out || jsonb_build_object('f', app.export_filter_tree(v_value));
      when 'tag', 'status' then
        if v_text ~ v_uuid then
          v_out := v_out || jsonb_build_object(v_key, v_value);
        end if;
      when 'who' then
        if v_text in ('mine', 'all') then
          v_out := v_out || jsonb_build_object(v_key, v_value);
        end if;
      when 'picked', 'ids' then
        if jsonb_typeof(v_value) = 'number' then
          v_out := v_out || jsonb_build_object(v_key, v_value);
        end if;
      when 'sort' then
        if v_text ~ '^[a-z0-9_:.-]{1,60}$' then
          v_out := v_out || jsonb_build_object(v_key, v_value);
        end if;
      -- a saved view or a pipeline: its id; a name becomes true
      when 'view', 'pipeline' then
        if v_text ~ v_uuid then
          v_out := v_out || jsonb_build_object(v_key, v_value);
        elsif coalesce(v_text, '') <> '' then
          v_out := v_out || jsonb_build_object(v_key, true);
        end if;
      else
        null;
    end case;
  end loop;
  return v_out;
end;
$$;

revoke all on function app.export_value_ok(text) from public, anon, authenticated;
revoke all on function app.export_filter_value(jsonb, text) from public, anon, authenticated;
revoke all on function app.export_filter_tree(jsonb) from public, anon, authenticated;
revoke all on function app.export_filters(jsonb) from public, anon, authenticated;

create or replace function public.log_list_export(
  p_org uuid,
  p_object text,
  p_format text,
  p_rows integer,
  p_scope text,
  p_filters jsonb
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
  v_table text := case p_object when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                when 'deal' then 'deals' when 'task' then 'tasks' end;
begin
  if v_role is null or v_role not in ('owner', 'admin', 'manager') then
    raise exception 'export is for owners, admins and team managers' using errcode = '42501';
  end if;
  if v_table is null or p_format not in ('csv', 'xlsx') or p_scope not in ('filtered', 'selected')
     or p_rows is null or p_rows < 0 or p_rows > 1000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export', v_table, null,
    jsonb_build_object('format', p_format, 'rows', p_rows, 'scope', p_scope)
      -- the filters as the list had them, without typed text; left out when they
      -- are not an object or too large to keep
      || case when jsonb_typeof(p_filters) = 'object' and pg_column_size(p_filters) <= 8192
              then jsonb_build_object('filters', app.export_filters(p_filters)) else '{}'::jsonb end
  );
end;
$$;

revoke all on function public.log_list_export(uuid, text, text, integer, text, jsonb) from public, anon;
grant execute on function public.log_list_export(uuid, text, text, integer, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
