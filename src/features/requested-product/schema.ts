import { optionalId } from "@/lib/validation";

// LEAD-04: the lead's requested product. The form sends the field only when the organization has
// the 'products' flag (the picker is shown); without it the stored value is left as it is.

export const REQUESTED_PRODUCT_FIELD = "requested_product_id";

export const REQUESTED_PRODUCT_INVALID = "המוצר שנבחר כבר לא זמין. בחרו מוצר פעיל מהקטלוג.";

/** The patch for the lead, or nothing when the form has no product field. */
export function requestedProductFromForm(
  formData: FormData,
): { ok: true; patch: { requested_product_id?: string | null } } | { ok: false; message: string } {
  if (!formData.has(REQUESTED_PRODUCT_FIELD)) {
    return { ok: true, patch: {} };
  }
  const parsed = optionalId.safeParse(formData.get(REQUESTED_PRODUCT_FIELD));
  if (!parsed.success) {
    return { ok: false, message: REQUESTED_PRODUCT_INVALID };
  }
  return { ok: true, patch: { requested_product_id: parsed.data } };
}

export type RequestedProductState = { isActive: boolean; archivedAt: string | null };

/** "בארכיון", "לא פעיל" or null: why a product stored earlier can no longer be picked. */
export function requestedProductNote(product: RequestedProductState): string | null {
  if (product.archivedAt !== null) return "בארכיון";
  if (!product.isActive) return "לא פעיל";
  return null;
}
