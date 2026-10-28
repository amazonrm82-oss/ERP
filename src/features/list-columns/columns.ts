import { z } from "zod";

// Which columns a list shows, in what order and how wide (LST-03). Shared by the
// server (resolving a saved choice) and the "columns" panel in the browser.

export type ListObject = "lead" | "contact" | "company" | "deal" | "task" | "product" | "quote" | "document" | "payment";
// a saved choice in list_preferences: a list's columns, or the fields of a deal card on the board (DEAL-09)
export type PreferenceKey = ListObject | "deal_board";
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
      // SEG-02: the latest automatic inquiry (form, card, widget, booking page)
      { key: "last_source", label: "מקור אחרון" },
      { key: "last_inquiry", label: "פנייה אחרונה" },
      { key: "owner", label: "אחראי" },
      // LEAD-02: set from the timeline
      { key: "last_contact", label: "מגע אחרון" },
      // LEAD-04: the requested product from the catalog
      { key: "product", label: "מוצר מבוקש" },
      { key: "created", label: "נוצר" },
      // GAP-12: the creation date in the system the record was imported from
      { key: "original_created", label: "תאריך יצירה מקורי" },
      // DQL-01: share of the important fields that are filled
      { key: "completeness", label: "שלמות" },
      // LEAD-05: the sum of the business's score rules the lead matches
      { key: "score", label: "ציון" },
    ],
    defaults: ["phone", "email", "status", "source", "owner", "last_contact", "created"],
  },
  contact: {
    columns: [
      { key: "phone", label: "טלפון" },
      { key: "email", label: "אימייל" },
      { key: "job_title", label: "תפקיד" },
      { key: "company", label: "חברה" },
      // CON-02
      { key: "type", label: "סוג" },
      // CON-10
      { key: "locale", label: "שפה מועדפת" },
      { key: "channel", label: "ערוץ מועדף" },
      // SEG-02: the first source with its campaign, and the latest automatic inquiry's source
      { key: "source", label: "מקור" },
      { key: "campaign", label: "קמפיין" },
      { key: "last_source", label: "מקור אחרון" },
      { key: "last_inquiry", label: "פנייה אחרונה" },
      { key: "owner", label: "אחראי" },
      { key: "created", label: "נוצר" },
      // GAP-12: the creation date in the system the record was imported from
      { key: "original_created", label: "תאריך יצירה מקורי" },
      // DQL-01
      { key: "completeness", label: "שלמות" },
      // PAY-03: the customer's credit, only where the business sees money (CREDIT_COLUMN)
      { key: "credit", label: "יתרת זכות" },
      // BAL-02: the customer's open and overdue debt, only where the business sees balances (DEBT_COLUMNS)
      { key: "debt", label: "יתרת חוב" },
      { key: "overdue_debt", label: "חוב באיחור" },
    ],
    defaults: ["phone", "email", "company", "owner", "created"],
  },
  company: {
    columns: [
      { key: "phone", label: "טלפון" },
      { key: "city", label: "עיר" },
      { key: "website", label: "אתר" },
      // CON-02
      { key: "type", label: "סוג" },
      { key: "owner", label: "אחראי" },
      { key: "created", label: "נוצר" },
      // GAP-12: the creation date in the system the record was imported from
      { key: "original_created", label: "תאריך יצירה מקורי" },
      // PAY-03
      { key: "credit", label: "יתרת זכות" },
      // BAL-02
      { key: "debt", label: "יתרת חוב" },
      { key: "overdue_debt", label: "חוב באיחור" },
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
      { key: "owner", label: "אחראי" },
      { key: "expected_close", label: "צפי סגירה" },
      // DEAL-07: recurring revenue
      { key: "billing_kind", label: "סוג עסקה" },
      { key: "recurring_amount", label: "סכום חוזר" },
      { key: "recurring_start", label: "תאריך התחלה" },
      { key: "renewal", label: "תאריך חידוש" },
      { key: "created", label: "נוצרה" },
      // GAP-12: the creation date in the system the record was imported from
      { key: "original_created", label: "תאריך יצירה מקורי" },
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
      // TASK-06 part B: the parent of a sub-task
      { key: "parent", label: "משימת אב" },
      { key: "owner", label: "אחראי" },
      { key: "created", label: "נוצרה" },
    ],
    defaults: ["due", "type", "related", "owner", "status"],
  },
  // LST-09: the product catalog (PRD-01); no custom fields yet
  product: {
    columns: [
      { key: "sku", label: 'מק"ט' },
      { key: "barcode", label: "ברקוד" },
      { key: "category", label: "קטגוריה" },
      { key: "kind", label: "סוג" },
      { key: "price", label: "מחיר" },
      { key: "unit", label: "יחידה" },
      { key: "vat", label: 'מע"מ' },
      { key: "status", label: "מצב" },
      { key: "created", label: "נוצר" },
    ],
    defaults: ["sku", "category", "kind", "price", "unit", "vat", "status"],
  },
  // LST-09: the quotes list (QUO-16); the name column is the quote's number and title; no custom fields
  quote: {
    columns: [
      { key: "status", label: "מצב" },
      { key: "customer", label: "לקוח" },
      { key: "owner", label: "אחראי" },
      { key: "quote_date", label: "תאריך ההצעה" },
      { key: "valid_until", label: "בתוקף עד" },
      { key: "sent", label: "נשלחה" },
      { key: "total", label: "סכום" },
      { key: "created", label: "נוצרה" },
    ],
    defaults: ["status", "customer", "owner", "quote_date", "valid_until", "total"],
  },
  // LST-09: the accounting documents (DOC-01); the name column is the type and number; no custom fields
  document: {
    columns: [
      { key: "type", label: "סוג" },
      { key: "customer", label: "לקוח" },
      { key: "date", label: "תאריך המסמך" },
      { key: "amount", label: "סכום" },
      { key: "status", label: "מצב" },
      // DOC-03
      { key: "due", label: "מועד תשלום" },
      { key: "recorder", label: "נרשם על ידי" },
      { key: "created", label: "נרשם בתאריך" },
    ],
    defaults: ["type", "customer", "date", "amount", "status"],
  },
  // LST-09: the payments (PAY-01); the name column is the amount; no custom fields
  payment: {
    columns: [
      { key: "customer", label: "לקוח" },
      { key: "date", label: "תאריך התשלום" },
      { key: "method", label: "אמצעי תשלום" },
      { key: "installments", label: "מספר תשלומים" },
      { key: "reference", label: "אסמכתא" },
      { key: "status", label: "מצב" },
      { key: "recorder", label: "נרשם על ידי" },
      { key: "created", label: "נרשם בתאריך" },
    ],
    defaults: ["customer", "date", "method", "reference", "status"],
  },
};

