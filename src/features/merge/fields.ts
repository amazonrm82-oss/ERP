import { RECORD_TYPES } from "@/lib/record-types";

// What can be merged, and how each field is named on the merge screen.
// MERGE_FIELDS plus MERGE_COMPANIONS must match app.merge_columns() (latest in migration 020560, RVW-26);
// tests/db/61-disqualify-reason-everywhere.test.ts compares them.

export const MERGE_TYPES = ["lead", "contact", "company"] as const;
export type MergeType = (typeof MERGE_TYPES)[number];

export const MERGE_TABLE = { lead: RECORD_TYPES.lead.table, contact: RECORD_TYPES.contact.table, company: RECORD_TYPES.company.table } as const;

export const MERGE_FIELDS: Record<MergeType, Array<{ key: string; label: string }>> = {
  lead: [
    { key: "full_name", label: "שם מלא" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "company_name", label: "חברה" },
    { key: "job_title", label: "תפקיד" },
    { key: "status_id", label: "סטטוס" },
    { key: "source_id", label: "מקור" },
    { key: "campaign", label: "קמפיין" },
    { key: "budget_agorot", label: "תקציב" },
    { key: "message", label: "הודעה" },
    { key: "owner_id", label: "אחראי" },
    { key: "preferred_locale", label: "שפה מועדפת" },
    { key: "preferred_channel", label: "ערוץ מועדף" },
    { key: "requested_product_id", label: "מוצר מבוקש" },
  ],
  contact: [
    { key: "first_name", label: "שם פרטי" },
    { key: "last_name", label: "שם משפחה" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "job_title", label: "תפקיד" },
    { key: "company_id", label: "חברה" },
    { key: "source_id", label: "מקור" },
    { key: "birth_date", label: "יום הולדת" },
    { key: "address_line", label: "כתובת" },
    { key: "city", label: "עיר" },
    { key: "owner_id", label: "אחראי" },
    { key: "type_id", label: "סוג איש קשר" },
    { key: "preferred_locale", label: "שפה מועדפת" },
    { key: "preferred_channel", label: "ערוץ מועדף" },
    { key: "billing_name", label: "שם לחשבונית" },
    { key: "billing_tax_id", label: 'מספר עוסק או ת"ז' },
    { key: "billing_address", label: "כתובת לחיוב" },
    { key: "shipping_address", label: "כתובת למשלוח" },
    { key: "billing_email", label: "אימייל לחשבוניות" },
    { key: "payment_terms", label: "תנאי תשלום" },
    { key: "price_list_id", label: "מחירון" },
  ],
  company: [
    { key: "name", label: "שם החברה" },
    { key: "tax_id", label: "ח.פ. או עוסק מורשה" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "website", label: "אתר" },
    { key: "industry", label: "ענף" },
    { key: "address_line", label: "כתובת" },
    { key: "city", label: "עיר" },
    { key: "owner_id", label: "אחראי" },
    { key: "type_id", label: "סוג חברה" },
    { key: "billing_name", label: "שם לחשבונית" },
    { key: "billing_address", label: "כתובת לחיוב" },
    { key: "shipping_address", label: "כתובת למשלוח" },
    { key: "billing_email", label: "אימייל לחשבוניות" },
    { key: "payment_terms", label: "תנאי תשלום" },
    { key: "price_list_id", label: "מחירון" },
  ],
};

// Columns that travel with a picked field and are not offered on their own: the "not relevant"
// reason goes with the status it explains (RVW-9); a phone or email with its type, the preferred channel with
// where it came from, payment terms with their days, a company number with its country (RVW-26).
// merge_records writes every picked column in one update, so a pair is judged as a whole.
export const MERGE_COMPANIONS: Record<MergeType, Record<string, readonly string[]>> = {
  lead: { status_id: ["disqualify_reason"], preferred_channel: ["preferred_channel_source"] },
  contact: {
    phone: ["phone_type"],
    email: ["email_type"],
    preferred_channel: ["preferred_channel_source"],
    payment_terms: ["payment_days"],
  },
  company: { tax_id: ["country"], payment_terms: ["payment_days"] },
};

/** The picks sent to merge_records: each field taken from the duplicate, with its companions. */
export function mergePicks(type: MergeType, fromDuplicate: (key: string) => boolean): Record<string, "merge"> {
  const picks: Record<string, "merge"> = {};
  for (const { key } of MERGE_FIELDS[type]) {
    if (!fromDuplicate(key)) continue;
    picks[key] = "merge";
    for (const companion of MERGE_COMPANIONS[type][key] ?? []) picks[companion] = "merge";
  }
  return picks;
}

export const TYPE_LABELS: Record<MergeType, { one: string; many: string }> = {
  lead: { one: "ליד", many: "לידים" },
  contact: { one: "איש קשר", many: "אנשי קשר" },
  company: { one: "חברה", many: "חברות" },
};

export const isMergeType = (value: unknown): value is MergeType => typeof value === "string" && (MERGE_TYPES as readonly string[]).includes(value);
