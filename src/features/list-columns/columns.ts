import { z } from "zod";

// Which columns a list shows, in what order and how wide (LST-03). Shared by the
// server (resolving a saved choice) and the "columns" panel in the browser.

export type ListObject = "lead" | "contact" | "company";
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
