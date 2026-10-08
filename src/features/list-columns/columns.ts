import { z } from "zod";

// Which columns a list shows, in what order and how wide (LST-03). Shared by the
// server (resolving a saved choice) and the "columns" panel in the browser.

export type ListObject = "lead" | "contact" | "company" | "deal" | "task";
export type ColumnWidth = "narrow" | "normal" | "wide";
export type ColumnChoice = { key: string; width: ColumnWidth };
export type CatalogColumn = { key: string; label: string };

// The name column is always first and is not in the catalog.
const BUILT_IN: Record<ListObject, { columns: CatalogColumn[]; defaults: string[] }> = {
  lead: {
    columns: [
      { key: "phone", label: "טלפון" },
      { key: "email", label: "אימייל" },
      { key: "company", label: "חברה" },
      { key: "status", label: "סטטוס" },
      { key: "source", label: "מקור" },
      { key: "owner", label: "בעלים" },
      { key: "created", label: "נוצר" },
    ],
    defaults: ["phone", "email", "status", "source", "owner", "created"],
  },
  contact: {
    columns: [
      { key: "phone", label: "טלפון" },
      { key: "email", label: "אימייל" },
      { key: "job_title", label: "תפקיד" },
      { key: "company", label: "חברה" },
      { key: "owner", label: "בעלים" },
      { key: "created", label: "נוצר" },
    ],
    defaults: ["phone", "email", "company", "owner", "created"],
  },
  company: {
    columns: [
      { key: "phone", label: "טלפון" },
      { key: "city", label: "עיר" },
      { key: "website", label: "אתר" },
      { key: "owner", label: "בעלים" },
      { key: "created", label: "נוצר" },
    ],
    defaults: ["phone", "city", "owner", "created"],
  },
  // LST-09: the deals table (one pipeline at a time) and the tasks table
  deal: {
    columns: [
      { key: "amount", label: "סכום" },
      { key: "stage", label: "שלב" },
      { key: "status", label: "מצב" },
      { key: "contact", label: "איש קשר" },
      { key: "company", label: "חברה" },
      { key: "owner", label: "בעלים" },
      { key: "expected_close", label: "צפי סגירה" },
      { key: "created", label: "נוצרה" },
    ],
    defaults: ["amount", "stage", "contact", "owner", "expected_close"],
  },
  task: {
    columns: [
      { key: "due", label: "תאריך יעד" },
      { key: "type", label: "סוג" },
      { key: "status", label: "מצב" },
      { key: "priority", label: "עדיפות" },
      { key: "related", label: "שייכת ל" },
      { key: "owner", label: "אחראי" },
      { key: "created", label: "נוצרה" },
    ],
    defaults: ["due", "type", "related", "owner", "status"],
  },
};

export const CUSTOM_PREFIX = "cf:";

/** Every column a list can show: the built-in ones, then the organization's custom fields. */
export function catalogFor(object: ListObject, fields: Array<{ key: string; label: string }>): CatalogColumn[] {
  return [...BUILT_IN[object].columns, ...fields.map((field) => ({ key: `${CUSTOM_PREFIX}${field.key}`, label: field.label }))];
}

export const columnChoicesSchema = z
  .array(z.object({ key: z.string().min(1).max(60), width: z.enum(["narrow", "normal", "wide"]) }))
  .max(60);

/**
 * The columns to show: the saved choice, keeping only columns that still exist
 * (a field may have been hidden or deleted); the list's defaults when nothing
 * was saved.
 */
export function resolveColumns(object: ListObject, saved: unknown, catalog: CatalogColumn[]): ColumnChoice[] {
  const parsed = columnChoicesSchema.safeParse(saved);
  if (saved === null || saved === undefined || !parsed.success) {
    return BUILT_IN[object].defaults.map((key) => ({ key, width: "normal" }));
  }
  const known = new Set(catalog.map((column) => column.key));
  const seen = new Set<string>();
  return parsed.data.filter((choice) => known.has(choice.key) && !seen.has(choice.key) && seen.add(choice.key));
}

export const WIDTH_CLASS: Record<ColumnWidth, string> = {
  narrow: "min-w-24",
  normal: "min-w-36",
  wide: "min-w-64",
};

export const WIDTH_LABELS: Record<ColumnWidth, string> = { narrow: "צר", normal: "רגיל", wide: "רחב" };
