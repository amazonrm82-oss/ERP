import { z } from "zod";

import { optionalId, requiredText } from "@/lib/validation";

// CON-02: the contact types and company types an organization offers

export type RecordTypeObject = "contact" | "company";
export const recordTypeObjectArg = z.enum(["contact", "company"]);

export type RecordType = { id: string; name: string; position: number; isActive: boolean };

export const TYPE_MAX = 60;
// the database refuses more (trigger record_type_options_cap, hint 'record_types:max')
export const TYPES_PER_OBJECT = 50;

export const typeSchema = z.object({
  name: requiredText(TYPE_MAX, "יש להזין שם לסוג.", `השם ארוך מדי (עד ${TYPE_MAX} תווים).`),
});

// offered to an organization that has no types yet; the admin adds them with one click and edits freely
export const SUGGESTED_TYPES = ["לקוח", "לקוח פוטנציאלי", "ספק", "שותף", "מתחרה", "אחר"] as const;

export const TYPE_TEXTS: Record<RecordTypeObject, { title: string; placeholder: string; add: string }> = {
  contact: { title: "סוגי אנשי קשר", placeholder: "סוג חדש, למשל: ספק", add: "הוספת סוג" },
  company: { title: "סוגי חברות", placeholder: "סוג חדש, למשל: לקוח", add: "הוספת סוג" },
};

/**
 * The type picked in a record's form. The field is left out of the form when
 * the organization has no types; then the record's type is not touched.
 */
export function typeIdFromForm(formData: FormData): { ok: true; patch: { type_id?: string | null } } | { ok: false; message: string } {
  if (!formData.has("type_id")) {
    return { ok: true, patch: {} };
  }
  const parsed = optionalId.safeParse(formData.get("type_id"));
  if (!parsed.success) {
    return { ok: false, message: "יש לבחור סוג מהרשימה." };
  }
  return { ok: true, patch: { type_id: parsed.data } };
}

export type TypeChoice = { value: string; label: string };

/**
 * The choices of a record's type field: the active types, plus the record's
 * current one when it was hidden later (so saving the form keeps it).
 */
export function typeChoices(types: RecordType[], currentId: string | null): TypeChoice[] {
  return types
    .filter((type) => type.isActive || type.id === currentId)
    .map((type) => ({ value: type.id, label: type.isActive ? type.name : `${type.name} (מוסתר)` }));
}
