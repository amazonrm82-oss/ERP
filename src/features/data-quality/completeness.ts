import { z } from "zod";

import { inputName } from "@/features/custom-fields/types";

// DQL-01: which fields count as important per record type, and how a missing one is shown.
// The score itself is computed in the database only (app.completeness_eval, migration
// record_completeness); this file holds the names and the keys. COMPLETENESS_BUILT_IN and
// COMPLETENESS_DEFAULTS mirror app.completeness_builtin_keys() / app.completeness_default_keys()
// (tests/db/96-record-completeness.test.ts keeps them equal).

export const COMPLETENESS_TYPES = ["lead", "contact", "company", "deal"] as const;
export type CompletenessType = (typeof COMPLETENESS_TYPES)[number];

export function isCompletenessType(value: unknown): value is CompletenessType {
  return typeof value === "string" && (COMPLETENESS_TYPES as readonly string[]).includes(value);
}

export const CUSTOM_KEY_PREFIX = "cf:";

// "contact" is a phone or an email; the rest are columns of the record
export const COMPLETENESS_BUILT_IN: Record<CompletenessType, Array<{ key: string; label: string }>> = {
  lead: [
    { key: "contact", label: "טלפון או אימייל" },
    { key: "full_name", label: "שם" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "company_name", label: "חברה" },
    { key: "job_title", label: "תפקיד" },
    { key: "source_id", label: "מקור" },
    { key: "owner_id", label: "אחראי" },
  ],
  contact: [
    { key: "contact", label: "טלפון או אימייל" },
    { key: "full_name", label: "שם" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "job_title", label: "תפקיד" },
    { key: "company_id", label: "חברה" },
    { key: "source_id", label: "מקור" },
    { key: "city", label: "עיר" },
    { key: "birth_date", label: "תאריך לידה" },
    { key: "owner_id", label: "אחראי" },
  ],
  company: [
    { key: "contact", label: "טלפון או אימייל" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "website", label: "אתר" },
    { key: "tax_id", label: "ח.פ. / מספר עוסק" },
    { key: "industry", label: "ענף" },
    { key: "city", label: "עיר" },
    { key: "owner_id", label: "אחראי" },
  ],
  deal: [
    { key: "amount_agorot", label: "סכום" },
    { key: "expected_close_date", label: "צפי סגירה" },
    { key: "contact_id", label: "איש קשר" },
    { key: "company_id", label: "חברה" },
    { key: "source_id", label: "מקור" },
    { key: "owner_id", label: "אחראי" },
  ],
};

// spec 22.9: a lead's important fields are a phone or an email, the source and the owner
export const COMPLETENESS_DEFAULTS: Record<CompletenessType, string[]> = {
  lead: ["contact", "source_id", "owner_id"],
  contact: ["contact", "company_id"],
  company: ["contact", "industry"],
  deal: ["amount_agorot", "expected_close_date", "contact_id"],
};

export const COMPLETENESS_TYPE_LABELS: Record<CompletenessType, { one: string; many: string }> = {
  lead: { one: "ליד", many: "לידים" },
  contact: { one: "איש קשר", many: "אנשי קשר" },
  company: { one: "חברה", many: "חברות" },
  deal: { one: "עסקה", many: "עסקאות" },
};

export type CompletenessField = { key: string; label: string };

/** Every field that may be marked important: the built-in ones, then the type's active custom fields. */
export function completenessCatalog(type: CompletenessType, customFields: Array<{ key: string; label: string }>): CompletenessField[] {
  return [...COMPLETENESS_BUILT_IN[type], ...customFields.map((f) => ({ key: `${CUSTOM_KEY_PREFIX}${f.key}`, label: f.label }))];
}

/** The label of a key, or null when the catalog no longer has it (a hidden or deleted custom field). */
export function completenessLabel(catalog: CompletenessField[], key: string): string | null {
  return catalog.find((f) => f.key === key)?.label ?? null;
}

const keyPattern = /^(cf:)?[a-z][a-z0-9_]{0,39}$/;

// the shape the database accepts (app.completeness_fields_ok): at most 40 keys, no repeats
export const completenessFieldsSchema = z
  .array(z.string().regex(keyPattern))
  .max(40)
  .refine((keys) => new Set(keys).size === keys.length);

/**
 * The keys to save from a settings form: only keys of the catalog, in catalog order
 * (so the card lists them the way the settings page shows them).
 */
export function pickedKeys(catalog: CompletenessField[], picked: Iterable<string>): string[] {
  const set = new Set(picked);
  return catalog.filter((f) => set.has(f.key)).map((f) => f.key);
}

// The form field to focus when a missing field is clicked on the card; null when the field
// is not in the record's details form (the owner is changed elsewhere).
const FORM_FIELD: Record<CompletenessType, Record<string, string | null>> = {
  lead: { contact: "phone", full_name: "full_name", phone: "phone", email: "email", company_name: "company_name", job_title: null, source_id: "source_id", owner_id: null },
  contact: { contact: "phones", full_name: "first_name", phone: "phones", email: "emails", job_title: "job_title", company_id: "company_id", source_id: null, city: null, birth_date: "birth_date", owner_id: null },
  company: { contact: "phone", phone: "phone", email: "email", website: "website", tax_id: "tax_id", industry: "industry", city: "city", owner_id: null },
  deal: { amount_agorot: "amount", expected_close_date: "expected_close_date", contact_id: "contact_id", company_id: "company_id", source_id: null, owner_id: null },
};

/** The name of the form input that fills a missing key, or null when it is edited elsewhere. */
export function formFieldFor(type: CompletenessType, key: string): string | null {
  if (key.startsWith(CUSTOM_KEY_PREFIX)) {
    return inputName(key.slice(CUSTOM_KEY_PREFIX.length));
  }
  return FORM_FIELD[type][key] ?? null;
}

/** The URL parameter of a record page that opens its details card for editing at one input (?edit=<name>). */
export const EDIT_PARAM = "edit";

/** The input to focus from that parameter: a plain input name, else nothing. */
export function editFocusParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && /^[a-z][a-z0-9_]{0,60}$/.test(first) ? first : null;
}

/** "חסרים: טלפון, מקור" style text, for lists. */
export function missingText(labels: string[]): string {
  return labels.length === 0 ? "הכול מלא" : `חסר: ${labels.join(", ")}`;
}
