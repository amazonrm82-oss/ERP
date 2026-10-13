-- =============================================================================
-- One VAT setting per price list (PL-01 / PL-02 follow-up)
-- =============================================================================
-- Owner's decision of 13 October 2026 (DECISIONS.md, "מע"מ במחירון"):
--   1. One setting per price list: "the prices in this list include VAT", yes
--      or no (price_lists.prices_include_vat).
--   2. A new list starts from the business's setting
--      (org_document_settings.prices_include_vat; false when there is no row).
--      A writer that does not send the column gets it (price_lists_vat, before
--      insert); the app sends the choice from its form.
--   3. Every price in the list is typed and shown in the list's mode.
--   4. The setting can change only while the list has no prices (no lines).
--      After that it is locked (hint 'price_lists:vat_locked'), for every
--      writer, server included; there is no automatic conversion: to work the
--      other way, make a new list.
--   5. Every line takes the flag from its list when a price is saved
--      (price_list_lines_vat, before insert or update of the price columns):
--      a fixed price gets the list's flag, a discount stays false (the check
--      price_list_lines_vat_mode). So a document carries a list price into its
--      own mode exactly like a product price (productPriceFor, the shape of
--      unitPriceFor() is unchanged). Clients no longer choose
--      price_list_lines.price_includes_vat (column grants revoked).
--
-- Concurrency: price_list_lines_vat reads the list row FOR SHARE, which waits
-- for (and blocks) an update of the list row, and the lock check reads the
-- lines after the list row is locked; so a flag change and a first price
-- cannot pass each other.
--
-- Existing rows (hosted has no price lists yet; this is for safety): each list
-- takes the flag of its first fixed-price line (by created_at, id), else the
-- business's setting, else false. Lines are not changed: a list whose fixed
-- prices were typed in both modes keeps them as they are (each line still
-- carries its own flag, which unitPriceFor() reads), and is locked like any
-- list with prices; a price saved again takes the list's flag.
--
-- price_lists_vat is security invoker: it reads org_document_settings (members
-- read) and price_list_lines (members read) with the caller's rights; an
-- outsider reads nothing and is refused by RLS anyway. price_list_lines_vat is
-- security definer so the FOR SHARE lock does not depend on the caller's
-- update rights; it starts with the outsider guard.
--
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.price_lists add column if not exists prices_include_vat boolean;

update public.price_lists l
   set prices_include_vat = coalesce(
         (select pl.price_includes_vat
            from public.price_list_lines pl
           where pl.organization_id = l.organization_id and pl.price_list_id = l.id and pl.price_agorot is not null
           order by pl.created_at, pl.id
           limit 1),
         (select s.prices_include_vat from public.org_document_settings s where s.organization_id = l.organization_id),
         false)
 where l.prices_include_vat is null;

alter table public.price_lists alter column prices_include_vat set not null;

grant insert (prices_include_vat), update (prices_include_vat) on public.price_lists to authenticated;
revoke insert (price_includes_vat), update (price_includes_vat) on public.price_list_lines from authenticated;

-- The list's default on insert and the lock on update.
create or replace function app.price_lists_vat() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.prices_include_vat is null then
      new.prices_include_vat := coalesce(
        (select s.prices_include_vat from public.org_document_settings s where s.organization_id = new.organization_id),
        false);
    end if;
    return new;
  end if;
  -- filling a setting that was never set (this migration's backfill, run again) is not a change
  if old.prices_include_vat is not null
     and new.prices_include_vat is distinct from old.prices_include_vat
     and exists (select 1 from public.price_list_lines pl
                  where pl.organization_id = old.organization_id and pl.price_list_id = old.id) then
    raise exception 'the VAT setting of a price list with prices cannot change'
      using errcode = 'P0001', hint = 'price_lists:vat_locked';
  end if;
  return new;
end;
$$;
revoke all on function app.price_lists_vat() from public, anon, authenticated;

create or replace trigger price_lists_vat before insert or update of prices_include_vat on public.price_lists
  for each row execute function app.price_lists_vat();

-- Every line takes its mode from its list.
create or replace function app.price_list_lines_vat() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_include boolean;
begin
  -- RLS refuses this writer right after; touch nothing of the list
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  select l.prices_include_vat into v_include
    from public.price_lists l
   where l.organization_id = new.organization_id and l.id = new.price_list_id
     for share;
  new.price_includes_vat := new.price_agorot is not null and coalesce(v_include, false);
  return new;
end;
$$;
revoke all on function app.price_list_lines_vat() from public, anon, authenticated;

create or replace trigger price_list_lines_vat
  before insert or update of price_agorot, discount_bp, price_includes_vat on public.price_list_lines
  for each row execute function app.price_list_lines_vat();
