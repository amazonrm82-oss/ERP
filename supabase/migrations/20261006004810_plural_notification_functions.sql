-- =============================================================================
-- 0048 part 2: plural wording in the notifications two functions write (FXU-09)
-- =============================================================================
-- app.reset_user_mfa and public.transfer_records are re-created unchanged except
-- for the wording of their notification ("מנהל מערכת" in full, FXU-08).
-- Every statement is safe to run twice.

create or replace function app.reset_user_mfa(p_user uuid, p_by text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  delete from auth.mfa_factors where user_id = p_user;
  delete from app.mfa_recovery_codes where user_id = p_user;
  delete from app.mfa_recovery_attempts where user_id = p_user;
  -- signed out everywhere: whoever holds a session now must sign in again
  delete from auth.sessions where user_id = p_user;

  select coalesce(nullif(p.full_name, ''), u.email) into v_name
    from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  select m.organization_id, auth.uid(), 'mfa_reset', 'memberships', m.id, jsonb_build_object('by', p_by)
    from public.memberships m
   where m.user_id = p_user and m.status = 'active';

  -- the user, and the owners and admins of their organizations
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, a.user_id, 'system',
         case when a.user_id = p_user then 'האימות הדו-שלבי בחשבון שלכם אופס'
              else 'האימות הדו-שלבי של ' || v_name || ' אופס' end,
         case when p_by = 'support' then 'האיפוס בוצע על ידי צוות התמיכה.' else 'האיפוס בוצע על ידי מנהל מערכת בעסק.' end
           || ' אם לא ביקשתם את זה, פנו מייד לתמיכה.'
    from public.memberships m
    join public.memberships a on a.organization_id = m.organization_id and a.status = 'active'
                              and (a.user_id = p_user or a.role in ('owner', 'admin'))
   where m.user_id = p_user and m.status = 'active'
     and a.user_id is distinct from auth.uid();
end;
$$;
revoke all on function app.reset_user_mfa(uuid, text) from public, anon, authenticated;

create or replace function public.transfer_records(p_org uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_leads int; v_contacts int; v_companies int; v_deals int; v_tasks int;
  v_from_name text;
begin
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if p_from = p_to then
    raise exception 'the same person' using errcode = '22023';
  end if;
  if not exists (select 1 from public.memberships m where m.organization_id = p_org and m.user_id = p_from) then
    raise exception 'not a member' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = p_to and m.status = 'active' and m.role <> 'viewer') then
    raise exception 'the new owner must be an active user who can edit' using errcode = 'P0001', hint = 'transfer:target';
  end if;

  perform set_config('app.bulk_transfer', 'on', true);
  perform set_config('app.automation_running', 'on', true);

  update public.leads set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_leads = row_count;
  update public.contacts set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_contacts = row_count;
  update public.companies set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_companies = row_count;
  update public.deals set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_deals = row_count;
  update public.tasks set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_tasks = row_count;

  perform set_config('app.bulk_transfer', 'off', true);
  perform set_config('app.automation_running', 'off', true);

  select coalesce(nullif(p.full_name, ''), p.email) into v_from_name from public.profiles p where p.id = p_from;
  if v_leads + v_contacts + v_companies + v_deals + v_tasks > 0 and p_to is distinct from auth.uid() then
    insert into public.notifications (organization_id, user_id, type, title, body)
    values (p_org, p_to, 'assigned', 'הועברו אליכם רשומות של ' || coalesce(v_from_name, 'משתמש'),
            format('%s לידים, %s אנשי קשר, %s חברות, %s עסקאות ו-%s משימות.', v_leads, v_contacts, v_companies, v_deals, v_tasks));
  end if;

  return jsonb_build_object('leads', v_leads, 'contacts', v_contacts, 'companies', v_companies, 'deals', v_deals, 'tasks', v_tasks);
end;
$$;

revoke all on function public.transfer_records(uuid, uuid, uuid) from public, anon;
grant execute on function public.transfer_records(uuid, uuid, uuid) to authenticated;
