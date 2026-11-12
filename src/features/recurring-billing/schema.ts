import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { optionalDate, requiredText } from "@/lib/validation";

import { CYCLES } from "./schedule";

// SUB-01: the form of a recurring billing. Mirrors the checks of public.recurring_billings (migration recurring_billing).

export const BILLING_NAME_MAX = 120;
export const CANCEL_REASON_MAX = 500;
export const COMMITMENT_MONTHS_MAX = 120;

export const BILLING_STATUSES = ["active", "paused", "cancelled", "failed"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  active: "פעיל",
  paused: "מושהה",
  cancelled: "בוטל",
  failed: "נכשל",
};
export const BILLING_STATUS_TONE: Record<BillingStatus, "success" | "warning" | "neutral" | "danger"> = {
  active: "success",
  paused: "warning",
  cancelled: "neutral",
  failed: "danger",
};

export function isBillingStatus(value: unknown): value is BillingStatus {
  return typeof value === "string" && (BILLING_STATUSES as readonly string[]).includes(value);
}

export const CYCLE_STATUS_LABELS: Record<string, string> = { due: "ממתין למסמך", documented: "נרשם מסמך", skipped: "דולג" };

export const EVENT_LABELS: Record<string, string> = {
  created: "החיוב נוצר",
  paused: "הושהה",
  resumed: "חודש",
  cancelled: "בוטל",
  failed: "סומן כנכשל אחרי שלושה ניסיונות",
  ended: "הגיע לתאריך הסיום",
  day_changed: "יום החיוב שונה",
  price_changed: "המחיר שונה (חל מהמחזור הבא)",
  cycle_due: "מחזור חדש: נוצרה משימה להפקת מסמך",
  cycles_skipped: "מחזורים שלא נוצרו בזמן שהחיוב לא יכול היה לרוץ",
  no_lines: "לא נוצר מחזור: אין שורות בחיוב",
  order_not_made: "לא נוצרה טיוטת הזמנה למחזור (המשימה נוצרה)",
  deal_unlinked: "הקישור לעסקה הוסר: העסקה מוזגה לעסקה של לקוח אחר",
};

const text = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

// owner (354) ב: 1..28, or 0 = the last day of the month
const billingDayField = text.transform((value, ctx) => {
  const n = Number(value);
  if (!/^\d{1,2}$/.test(value) || n < 0 || n > 28) {
    ctx.addIssue({ code: "custom", message: "יש לבחור יום חיוב: 1 עד 28, או היום האחרון בחודש." });
    return z.NEVER;
  }
  return n;
});

const commitmentField = text.transform((value, ctx) => {
  if (value === "") return 0;
  const n = Number(value);
  if (!/^\d{1,3}$/.test(value) || n > COMMITMENT_MONTHS_MAX) {
    ctx.addIssue({ code: "custom", message: `תקופת התחייבות בחודשים, 0 עד ${COMMITMENT_MONTHS_MAX}.` });
    return z.NEVER;
  }
  return n;
});

const nameField = requiredText(BILLING_NAME_MAX, "יש לתת שם לחיוב.", `השם ארוך מדי (עד ${BILLING_NAME_MAX} תווים).`);

export const newBillingSchema = z
  .object({
    name: nameField,
    cycle: z.preprocess((v) => (typeof v === "string" ? v : ""), z.enum(CYCLES, { error: "יש לבחור מחזור." })),
    start_date: text.refine((v) => isCalendarDate(v), { error: "יש לבחור תאריך התחלה." }),
    billing_day: billingDayField,
    end_date: optionalDate,
    commitment_months: commitmentField,
  })
  .refine((v) => v.end_date === null || v.end_date >= v.start_date, { path: ["end_date"], error: "תאריך הסיום צריך להיות אחרי ההתחלה." });

export const NEW_BILLING_FIELDS = ["name", "cycle", "start_date", "billing_day", "end_date", "commitment_months"] as const;

export const editBillingSchema = z.object({
  name: nameField,
  billing_day: billingDayField,
  end_date: optionalDate,
  commitment_months: commitmentField,
});

export const EDIT_BILLING_FIELDS = ["name", "billing_day", "end_date", "commitment_months"] as const;

export const cancelSchema = z.object({
  reason: requiredText(CANCEL_REASON_MAX, "יש לכתוב סיבה.", `הסיבה ארוכה מדי (עד ${CANCEL_REASON_MAX} תווים).`),
});
