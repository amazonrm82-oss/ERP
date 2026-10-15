import { z } from "zod";

import { optionalText, requiredId } from "@/lib/validation";

/** CON-05: the role at a company is free text, like a contact's job title. The database keeps at most 80 characters (owner, 15 October 2026). */
export const TITLE_MAX = 80;

const TITLE_TOO_LONG = `התפקיד ארוך מדי (עד ${TITLE_MAX} תווים).`;

export const CONTACT_COMPANY_FIELD_NAMES = ["company_id", "title"] as const;

export const addContactCompanySchema = z.object({
  company_id: requiredId("יש לבחור חברה."),
  title: optionalText(TITLE_MAX, TITLE_TOO_LONG),
});

/** A changed role: trimmed, empty = none. */
export const titleArg = z
  .string()
  .max(TITLE_MAX * 4)
  .nullable()
  .transform((value) => (value ?? "").trim())
  .refine((value) => value.length <= TITLE_MAX)
  .transform((value) => (value === "" ? null : value));
