-- =============================================================================
-- Bank details of the business, for owners and admins only (TAX-02 follow-up)
-- =============================================================================
-- Owner's decision, 13 October 2026: the bank details printed on quotes and
-- payment requests are read and written only by owners and admins, enforced
-- here and not only on the screen. Column grants cannot depend on the role, so
-- they live in their own table, apart from org_document_settings:
-- public.org_bank_details, at most one row per organization:
--   bank_name (1..80), bank_branch (1..4 digits), bank_account (2..20 digits),
--   bank_account_name (1..120); an account number needs its bank and branch.
-- * Owners and admins select, insert, update and delete it while the
--   organization is writable (select also while read-only: they keep seeing
--   it). Members, managers and viewers get no row at all.
-- * Audit (who and when) through app.org_bank_details_audit(), not the generic
--   app.audit_row(): the account number is stored masked, last 4 digits only
--   ('****1234'; the last 2 for a number under 8 digits), old and new, never
--   the full number. Value checks are a trigger, so no error shows the number.
-- * Every change (insert, update, delete) notifies every active owner and
--   admin of the organization, the actor included, with kind 'system' (never
--   mutable, no new kind): "פרטי הבנק של העסק שונו על ידי <profile name, else משתמש>", no
--   number and never the email; it links to /settings/documents.
-- * Everyone else sees the bank details only inside a document they may read.
--   Rule for the quote and document tables (QUO, DOC): a document stores
--   app.document_bank_snapshot(org) in its own jsonb column when it is made,
--   filled by its insert trigger (security definer) or by server code, exactly
--   as it stores its VAT rate (app.document_vat_rate). A later change of the
--   bank details never changes a document that was already made, and issuing a
--   document works for everyone allowed to issue one. The snapshot function is
--   security definer and granted to service_role only: no client calls it.
-- * Read-only / suspended organization: owners and admins still read; nothing
--   changes. Handover, merge: not involved. Full export: yes (the export runs
--   with the owner's session), bank_details.csv.
-- Every statement is safe to run twice.

create table if not exists public.org_bank_details (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  -- checked by trigger org_bank_details_check, not by CHECK constraints (see below)
  bank_name         text,
  bank_branch       text,
  bank_account      text,
  bank_account_name text,
  updated_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

comment on table public.org_bank_details is
  'TAX-02 follow-up: bank details for a transfer; owners/admins only. Documents keep app.document_bank_snapshot() when made.';

create or replace trigger org_bank_details_touch before insert or update on public.org_bank_details
  for each row execute function app.touch_row();

-- The value checks are a BEFORE trigger and not CHECK constraints on purpose:
-- a failing constraint (or NOT NULL) reports "Failing row contains (...)" with
-- every value, the full account number included, and that text can reach the
-- server logs. This raises P0001 with hint 'bank:invalid' and no value at all.
-- BEFORE triggers run before the table's constraints, and _check sorts before
-- _touch, so it runs first. Mirrored by bankDetailsSchema
-- (src/features/tax/schema.ts).
create or replace function app.org_bank_details_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is null
     or (new.bank_name is not null and char_length(btrim(new.bank_name)) not between 1 and 80)
     or (new.bank_branch is not null and new.bank_branch !~ '^[0-9]{1,4}$')
     or (new.bank_account is not null and new.bank_account !~ '^[0-9]{2,20}$')
     or (new.bank_account_name is not null and char_length(btrim(new.bank_account_name)) not between 1 and 120)
     or (new.bank_account is not null and (new.bank_name is null or new.bank_branch is null)) then
    raise exception 'bank details are not valid' using errcode = 'P0001', hint = 'bank:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.org_bank_details_check() from public, anon, authenticated;

create or replace trigger org_bank_details_check before insert or update on public.org_bank_details
  for each row execute function app.org_bank_details_check();

alter table public.org_bank_details enable row level security;
revoke all on public.org_bank_details from anon, authenticated;
grant select, delete on public.org_bank_details to authenticated;
grant insert (organization_id, bank_name, bank_branch, bank_account, bank_account_name)
  on public.org_bank_details to authenticated;
grant update (bank_name, bank_branch, bank_account, bank_account_name)
  on public.org_bank_details to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_bank_details' and policyname = 'org_bank_details_select') then
    create policy org_bank_details_select on public.org_bank_details for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_bank_details' and policyname = 'org_bank_details_insert') then
    create policy org_bank_details_insert on public.org_bank_details for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_bank_details' and policyname = 'org_bank_details_update') then
    create policy org_bank_details_update on public.org_bank_details for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_bank_details' and policyname = 'org_bank_details_delete') then
    create policy org_bank_details_delete on public.org_bank_details for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- '****1234': the last 4 digits only; a number shorter than 8 digits shows
-- its last 2 ('****34'), so a short number is not almost all visible. Null
-- stays null. Used by the audit trigger only; no client calls it.
create or replace function app.mask_bank_account(p_account text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_account is null then null
    when char_length(p_account) < 8 then '****' || right(p_account, 2)
    else '****' || right(p_account, 4)
  end
$$;
revoke all on function app.mask_bank_account(text) from public, anon, authenticated;
grant execute on function app.mask_bank_account(text) to service_role;

-- ----------------------------------------------------------------------------
-- Audit (masked) and notice to every owner and admin
-- ----------------------------------------------------------------------------
create or replace function app.org_bank_details_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_org uuid;
  v_action text;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_name text;
begin
  if tg_op <> 'INSERT' then
    v_old := to_jsonb(old) || jsonb_build_object('bank_account', app.mask_bank_account(old.bank_account));
  end if;
  if tg_op <> 'DELETE' then
    v_new := to_jsonb(new) || jsonb_build_object('bank_account', app.mask_bank_account(new.bank_account));
  end if;
  v_org := coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid;

  if tg_op = 'DELETE' then
    -- nothing to attach the entry to when the organization itself is going away
    if not app.org_exists(v_org) then
      return null;
    end if;
    v_action := 'delete';
  else
    v_action := lower(tg_op);
  end if;
  for v_key in select k from unnest(array['bank_name', 'bank_branch', 'bank_account', 'bank_account_name']) k loop
    if (v_new -> v_key) is distinct from (v_old -> v_key) then
      v_changes := v_changes || jsonb_build_object(v_key,
        jsonb_build_object('old', coalesce(v_old -> v_key, 'null'::jsonb), 'new', coalesce(v_new -> v_key, 'null'::jsonb)));
    end if;
  end loop;
  if tg_op = 'UPDATE' and v_changes = '{}'::jsonb then
    return null;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), v_action, tg_table_name, coalesce(v_new ->> 'id', v_old ->> 'id')::uuid, v_changes);

  -- the profile name, never the email; a fixed word when there is none
  select nullif(btrim(p.full_name), '') into v_name
    from public.profiles p
   where p.id = auth.uid();

  -- entity org_bank_details links the notice to /settings/documents (notificationHref)
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  select v_org, m.user_id, 'system', 'פרטי הבנק של העסק שונו על ידי ' || coalesce(v_name, 'משתמש'),
         'org_bank_details', coalesce(v_new ->> 'id', v_old ->> 'id')::uuid
    from public.memberships m
   where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'admin');
  return null;
end;
$$;
revoke all on function app.org_bank_details_audit() from public, anon, authenticated;

create or replace trigger org_bank_details_audit after insert or update or delete on public.org_bank_details
  for each row execute function app.org_bank_details_audit();

-- ----------------------------------------------------------------------------
-- What a document keeps: the bank details at the time it is made
-- ----------------------------------------------------------------------------
-- {bank_name, bank_branch, bank_account, bank_account_name}, or null when the
-- business has no account number. Security definer, service_role only: called
-- by document insert triggers (security definer) and server code, never by a
-- client, so members and viewers never read the table through it.
create or replace function app.document_bank_snapshot(p_org uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'bank_name', b.bank_name,
           'bank_branch', b.bank_branch,
           'bank_account', b.bank_account,
           'bank_account_name', b.bank_account_name)
    from public.org_bank_details b
   where b.organization_id = p_org and b.bank_account is not null
$$;
revoke all on function app.document_bank_snapshot(uuid) from public, anon, authenticated;
grant execute on function app.document_bank_snapshot(uuid) to service_role;
