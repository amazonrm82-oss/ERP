-- =============================================================================
-- Company hierarchy: parent company guard (CON-07, wave 2)
-- =============================================================================
-- companies.parent_company_id exists since 0002 (composite foreign key, on
-- delete set null). CON-07 shows it on the company page and lets a person pick
-- it. Owner's decision (DECISIONS.md): one link only, "belongs to", with no kind.
--
-- Two triggers:
--
-- companies_parent_check (before insert or update, security invoker, because it tells a person's write
--   from a server write by current_user): when a person sets or changes the
--   parent, the parent must be a company of the same organization that the
--   person can read (RLS decides) and that is not in the recycle bin
--   (hint company:parent_invalid). The foreign key alone would accept any id
--   of the organization, readable or not.
--
-- companies_parent_tree (security definer, so the walk sees the whole tree
--   whatever the writer may read; every writer, merges included). It is a
--   constraint trigger, AFTER ... DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW:
--   it fires at the end of the statement, so a multi-row update (a merge moves
--   all the merged company's children in one statement) is judged by the tree
--   it leaves, not by a half-done state; the row's parent is read back from the
--   table. When the parent is set or changed, it refuses
--     - a cycle: the company may not be its own parent or ancestor
--       (hint company:parent_cycle);
--     - a tree deeper than 10 levels: the levels above the company plus the
--       levels of its own subtree may not pass 10 (hint company:parent_depth).
--       10 is our choice; the spec gives no number.
--   Refusing tells the writer something about companies they may not read:
--   that a hidden company sits above or below in the same organization (a
--   cycle or depth refusal through it). Nothing more (no name, no id), and only
--   within the writer's own organization; accepted.
--   It first takes a per-organization advisory lock, so two updates that
--   would together close a cycle (A under B and B under A at the same moment)
--   run one after the other; the second one sees the first one's row (each
--   statement of a volatile PL/pgSQL function reads a fresh snapshot in READ
--   COMMITTED).
--
-- Neither trigger acts when the parent is unchanged or set to null, so purging
-- a parent (on delete set null), trashing, restoring and every other update
-- are untouched. app.merge_move_links() re-points children of the merged
-- company to the kept one with a definer update; that write is checked for
-- cycles and depth like any other (it would otherwise be able to close a cycle
-- when the kept company sits below the merged one), but not for readability.
-- Imports and sample data never write parent_company_id.
--
-- companies has table-level insert/update grants for authenticated (0004), so
-- parent_company_id needs no column grant.
--
-- Every statement is safe to run twice. No drops, no row removal.

create index if not exists companies_parent_idx
  on public.companies (organization_id, parent_company_id)
  where parent_company_id is not null;

create or replace function app.companies_parent_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if new.parent_company_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.parent_company_id is not distinct from old.parent_company_id then
    return new;
  end if;
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- read with the person's rights: a company they cannot see, or one in the bin, is no parent
  if not exists (
    select 1 from public.companies c
     where c.organization_id = new.organization_id
       and c.id = new.parent_company_id
       and c.deleted_at is null
  ) then
    raise exception 'parent company is not available' using errcode = 'P0001', hint = 'company:parent_invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.companies_parent_check() from public, anon, authenticated;

create or replace function app.companies_parent_tree() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_max  constant int := 10;
  v_cur  uuid;
  v_seen uuid[];
  v_up   int := 0;
  v_down int;
begin
  if new.parent_company_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.parent_company_id is not distinct from old.parent_company_id then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('company_tree:' || new.organization_id::text, 0));

  -- the row as the statement left it (a later row of the same statement may have changed it again)
  select c.parent_company_id into v_cur
    from public.companies c
   where c.organization_id = new.organization_id and c.id = new.id;
  if v_cur is null then
    return null;
  end if;

  -- the parent and its ancestors; meeting the company itself, or any company twice, is a cycle
  v_seen := array[new.id];
  while v_cur is not null loop
    if v_cur = any (v_seen) then
      raise exception 'company hierarchy would form a cycle' using errcode = 'P0001', hint = 'company:parent_cycle';
    end if;
    v_seen := v_seen || v_cur;
    v_up := v_up + 1;
    if v_up >= v_max then
      raise exception 'company hierarchy deeper than % levels', v_max using errcode = 'P0001', hint = 'company:parent_depth';
    end if;
    select c.parent_company_id into v_cur
      from public.companies c
     where c.organization_id = new.organization_id and c.id = v_cur;
  end loop;

  -- the levels of the company's own subtree (1 = no children); bounded, so stray data cannot loop
  with recursive below (id, lvl) as (
    select c.id, 2 from public.companies c
     where c.organization_id = new.organization_id and c.parent_company_id = new.id and c.id <> new.id
    union all
    select c.id, b.lvl + 1 from public.companies c
      join below b on c.parent_company_id = b.id
     where c.organization_id = new.organization_id and b.lvl <= v_max
  )
  select coalesce(max(lvl), 1) into v_down from below;

  if v_up + v_down > v_max then
    raise exception 'company hierarchy deeper than % levels', v_max using errcode = 'P0001', hint = 'company:parent_depth';
  end if;
  return null;
end;
$$;
revoke all on function app.companies_parent_tree() from public, anon, authenticated;

create or replace trigger companies_parent_check before insert or update of parent_company_id on public.companies
  for each row execute function app.companies_parent_check();

-- A constraint trigger, so that it runs at the end of the statement and sees its end state.
-- CREATE OR REPLACE is not available for constraint triggers: created only when missing.
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.companies'::regclass and tgname = 'companies_parent_tree' and not tgisinternal
  ) then
    create constraint trigger companies_parent_tree
      after insert or update of parent_company_id on public.companies
      deferrable initially immediate
      for each row execute function app.companies_parent_tree();
  end if;
end;
$$;
