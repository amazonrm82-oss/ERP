-- =============================================================================
-- A form whose product selection grew past 100 keeps saving (LEAD-04 / CAP-08 follow-up)
-- =============================================================================
-- Owner, 26 October 2026 (answer (ב) to the question of 020830): a form saved with a product selection when the
-- business had at most 100 offerable products, and the business later grew past 100: the form's other settings save as
-- usual, the selection is marked "דורש צמצום" on the settings screen, and the public form keeps showing the stored
-- (previous) selection, its first 100 by name (app.intake_form_products, unchanged), until it is narrowed.
--
-- * app.forms_product_ids_check: the body of 020830, with the over-100 rule (hint form:products_over) judged only on
--   an insert or when product_choice, product_ids or product_category_ids actually change. Before, any update naming
--   those columns was judged, even with the stored values. A person still can never STORE a new selection that offers
--   more than 100 (turning the question on, or a new pick). The pick checks (form:product_ids / form:product_categories)
--   are unchanged. The trigger itself is unchanged.
-- * The app (src/features/intake/actions.ts) sends the product columns only when the selection changed; when a changed
--   selection offers more than 100, it saves the other settings without it and answers on the field.
-- No change to intake_form / intake_submit. Safe to run twice.

create or replace function app.forms_product_ids_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if not app.is_member(new.organization_id) then
    return new;
  end if;
  if new.product_ids is not null and (tg_op = 'INSERT' or new.product_ids is distinct from old.product_ids) then
    if exists (
      select 1 from unnest(new.product_ids) as x(id)
       where not exists (select 1 from public.products p where p.organization_id = new.organization_id and p.id = x.id)
    ) or cardinality(new.product_ids) <> (select count(distinct x.id) from unnest(new.product_ids) as x(id)) then
      raise exception 'a picked product is not one of this business' using errcode = 'P0001', hint = 'form:product_ids';
    end if;
  end if;
  if new.product_category_ids is not null
     and (tg_op = 'INSERT' or new.product_category_ids is distinct from old.product_category_ids) then
    if exists (
      select 1 from unnest(new.product_category_ids) as x(id)
       where not exists (select 1 from public.product_categories c where c.organization_id = new.organization_id and c.id = x.id)
    ) or cardinality(new.product_category_ids) <> (select count(distinct x.id) from unnest(new.product_category_ids) as x(id)) then
      raise exception 'a picked category is not one of this business' using errcode = 'P0001', hint = 'form:product_categories';
    end if;
  end if;
  -- owner, 25 October 2026: over 100 active products the form must pick which ones it shows.
  -- Owner, 26 October 2026 (answer (ב)): judged only when the selection itself changes (insert, or a new value of
  -- product_choice / product_ids / product_category_ids). A form whose stored selection grew past 100 later keeps it
  -- on every other save; a person can never store a NEW selection that offers more than 100.
  if new.kind = 'form' and new.product_choice
     and (tg_op = 'INSERT'
          or new.product_choice is distinct from old.product_choice
          or new.product_ids is distinct from old.product_ids
          or new.product_category_ids is distinct from old.product_category_ids)
     and (
    select count(*) from app.form_product_offer(new.organization_id, new.product_ids, new.product_category_ids)
  ) > 100 then
    raise exception 'the form offers more than 100 products' using errcode = 'P0001', hint = 'form:products_over';
  end if;
  return new;
end;
$$;
revoke all on function app.forms_product_ids_check() from public, anon, authenticated;
