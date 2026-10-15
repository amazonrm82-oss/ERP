-- =============================================================================
-- Running numbers for quotes and orders (QUO-03, ORD-03)
-- =============================================================================
-- SPEC-ADDITIONS 16.1: one counter table per organization and document kind,
-- and one function that locks the row and hands out the next number.
--
-- * public.number_sequences: at most one row per (organization, kind).
--   kind: 'quote' (QUO-03) | 'order' (ORD-03). Tax documents are numbered by
--   the invoicing provider (DOC-02, DOC-10), not here; a new kind is added to
--   the check constraint by a later migration.
--   prefix: shown before the number ("Q-" + 1001 = "Q-1001"); up to 12
--   characters: Hebrew or Latin letters, digits, - / . _ ; may be empty; never
--   ends in a digit, so a printed number cannot repeat after a prefix change
--   ("Q-1" + 35 and "Q-" + 135 would both print "Q-135").
--   start_number: the first number, 1..999,999,999. It can be changed only
--   while no number of the series has been handed out (hint
--   'number_sequences:start_locked', every writer).
--   last_number: the last number handed out; null = none yet. Server only (no
--   client grant), never goes down and never goes back to null (same hint
--   family, 'number_sequences:last_number', every writer), so a number is never
--   handed out twice, also after the document that held it is cancelled.
--   It never passes 999,999,999 (number_sequences_last_range); the allocator
--   then refuses with hint 'number_sequences:exhausted'.
--   No row = the defaults (empty prefix, start 1); the allocator creates it.
--   Members read it (the settings screen shows the next number); owners and
--   admins of a writable organization insert and update prefix and start.
--   Jump forward (owner, 14 October 2026; DECISIONS.md "קפיצה קדימה במספור"):
--   after the first number the start is fixed, but an owner or admin may move
--   the next number of a series forward through
--   public.number_sequence_jump(org, kind, next) (below). last_number keeps no
--   client grant, and the guard keeps it from ever going back for every writer.
--   No delete by any API role (service_role included: no DELETE or TRUNCATE
--   grant): removing the row would restart the series. Trigger
--   number_sequences_no_delete refuses every other delete (hint
--   'number_sequences:delete') unless the organization row is already gone,
--   i.e. the delete is the cascade of deleting the organization.
--   Audited for a person's changes to prefix and start. An allocation is not an
--   audit entry: it only moves last_number (not an audited column), and the
--   allocator's own insert of a default row sets the transaction-local setting
--   app.number_allocating, which the audit trigger's WHEN clause skips. A
--   session running as authenticated is audited even with that setting on.
-- * app.next_document_number(org, kind) -> (number, display). Security
--   definer, schema app (not in the API; no role holds execute, service_role
--   included): called by the
--   security definer functions and triggers that create a quote or an order,
--   inside their own transaction. One UPDATE takes the row lock, so two callers
--   at the same moment get consecutive distinct numbers; the second waits for
--   the first to commit or roll back. A number is used only when the caller's
--   transaction commits; a rolled-back one leaves no gap and no duplicate. A
--   signed-in caller must be able to write in the organization
--   (app.can_write: an active non-viewer of a writable organization, so never
--   read-only, suspended, cancelled or deleted). A server caller (no session)
--   is refused only for a cancelled or deleted organization (the rule of
--   app.org_public_pages_open; hint 'org:closed', P0001): a read-only or
--   suspended business still receives from outside, as its public forms still
--   take leads (app.org_takes_leads), so e.g. a customer accepting a quote
--   through its public link (QUO-08) may still produce a numbered order.
--   Callers pass the document's own organization_id, never one taken from the
--   request, so a number is always drawn from the series of the organization
--   that owns the document.
--   Lock order: a caller that numbers both kinds in one transaction always takes
--   'quote' before 'order', so two such callers cannot deadlock. Under
--   REPEATABLE READ or SERIALIZABLE a caller whose row was changed by a
--   concurrent transaction gets 40001 (serialization failure) and must retry the
--   whole transaction; under READ COMMITTED (the default) it simply waits.
-- Every statement is safe to run twice.

