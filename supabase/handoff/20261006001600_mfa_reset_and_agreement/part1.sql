-- 20261006001600_mfa_reset_and_agreement: part 1 of 5. Run the parts in order.
-- =============================================================================
-- 0016 Two-step verification reset, and the signed agreement
-- =============================================================================
-- Reset, for a user who lost both the authenticator and the backup codes:
-- * public.org_reset_member_mfa(org, user): the organization's owner or an admin,
--   in a session that passed two-step verification, resets a member they manage
--   (only the owner resets an admin). Only when the member belongs to no other
--   organization: one business must not weaken a user's security in another.
-- * public.platform_reset_mfa(user, reason, check): platform support, for everyone
--   else (an owner, a user of several businesses), after checking identity by one
--   of the listed methods. Written to the permanent platform log.
-- * Both remove the authenticator and the backup codes, sign the user out of every
--   device, write to the audit log of each of the user's organizations, and notify
--   the user and the organizations' owners and admins.
-- Agreement:
-- * app.agreement_signatures: each user signs the terms, privacy policy and data
--   processing agreement before using the product, and again when they change.
--   The row keeps the full text that was signed, its SHA-256, the signature (drawn
--   image or typed name), time, IP and browser. It cannot be changed or deleted
--   through the API. public.sign_agreement() writes it; public.my_agreement() and
--   public.agreement_status() read it.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Two-step verification reset
-- ----------------------------------------------------------------------------
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
         case when a.user_id = p_user then 'האימות הדו-שלבי בחשבון שלך אופס'
              else 'האימות הדו-שלבי של ' || v_name || ' אופס' end,
         case when p_by = 'support' then 'האיפוס בוצע על ידי צוות התמיכה.' else 'האיפוס בוצע על ידי מנהל בעסק.' end
           || ' אם לא ביקשתם את זה, פנו מייד לתמיכה.'
    from public.memberships m
    join public.memberships a on a.organization_id = m.organization_id and a.status = 'active'
                              and (a.user_id = p_user or a.role in ('owner', 'admin'))
   where m.user_id = p_user and m.status = 'active'
     and a.user_id is distinct from auth.uid();
end;
$$;
