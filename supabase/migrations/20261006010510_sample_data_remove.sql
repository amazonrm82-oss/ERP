-- =============================================================================
-- Sample data removal (USR-04)
-- =============================================================================
-- Kept apart from the setup checklist migration because the function body
-- holds a DELETE: the connector stops on it, so the owner pastes this file in
-- the SQL Editor. It needs that migration (app.sample_records, the helpers and
-- the guard trigger) to be there first.
--
-- public.sample_data_remove(org): owners and admins of a writable business.
-- In one transaction: lock the business row (like sample_data_add), lock every
-- noted record row (FOR UPDATE, so a colleague cannot link a note or a task to
-- it, or change it, until this ends), check each one again, then delete the
-- untouched ones: tasks and deals first, companies last. The delete fires the
-- usual triggers (audit, purge_links, record counter, outbox), and
-- app.sample_removal = 'on' makes the guard refuse any noted record that is
-- no longer untouched, also when a cascade reaches it. Automations do not
-- react (events marked as automation). Returns { removed, kept }.
-- Every statement is safe to run twice.

create or replace function public.sample_data_remove(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_note    record;
  v_type    text;
  v_ids     uuid[];
  v_before  integer;
  v_after   integer;
  v_kept    integer;
  v_prev_automation text := current_setting('app.automation_running', true);
  v_prev_removal    text := current_setting('app.sample_removal', true);
  v_table   constant jsonb := '{"task": "tasks", "deal": "deals", "lead": "leads", "contact": "contacts", "company": "companies"}';
begin
  if auth.uid() is null or p_org is null or not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;
  -- serializes add and remove per business without blocking ordinary inserts
  perform 1 from public.organizations o where o.id = p_org for no key update;

  for v_note in
    select app.sample_note_type(s) as t, coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) as id
      from app.sample_records s
     where s.organization_id = p_org
     order by s.created_at, s.id
  loop
    execute format('select 1 from public.%I where organization_id = $1 and id = $2 for update', v_table ->> v_note.t)
      using p_org, v_note.id;
  end loop;

  select count(*) into v_before from app.sample_records s where s.organization_id = p_org;

  perform set_config('app.sample_removal', 'on', true);
  perform set_config('app.automation_running', 'on', true);
  foreach v_type in array array['task', 'deal', 'lead', 'contact', 'company'] loop
    -- checked now, after the locks and after the previous types were removed
    select array_agg(coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id))
      into v_ids
      from app.sample_records s
     where s.organization_id = p_org
       and app.sample_note_type(s) = v_type
       and app.sample_untouched(p_org, v_type, coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id), s.snapshot);
    if v_ids is not null then
      execute format('delete from public.%I where organization_id = $1 and id = any ($2)', v_table ->> v_type)
        using p_org, v_ids;
    end if;
  end loop;
  perform set_config('app.automation_running', coalesce(v_prev_automation, ''), true);
  perform set_config('app.sample_removal', coalesce(v_prev_removal, ''), true);

  -- a deleted record takes its note with it (on delete cascade); what is left was kept
  select count(*) into v_after from app.sample_records s where s.organization_id = p_org;
  v_kept := v_after;
  return jsonb_build_object('removed', v_before - v_after, 'kept', v_kept);
end;
$$;
revoke all on function public.sample_data_remove(uuid) from public, anon;
grant execute on function public.sample_data_remove(uuid) to authenticated;