export const CUSTOM_PREFIX = "cf:";

// LEAD-04: the leads' "requested product" column, offered only with the plan flag 'products'
export const PRODUCT_COLUMN = "product";
// PAY-03: the contacts' and companies' credit column, offered only with the money keys (payments and documents)
export const CREDIT_COLUMN = "credit";
// BAL-02: the contacts' and companies' debt columns, offered only with the balances keys (balances, documents, payments)
export const DEBT_COLUMNS: readonly string[] = ["debt", "overdue_debt"];

/**
 * Every column a list can show: the built-in ones, then the organization's custom fields.
 * `products`: whether the business has the product catalog (the leads' product column); `money`: whether it sees the
 * customer's credit (the contacts' and companies' credit column); `debt`: whether it sees the customer's debt (BAL-02).
 */
export function catalogFor(
  object: ListObject,
  fields: Array<{ key: string; label: string }>,
  options: { products?: boolean; money?: boolean; debt?: boolean } = {},
): CatalogColumn[] {
  const builtIn = BUILT_IN[object].columns.filter(
    (column) =>
      (object !== "lead" || column.key !== PRODUCT_COLUMN || options.products === true) &&
      (column.key !== CREDIT_COLUMN || options.money === true) &&
      (!DEBT_COLUMNS.includes(column.key) || options.debt === true),
  );
  return [...builtIn, ...fields.map((field) => ({ key: `${CUSTOM_PREFIX}${field.key}`, label: field.label }))];
}

/** PAY-03, BAL-02: a list's sort keys without the money columns the list does not offer (people who do not see money). */
export function offeredSortKeys(keys: string[], catalog: CatalogColumn[]): string[] {
  const gated = [CREDIT_COLUMN, ...DEBT_COLUMNS];
  return keys.filter((key) => !gated.includes(key) || catalog.some((column) => column.key === key));
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