create table if not exists public.number_sequences (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null,
  prefix          text not null default '',
  start_number    bigint not null default 1,
  last_number     bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, kind),
  constraint number_sequences_kind_check check (kind in ('quote', 'order')),
  constraint number_sequences_prefix_check check (char_length(prefix) <= 12 and prefix ~ '^([A-Za-z0-9א-ת/._-]*[A-Za-zא-ת/._-])?$'),
  constraint number_sequences_start_range check (start_number between 1 and 999999999),
  constraint number_sequences_last_range check (last_number is null or last_number between 1 and 999999999)
);

comment on table public.number_sequences is
  'QUO-03, ORD-03: the running number series of quotes and orders, one row per organization and kind; numbers are handed out only by app.next_document_number().';

create or replace trigger number_sequences_touch before insert or update on public.number_sequences
  for each row execute function app.touch_row();
-- the allocator's own insert of a default row is not audited (see the header)
create or replace trigger number_sequences_audit after insert or update of prefix, start_number on public.number_sequences
  for each row when (current_user = 'authenticated' or current_setting('app.number_allocating', true) is distinct from 'on')
  execute function app.audit_row();

-- The start is fixed once a number was handed out; last_number only goes up;
-- organization and kind never change. Every writer, the server included.
create or replace function app.number_sequences_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.last_number is not null and new.last_number < new.start_number then
      raise exception 'number_sequences: last number below the start'
        using errcode = 'P0001', hint = 'number_sequences:last_number';
    end if;
    return new;
  end if;
  if new.organization_id is distinct from old.organization_id or new.kind is distinct from old.kind then
    raise exception 'number_sequences: organization and kind cannot change'
      using errcode = 'P0001', hint = 'number_sequences:fixed';
  end if;
  if new.start_number is distinct from old.start_number and old.last_number is not null then
    raise exception 'number_sequences: the start cannot change after a number was handed out'
      using errcode = 'P0001', hint = 'number_sequences:start_locked';
  end if;
  if old.last_number is not null and (new.last_number is null or new.last_number < old.last_number) then
    raise exception 'number_sequences: the last number never goes back'
      using errcode = 'P0001', hint = 'number_sequences:last_number';
  end if;
  return new;
end;
$$;
revoke all on function app.number_sequences_guard() from public, anon, authenticated;

create or replace trigger number_sequences_guard before insert or update on public.number_sequences
  for each row execute function app.number_sequences_guard();

-- a series row is removed only with its organization (the cascade); see the header
create or replace function app.number_sequences_no_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- in the cascade the organization row is already gone (the RI action runs after the parent's delete)
  if exists (select 1 from public.organizations o where o.id = old.organization_id) then
    raise exception 'number_sequences: a number series cannot be removed'
      using errcode = 'P0001', hint = 'number_sequences:delete';
  end if;
  return old;
end;
$$;
revoke all on function app.number_sequences_no_delete() from public, anon, authenticated;

create or replace trigger number_sequences_no_delete before delete on public.number_sequences
  for each row execute function app.number_sequences_no_delete();

alter table public.number_sequences enable row level security;
revoke all on public.number_sequences from anon, authenticated;
-- Supabase's default grants give service_role every privilege on a new table
revoke delete, truncate on public.number_sequences from service_role;
grant select on public.number_sequences to authenticated;
grant insert (organization_id, kind, prefix, start_number) on public.number_sequences to authenticated;
grant update (prefix, start_number) on public.number_sequences to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'number_sequences' and policyname = 'number_sequences_select') then
    create policy number_sequences_select on public.number_sequences for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'number_sequences' and policyname = 'number_sequences_insert') then
    create policy number_sequences_insert on public.number_sequences for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'number_sequences' and policyname = 'number_sequences_update') then
    create policy number_sequences_update on public.number_sequences for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- The next number of a series (see the header). Raises 22023 for an unknown
