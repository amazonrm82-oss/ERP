// LEAD-04 / CAP-08 (owner, 14 October 2026): a public form may ask which product the person is interested in.
// forms.product_choice turns it on and forms.product_ids narrows the offer (null = every offerable product);
// intake_form() returns `products` [{id, name}] only when the form asks and the business has the `products` flag;
// the hosted form sends the picked id as `requested_product_id`; intake_submit() accepts only an offered one and sets
// the new lead's requested product before the distribution rules run.

/** The input's name on the hosted form, and the payload key intake_submit() reads. */
export const PRODUCT_INPUT = "requested_product_id";

export const PRODUCT_QUESTION = "במה אתם מתעניינים?";

export const PRODUCT_INVALID = "בחרו מהרשימה במה אתם מתעניינים.";

/** At most this many products are offered on one form (app.intake_form_products, forms_product_ids_size, form:products_over). */
export const MAX_FORM_PRODUCTS = 100;

/** At most this many categories are picked on one form (forms_product_category_ids_size). */
export const MAX_FORM_CATEGORIES = 50;

/** Owner, 25 October 2026: over 100 active products "all" may not be saved. */
export const PRODUCTS_ALL_OVER = `יש בעסק יותר מ-${MAX_FORM_PRODUCTS} מוצרים פעילים. בחרו אילו מוצרים או קטגוריות יוצגו בטופס.`;

/** A pick whose offer is over 100 products. */
export const PRODUCTS_PICK_OVER = `הבחירה כוללת יותר מ-${MAX_FORM_PRODUCTS} מוצרים פעילים. צמצמו את המוצרים או הקטגוריות שנבחרו.`;

/** Owner, 26 October 2026 (answer (ב)): the mark on a product selection that offers more than 100 products. */
export const PRODUCTS_NEEDS_NARROWING = "דורש צמצום";

/** The settings screen's note on a form whose stored selection now offers more than 100 (the business grew). */
export const PRODUCTS_GREW_WARNING = `הבחירה השמורה כוללת היום יותר מ-${MAX_FORM_PRODUCTS} מוצרים פעילים. עד שתצמצמו אותה, בטופס מוצגים ${MAX_FORM_PRODUCTS} הראשונים לפי שם מתוך הבחירה הזו, ושאר ההגדרות נשמרות כרגיל.`;

/** A changed selection that offers more than 100 is not saved: the field's note after the refusal. */
export const PRODUCTS_KEPT_NOTE = "הבחירה החדשה לא נשמרה, ובטופס נשארת הבחירה הקודמת עד שתצמצמו.";

/** The form's message when the other settings were saved and the product selection was not. */
export const PRODUCTS_KEPT_SAVED = "שאר ההגדרות נשמרו. בחירת המוצרים דורשת צמצום ולא נשמרה.";

/** The failure state's key that marks the product selection "דורש צמצום" after such a save. */
export const PRODUCTS_NARROW_VALUE = "product_selection__narrow";

/** A form's product selection as stored in forms (product_choice, product_ids, product_category_ids). */
export type ProductSelection = { product_choice: boolean; product_ids: readonly string[] | null; product_category_ids: readonly string[] | null };

function sameIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Whether the sent selection is the stored one (order of ids ignored; null = no pick). An unchanged selection is never
 * judged again, so a form whose stored selection grew past 100 keeps saving its other settings (owner, 26 October 2026).
 */
export function sameProductSelection(stored: ProductSelection, sent: ProductSelection): boolean {
  return (
    stored.product_choice === sent.product_choice &&
    sameIds(stored.product_ids, sent.product_ids) &&
    sameIds(stored.product_category_ids, sent.product_category_ids)
  );
}

/** Whether the stored selection needs narrowing: the question is asked and its offer is over 100 today. */
export function selectionNeedsNarrowing(asked: boolean, offerCount: number): boolean {
  return asked && offerCount > MAX_FORM_PRODUCTS;
}

export type FormCategory = { id: string; name: string; parentId: string | null };

/**
 * The categories a pick covers (app.form_product_offer): each picked category, and the sub-categories of a picked
 * top category. Ids that are not the business's categories cover nothing.
 */
export function coveredCategoryIds(picked: readonly string[], categories: readonly FormCategory[]): Set<string> {
  const chosen = new Set(picked);
  return new Set(categories.filter((c) => chosen.has(c.id) || (c.parentId !== null && chosen.has(c.parentId))).map((c) => c.id));
}

