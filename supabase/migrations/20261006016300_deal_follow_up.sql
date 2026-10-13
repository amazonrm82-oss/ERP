-- =============================================================================
-- Follow-up deal link (DEAL-11, wave 2)
-- =============================================================================
-- "Duplicate a deal, and a follow-up deal for the same customer." Both are created
-- by the app with the user's session through the ordinary deals insert, so every
-- deal trigger (stage sync, default owner and team, record limit, audit, outbox,
-- custom field checks) applies. The one thing the database needs is the link from
-- a follow-up deal back to the deal it continues:
--
-- deals.previous_deal_id (nullable): the deal this one continues. A composite
--   foreign key (organization_id, previous_deal_id) keeps it in the organization;
--   purging the earlier deal clears only this column (on delete set null of the
--   column). A deal is never its own previous deal (check).
--
-- Trigger deals_previous_check (before insert or update of previous_deal_id,
--   security invoker, because it tells a person's write from a server one by
--   current_user):
--     * a person sets the link only when creating the deal: the earlier deal must
--       be one they read (RLS decides) and not in the recycle bin
--       (hint deal:previous_deal);
--     * a person never changes or clears it afterwards (same hint). deals has a
--       table-wide UPDATE grant (0004), so the column grant alone could not stop it.
--   Server writers (the foreign key's set null, platform tools) are not limited.
--
-- Not carried anywhere else: deals are not merged, imported or exported with a
-- column list, and sample data never writes it. A nullable column needs nothing in
-- app.sample_row(); a follow-up deal that points at a sample deal does not keep the
-- sample deal (removing it clears the link through the foreign key).
--
-- Known and accepted for now (lead, shared-ground follow-up): removing sample data removes a sample
-- deal even when a real follow-up points at it, and the follow-up's link is cleared.
--
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.deals add column if not exists previous_deal_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deals_previous_deal_fk' and conrelid = 'public.deals'::regclass) then
    alter table public.deals
      add constraint deals_previous_deal_fk foreign key (organization_id, previous_deal_id)
      references public.deals (organization_id, id) on delete set null (previous_deal_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deals_previous_deal_not_self' and conrelid = 'public.deals'::regclass) then
    alter table public.deals
      add constraint deals_previous_deal_not_self check (previous_deal_id is null or previous_deal_id <> id);
  end if;
end;
$$;

-- "follow-up deals" of a deal, and the foreign key's set null on purge
create index if not exists deals_previous_deal_idx
  on public.deals (organization_id, previous_deal_id)
  where previous_deal_id is not null;

-- deals has a table-wide grant today; this keeps the column insertable if it ever moves to
-- column grants (as leads, contacts and tasks did). No update grant: the link is set once.
grant insert (previous_deal_id) on public.deals to authenticated;

create or replace function app.deals_previous_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.previous_deal_id is distinct from old.previous_deal_id then
      raise exception 'the previous deal is set only when the deal is created' using errcode = 'P0001', hint = 'deal:previous_deal';
    end if;
    return new;
  end if;
  if new.previous_deal_id is null then
    return new;
  end if;
  -- read with the person's rights: a deal they cannot see, or one in the bin, is not continued
  if not exists (
    select 1 from public.deals d
     where d.organization_id = new.organization_id
       and d.id = new.previous_deal_id
       and d.deleted_at is null
  ) then
    raise exception 'previous deal is not available' using errcode = 'P0001', hint = 'deal:previous_deal';
  end if;
  return new;
end;
$$;
revoke all on function app.deals_previous_check() from public, anon, authenticated;

create or replace trigger deals_previous_check before insert or update of previous_deal_id on public.deals
  for each row execute function app.deals_previous_check();
