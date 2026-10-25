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

/** The settings screen's warning on a form whose saved choice now offers more than 100 (the business grew). */
export const PRODUCTS_GREW_WARNING = `הבחירה בטופס הזה כוללת היום יותר מ-${MAX_FORM_PRODUCTS} מוצרים פעילים, ולכן בטופס מוצגים רק ${MAX_FORM_PRODUCTS} הראשונים לפי שם. צמצמו את הבחירה: השמירה הבאה של הטופס תחייב זאת.`;

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
