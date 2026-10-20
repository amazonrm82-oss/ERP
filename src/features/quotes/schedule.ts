import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";

// GAP-09: a quote's payment schedule. Each step has a name, a percent of the quote's total (basis points, 1..10000) and
// when it is due: a date, a short milestone ("בסיום שלב א"), or both. A draft may be incomplete; the database refuses a
// schedule over 100% (quote_schedule:over) and a quote whose schedule is not exactly 100% when it is sent
// (quote:schedule_total). At most 20 steps.

export const SCHEDULE_MAX = 20;
export const SCHEDULE_NAME_MAX = 80;
export const SCHEDULE_MILESTONE_MAX = 120;
export const FULL_BP = 10000;

export type ScheduleStep = {
  id: string;
  position: number;
  name: string;
  percentBp: number;
  dueDate: string | null;
  milestone: string | null;
};

/** A step with its share of the total, as the document shows it. */
export type ScheduleRow = Omit<ScheduleStep, "id" | "position"> & { key: string; amountAgorot: number };

function halfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < BigInt(0)) return -halfUp(-numerator, denominator);
  return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
}

/**
 * Each step's share of the total: the difference of the cumulative shares, each rounded half up, so the shares add up
 * to the total exactly when the percents add up to 100%. Mirrors app.quote_schedule() (migration quote_payment_schedule).
 */
export function scheduleAmounts(totalAgorot: number, percentsBp: readonly number[]): number[] {
  if (!Number.isSafeInteger(totalAgorot)) throw new RangeError("total");
  const total = BigInt(totalAgorot);
  const full = BigInt(FULL_BP);
  let cumulative = BigInt(0);
  let before = BigInt(0);
  return percentsBp.map((bp) => {
    if (!Number.isInteger(bp) || bp < 0) throw new RangeError("percent");
    cumulative += BigInt(bp);
    const upTo = halfUp(total * cumulative, full);
    const amount = upTo - before;
    before = upTo;
    return Number(amount);
  });
}

export function scheduleRows(totalAgorot: number, steps: readonly ScheduleStep[]): ScheduleRow[] {
  const amounts = scheduleAmounts(
    totalAgorot,
    steps.map((step) => step.percentBp),
  );
  return steps.map((step, index) => ({
    key: step.id,
    name: step.name,
    percentBp: step.percentBp,
    dueDate: step.dueDate,
    milestone: step.milestone,
    amountAgorot: amounts[index],
  }));
}

export const scheduleTotalBp = (steps: readonly Pick<ScheduleStep, "percentBp">[]) => steps.reduce((sum, step) => sum + step.percentBp, 0);

/** "30%" / "33.33%" from basis points. */
export function percentText(bp: number): string {
  const value = bp / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, "")}%`;
}

/** Whose schedule it is: a quote's (GAP-09) or an order's (ORD-04, the same mechanism). */
export type ScheduleOwner = "quote" | "order";

/** What the screen says about the schedule's total; null when there is nothing to say. */
export function scheduleTotalNote(steps: readonly Pick<ScheduleStep, "percentBp">[], owner: ScheduleOwner = "quote"): string | null {
  if (steps.length === 0) return null;
  const total = scheduleTotalBp(steps);
  if (total === FULL_BP) return null;
  return `סך האחוזים ${percentText(total)}. לפני ${owner === "order" ? "אישור ההזמנה" : "שליחת ההצעה"} הלוח צריך להגיע בדיוק ל-100%.`;
}

/** A percent as typed ("30", "33.33", "12,5") in basis points; null when it is not a percent with up to two decimals. */
export function parsePercentBp(raw: string): number | null {
  const text = raw.trim().replace(/%$/, "").trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export const SCHEDULE_FIELD_NAMES = ["name", "percent", "due_date", "milestone"] as const;

export const scheduleStepSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "יש להזין שם לתשלום.")
      .max(SCHEDULE_NAME_MAX, `עד ${SCHEDULE_NAME_MAX} תווים.`),
    percent: z
      .string()
      .transform((value, ctx) => {
        const bp = parsePercentBp(value);
        if (bp === null || bp < 1 || bp > FULL_BP) {
          ctx.addIssue({ code: "custom", message: "אחוז בין 0.01 ל-100, עם עד שתי ספרות אחרי הנקודה." });
          return z.NEVER;
        }
        return bp;
      }),
    due_date: z
      .string()
      .trim()
      .transform((value) => value || null)
      .refine((value) => value === null || isCalendarDate(value), "תאריך לא תקין."),
    milestone: z
      .string()
      .trim()
      .max(SCHEDULE_MILESTONE_MAX, `עד ${SCHEDULE_MILESTONE_MAX} תווים.`)
      .transform((value) => value || null),
  })
  .refine((step) => step.due_date !== null || step.milestone !== null, {
    message: "יש לבחור תאריך או לכתוב אבן דרך (למשל: בסיום ההתקנה).",
    path: ["milestone"],
  });
