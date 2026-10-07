-- 20261006002300_invitation_preview: part 1 of 1. Run the parts in order.
-- =============================================================================
-- 0023 What an invitation is for, before joining
-- =============================================================================
-- public.invitation_preview(token): for the signed-in holder of an invitation
-- link, the business name, the role, who invited, until when, and whether it was
-- sent to the caller's email. Nothing without the exact token (only its SHA-256
-- is stored), and the invited address is shown masked.
-- Every statement is safe to run twice.

create or replace function public.invitation_preview(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_inv   public.invitations%rowtype;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_inv from public.invitations i
   where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  if not found then
    return null;
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  return jsonb_build_object(
    'organization_name', (select o.name from public.organizations o where o.id = v_inv.organization_id and o.deleted_at is null),
    'role', v_inv.role,
    'invited_by', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = v_inv.invited_by),
    'expires_at', v_inv.expires_at,
    'status', case when v_inv.accepted_at is not null then 'accepted'
                   when v_inv.revoked_at is not null then 'revoked'
                   when v_inv.expires_at <= now() then 'expired'
                   else 'valid' end,
    'for_me', v_email = v_inv.email,
    -- d•••@example.com
    'email_hint', left(v_inv.email, 1) || '•••' || substr(v_inv.email, strpos(v_inv.email, '@')),
    'already_member', exists (select 1 from public.memberships m where m.organization_id = v_inv.organization_id and m.user_id = auth.uid()));
end;
$$;

revoke all on function public.invitation_preview(text) from public, anon;
grant execute on function public.invitation_preview(text) to authenticated;
