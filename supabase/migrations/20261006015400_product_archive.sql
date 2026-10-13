-- =============================================================================
-- Archiving a product (PRD-02, wave 2)
-- =============================================================================
-- A product that appears in a document is archived, never removed: removal
-- works only while nothing refers to the product (every later table of
-- document lines references products with a composite foreign key and no
-- on delete action; see the products migration). Archiving is an update of
-- products.archived_at by an owner or admin (column grant and policies of the
-- products migration); this trigger makes the time the server's: a client
-- sends any time to archive and null to restore, and archiving an archived
-- product again keeps its first time. Archived products are hidden from the
-- list by default and are never offered for new document lines.
-- Every statement is safe to run twice. No drops, no row removal.

-- PRD-02: the time a product was archived is the server's
create or replace function app.products_archive_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.archived_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.archived_at is not null then
    new.archived_at := old.archived_at;
  else
    new.archived_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.products_archive_stamp() from public, anon, authenticated;

create or replace trigger products_archive_stamp before insert or update of archived_at on public.products
  for each row execute function app.products_archive_stamp();

