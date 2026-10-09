import { RECORD_TYPES } from "@/lib/record-types";

// What can be merged, and how each field is named on the merge screen.
// Must match app.merge_columns() in migration 0020.

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
  ],
};

export const TYPE_LABELS: Record<MergeType, { one: string; many: string }> = {
  lead: { one: "ליד", many: "לידים" },
  contact: { one: "איש קשר", many: "אנשי קשר" },
  company: { one: "חברה", many: "חברות" },
};

export const isMergeType = (value: unknown): value is MergeType => typeof value === "string" && (MERGE_TYPES as readonly string[]).includes(value);
