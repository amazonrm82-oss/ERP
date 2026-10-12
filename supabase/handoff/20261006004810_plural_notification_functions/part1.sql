-- 20261006004810_plural_notification_functions: part 1 of 2. Run the parts in order.
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
