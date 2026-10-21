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
