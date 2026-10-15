-- =============================================================================
-- Deal contact roles: the old role text is server-only for people (CON-03 review follow-ups)
-- =============================================================================
-- Review of CON-03 (migration deal_contact_roles_list), two Low findings:
--
-- 1. deal_contacts.role (the old code) could still be written by a person: the column grant
--    `update (role)` and the table-wide insert grant remain, and app.deal_contact_role_check returned
--    early when role_id did not change. So a person could set role = 'finance' with role_id null, and
--    the key fallback then showed that role even when the business had hidden it. Now a person's write
--    (current_user = 'authenticated') that puts a non-null code into `role` is refused (hint
--    'deal_contact_role:invalid'): on insert any non-null value, on update a value different from the
--    row's. Clearing it to null stays allowed, and so does an update that leaves it as it is. The grant
--    `update (role)` stays: the app clears the code with `role: null` when a person clears the role of a
--    link saved before the list (role_id stays null there, so the trigger would not clear it).
--    Someone who is not a member of the organization is let through to RLS's plain refusal first.
-- 2. Re-picking the role a link saved before the list already shows failed when that default had been
--    hidden: the link shows the role whose key equals its code, saving sends that role's id, and the
--    trigger refused an inactive role. A person may now pick an inactive role of the same organization
--    when its key equals the code the link had (old.role).
--
-- Server writes (merge, sample data, the foreign key's set null) are unchanged. No existing row is
-- changed. Every statement is safe to run twice. No deletes, no drops.

create or replace function app.deal_contact_role_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_old_code text;
begin
  -- security invoker on purpose: current_user tells a person's write from the server's (a deleted role
  -- clears role_id through the foreign key, run as the table owner)
  if current_user = 'authenticated' and app.is_member(new.organization_id)
     and new.role is not null
     and (tg_op = 'INSERT' or new.role is distinct from old.role) then
    raise exception 'pick the role from the list' using errcode = 'P0001', hint = 'deal_contact_role:invalid';
  end if;

  if tg_op = 'UPDATE' and new.role_id is not distinct from old.role_id then
    return new;
  end if;
  if tg_op = 'INSERT' and new.role_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    v_old_code := old.role;
  end if;
  -- the list's role replaces the old code
  new.role := null;
  if new.role_id is not null and current_user = 'authenticated'
     and not exists (select 1 from public.deal_contact_roles r
                      where r.organization_id = new.organization_id and r.id = new.role_id
                        and (r.is_active or (v_old_code is not null and r.key = v_old_code))) then
    raise exception 'this role is not on the list' using errcode = 'P0001', hint = 'deal_contact_role:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.deal_contact_role_check() from public, anon, authenticated;

notify pgrst, 'reload schema';
