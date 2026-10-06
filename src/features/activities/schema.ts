import { z } from "zod";

import { requiredText } from "@/lib/validation";

export const SUBJECT_KINDS = ["lead", "contact", "company", "deal"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

// The record a timeline belongs to.
export type TimelineSubject = { kind: SubjectKind; id: string };

export const subjectSchema = z.object({
  kind: z.enum(SUBJECT_KINDS),
  id: z.guid(),
});

// what a person can log on a record; the reports count these as contact with the customer
export const LOGGED_TYPES = [
  { value: "note", label: "הערה" },
  { value: "call", label: "שיחה" },
  { value: "meeting", label: "פגישה" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "אימייל" },
  { value: "sms", label: "SMS" },
] as const;

const LOGGED_TYPE_VALUES = ["note", "call", "meeting", "whatsapp", "email", "sms"] as const;

export const noteSchema = z.object({
  type: z.preprocess((value) => (value === null || value === "" ? "note" : value), z.enum(LOGGED_TYPE_VALUES, { error: "יש לבחור סוג." })),
  body: requiredText(5000, "יש לכתוב את ההערה לפני השמירה.", "ההערה ארוכה מדי (עד 5,000 תווים)."),
});

export const SUBJECT_COLUMN = {
  lead: "lead_id",
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
} as const satisfies Record<SubjectKind, string>;
