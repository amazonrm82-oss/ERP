import { z } from "zod";

// COL-05: "לא למכור עד הסדרת חוב" on a contact or a company. Mirrors public.customer_holds (migration customer_holds).

export const HOLD_REASON_MAX = 500;

export const HOLD_LABEL = "לא למכור עד הסדרת חוב";

/** Answer 4 (א): the reason is required, up to 500 characters. */
export const holdReasonSchema = z
  .string()
  .trim()
  .min(1, { error: "יש לכתוב את הסיבה, למשל חוב פתוח מחודש מאי." })
  .max(HOLD_REASON_MAX, { error: `עד ${HOLD_REASON_MAX} תווים.` });

export type HoldSubject = { kind: "contact" | "company"; id: string };

/** The warning's wording: whose hold (the contact's own, or its company's, answer 2 (א)) and why. */
export function holdWarningText(hold: { on: "contact" | "company"; reason: string; by: string | null }): string {
  const whose = hold.on === "company" ? "החברה של הלקוח מסומנת" : "הלקוח מסומן";
  return `${whose} "${HOLD_LABEL}"${hold.by ? ` (על ידי ${hold.by})` : ""}: ${hold.reason}`;
}

// the partial unique indexes that keep one active hold per contact and per company (migration customer_holds)
const ACTIVE_HOLD_INDEXES = ["customer_holds_contact_active", "customer_holds_company_active"] as const;

/**
 * Two people setting a hold on the same customer at the same moment: the trigger's check (hint customer_hold:exists) let
 * both through and the unique index refused the second with a plain 23505. It means the same thing, so the action answers
 * with the same message (COL-05 review, low 1).
 */
export function isActiveHoldClash(error: { code?: string; message?: string; details?: string } | null | undefined): boolean {
  if (!error || error.code !== "23505") return false;
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  return ACTIVE_HOLD_INDEXES.some((index) => text.includes(index));
}
