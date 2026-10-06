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

export const noteSchema = z.object({
  body: requiredText(5000, "יש לכתוב את ההערה לפני השמירה.", "ההערה ארוכה מדי (עד 5,000 תווים)."),
});

export const SUBJECT_COLUMN = {
  lead: "lead_id",
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
} as const satisfies Record<SubjectKind, string>;
