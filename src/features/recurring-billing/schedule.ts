// SUB-01: the schedule of a recurring billing. Mirrors app.recurring_next_cycle (with app.recurring_day_in_month) and app.recurring_monthly_amount
// (migration recurring_billing; tests/db/357-recurring-billing.test.ts compares them).

export const CYCLES = ["monthly", "quarterly", "yearly"] as const;
export type Cycle = (typeof CYCLES)[number];

export const CYCLE_LABELS: Record<Cycle, string> = { monthly: "חודשי", quarterly: "רבעוני", yearly: "שנתי" };
export const CYCLE_MONTHS: Record<Cycle, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export function isCycle(value: unknown): value is Cycle {
  return typeof value === "string" && (CYCLES as readonly string[]).includes(value);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(day: string): [number, number, number] {
  const m = DAY.exec(day);
  if (!m) throw new Error(`not a calendar day: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The last day of a month (1..12): 28..31, leap years included. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A month (may run past 12, carried into the year) and a billing day: 1..28, or 0 = the month's last day. */
function iso(year: number, month: number, billingDay: number): string {
  const y = year + Math.floor((month - 1) / 12);
  const mo = ((month - 1) % 12) + 1;
  const day = billingDay === 0 ? daysInMonth(y, mo) : billingDay;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Owner (354) ב: billing day 0 is the last day of the month. */
export const LAST_DAY_OF_MONTH = 0;

/**
 * The first billing date on or after `from` (and never before the start): the billing day of the start month, then every
 * 1, 3 or 12 months. The billing day is 1..28, or 0 = the month's last day (owner (354) ב). Null on bad input.
 */
export function nextCycleDate(start: string, cycle: Cycle, billingDay: number, from: string): string | null {
  const step = CYCLE_MONTHS[cycle];
  if (!step || !Number.isInteger(billingDay) || billingDay < 0 || billingDay > 28) return null;
  const f = from > start ? from : start;
  const [sy, sm] = parts(start);
  const [fy, fm] = parts(f);
  const months = (fy - sy) * 12 + fm - sm;
  const k = Math.ceil(months / step);
  let day = iso(sy, sm + k * step, billingDay);
  if (day < f) day = iso(sy, sm + (k + 1) * step, billingDay);
  return day;
}

/** One cycle's amount per month: quarterly / 3 and yearly / 12, rounded half up (agorot). */
export function monthlyAmount(amountAgorot: number, cycle: Cycle): number {
  const n = CYCLE_MONTHS[cycle];
  return Math.floor((2 * amountAgorot + n) / (2 * n));
}

/** The last day of the commitment: start + months - 1 day; null without a commitment. */
export function commitmentEnd(start: string, months: number): string | null {
  if (!months) return null;
  const [y, m, d] = parts(start);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  // a day missing in the target month (31 -> 30) falls back to that month's last day, like Postgres' interval
  if (date.getUTCDate() !== d) date.setUTCDate(0);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