-- kind, 42501 for a signed-in caller who may not write in the organization.
create or replace function app.next_document_number(p_org uuid, p_kind text, out o_number bigint, out o_display text)
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in ('quote', 'order') then
    raise exception 'next_document_number: unknown kind' using errcode = '22023', hint = 'number_sequences:kind';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'next_document_number: unknown organization' using errcode = '22023';
  end if;
  if not app.org_public_pages_open(p_org) then
    raise exception 'next_document_number: the organization is cancelled or deleted'
      using errcode = 'P0001', hint = 'org:closed';
  end if;
  if auth.uid() is not null and not app.can_write(p_org) then
    raise exception 'next_document_number: not permitted' using errcode = '42501';
  end if;

  -- not audited: the audit trigger's WHEN clause skips while this is on
  perform set_config('app.number_allocating', 'on', true);
  insert into public.number_sequences (organization_id, kind)
  values (p_org, p_kind)
  on conflict (organization_id, kind) do nothing;
  perform set_config('app.number_allocating', '', true);

  -- the series ends at 999,999,999 (number_sequences_last_range); the row lock is taken first
  perform 1 from public.number_sequences s
   where s.organization_id = p_org and s.kind = p_kind and s.last_number >= 999999999
     for update;
  if found then
    raise exception 'next_document_number: the series reached 999,999,999'
      using errcode = 'P0001', hint = 'number_sequences:exhausted';
  end if;

  update public.number_sequences s
     set last_number = coalesce(s.last_number + 1, s.start_number)
   where s.organization_id = p_org and s.kind = p_kind
  returning s.last_number, s.prefix || s.last_number::text
    into o_number, o_display;
end;
$$;
-- no caller role may run it directly: only the definer functions and triggers that make a quote or an order
revoke all on function app.next_document_number(uuid, text) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Jump forward (owner, 14 October 2026): an owner or admin of a writable
-- organization sets a new next number for one kind. It must be higher than the
-- current next number (last + 1) and at most 999,999,999 (hints
-- 'number_sequences:not_forward', 'number_sequences:range'); the numbers in
-- between are never used. Only after the first number (before it, the start is
-- edited instead; hint 'number_sequences:not_used'). The row is locked FOR
-- UPDATE, so an allocation at the same moment either comes before the jump (and
-- the jump is checked against its number) or waits and continues after the new
-- number; never a duplicate. One audit entry per jump: action 'number_jump',
-- changes {"next_number": {"old": .., "new": ..}}. Returns the new next number.
create or replace function public.number_sequence_jump(p_org uuid, p_kind text, p_next bigint) returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_last bigint;
begin
  if p_kind is null or p_kind not in ('quote', 'order') then
    raise exception 'number_sequence_jump: unknown kind' using errcode = '22023', hint = 'number_sequences:kind';
  end if;
  if p_org is null or not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'number_sequence_jump: not permitted' using errcode = '42501';
  end if;
  if p_next is null or p_next < 1 or p_next > 999999999 then
    raise exception 'number_sequence_jump: next number out of range' using errcode = '22023', hint = 'number_sequences:range';
  end if;

  select s.id, s.last_number into v_id, v_last
    from public.number_sequences s
   where s.organization_id = p_org and s.kind = p_kind
     for update;
  if v_id is null or v_last is null then
    raise exception 'number_sequence_jump: no number was handed out yet' using errcode = 'P0001', hint = 'number_sequences:not_used';
  end if;
  if p_next <= v_last + 1 then
    raise exception 'number_sequence_jump: the next number must move forward' using errcode = 'P0001', hint = 'number_sequences:not_forward';
  end if;

  update public.number_sequences s set last_number = p_next - 1 where s.id = v_id;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'number_jump', 'number_sequences', v_id,
          jsonb_build_object('next_number', jsonb_build_object('old', v_last + 1, 'new', p_next)));
  return p_next;
end;
$$;
revoke all on function public.number_sequence_jump(uuid, text, bigint) from public, anon, service_role;
grant execute on function public.number_sequence_jump(uuid, text, bigint) to authenticated;