/** The settings list of categories: top categories by name, each followed by its sub-categories by name. */
export function orderedFormCategories(categories: readonly FormCategory[]): Array<FormCategory & { depth: 0 | 1 }> {
  const byName = (a: FormCategory, b: FormCategory) => compareFormProducts(a, b);
  const ids = new Set(categories.map((c) => c.id));
  const tops = categories.filter((c) => c.parentId === null || !ids.has(c.parentId)).sort(byName);
  const out: Array<FormCategory & { depth: 0 | 1 }> = [];
  for (const top of tops) {
    out.push({ ...top, depth: 0 });
    for (const child of categories.filter((c) => c.parentId === top.id).sort(byName)) out.push({ ...child, depth: 1 });
  }
  return out;
}

/**
 * The over-100 rule at save (the database's form:products_over is the rule; this answers on the field): null when the
 * choice may be saved, else the message. offerCount = offerable products of the choice (all of them for "all").
 */
export function productOfferRefusal(ask: boolean, all: boolean, offerCount: number): string | null {
  if (!ask || offerCount <= MAX_FORM_PRODUCTS) return null;
  return all ? PRODUCTS_ALL_OVER : PRODUCTS_PICK_OVER;
}

export type FormProduct = { id: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** intake_form()'s `products`: id and name of each, or null when the form does not ask (or nothing is offered). */
export function formProductsFrom(value: unknown): FormProduct[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: FormProduct[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const { id, name } = item as Record<string, unknown>;
      if (typeof id === "string" && UUID.test(id) && typeof name === "string" && name !== "") {
        out.push({ id, name });
      }
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * The sent choice: null for none, the id when it is one the form offers, "invalid" otherwise
 * (the database checks again against the current offer).
 */
export function productInput(value: string | null | undefined, offered: readonly FormProduct[]): string | null | "invalid" {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return offered.some((product) => product.id === trimmed) ? trimmed : "invalid";
}

/** The settings form's picked categories: the business's own only, each once, at most MAX_FORM_CATEGORIES. */
export function pickedCategoryIds(values: readonly string[], known: ReadonlySet<string>): string[] {
  return [...new Set(values.filter((id) => known.has(id)))].slice(0, MAX_FORM_CATEGORIES);
}

/** The settings form's picked ids: offerable ones only, each once, at most MAX_FORM_PRODUCTS; empty = every product. */
export function pickedProductIds(values: readonly string[], offerable: ReadonlySet<string>): string[] {
  return [...new Set(values.filter((id) => offerable.has(id)))].slice(0, MAX_FORM_PRODUCTS);
}

/** The failure state's keys that carry every ticked product and category back (formValues keeps one value per name). */
export const PRODUCT_PICKS_VALUE = "product_ids__sent";
export const CATEGORY_PICKS_VALUE = "product_category_ids__sent";

/** The ticked product ids of a submitted settings form, joined for the failure state's values. */
export function productPicksValue(ids: readonly unknown[]): string {
  return ids.filter((id): id is string => typeof id === "string" && UUID.test(id)).join(",");
}

/**
 * Which products start ticked in the settings form: after a failed save, what the person sent (carried back in
 * PRODUCT_PICKS_VALUE); otherwise the stored picks.
 */
export function initialProductPicks(
  values: Record<string, string> | undefined,
  stored: readonly string[] | null,
  key: string = PRODUCT_PICKS_VALUE,
): Set<string> {
  const sent = values?.[key];
  if (values && sent !== undefined) {
    return new Set(sent.split(",").filter((id) => UUID.test(id)));
  }
  return new Set(stored ?? []);
}

/** The order of the public form's list (app.intake_form_products: lower(name), then id). */
export function compareFormProducts(a: { id: string; name: string }, b: { id: string; name: string }): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The settings list: the listed products plus any stored pick the list left out (a catalog longer than the list),
 * each once, in the public form's order. A save then never drops a pick the person did not untick.
 */
export function mergeFormProductOptions(listed: readonly FormProduct[], picked: readonly FormProduct[]): FormProduct[] {
  const byId = new Map<string, FormProduct>();
  for (const product of [...listed, ...picked]) {
    if (!byId.has(product.id)) byId.set(product.id, product);
  }
  return [...byId.values()].sort(compareFormProducts);
}
