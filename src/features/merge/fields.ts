import { RECORD_TYPES } from "@/lib/record-types";

// What can be merged, and how each field is named on the merge screen.
// MERGE_FIELDS plus MERGE_COMPANIONS must match app.merge_columns() (latest in migration 0090);
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

// Columns that travel with a picked field and are not offered on their own: the "not relevant"
// reason goes with the status it explains (RVW-9).
// merge_records applies picks in jsonb_each_text order (status_id before disqualify_reason); that order keeps the reason.
export const MERGE_COMPANIONS: Record<MergeType, Record<string, readonly string[]>> = {
  lead: { status_id: ["disqualify_reason"] },
  contact: {},
  company: {},
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
