import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { shortDay } from "@/lib/calendar-grid";

// SGN-04: a signed contract's validity (valid_until, its last day) and renewal day (renewal_on, on or before it), and the
// alert before it ends. Pure. The database holds the same rules (migration contract_renewals):
// * org_document_settings.contract_renewal_days N (0 = off, 1..365, default 30): the alert task is made N days before the
//   renewal day, else before the last day, while the last day has not passed;
// * document_templates.default_validity_months (null = none, 1..120) fills the last day when the document is signed.

export const CONTRACT_RENEWAL_DEFAULT = 30;
export const CONTRACT_RENEWAL_MAX = 365;
export const DEFAULT_VALIDITY_MAX = 120;

/** The lead times the settings form offers. */
export const CONTRACT_RENEWAL_CHOICES: readonly number[] = [0, 7, 14, 30, 45, 60, 90];
/** The template defaults the template form offers (months; null = none). */
export const DEFAULT_VALIDITY_CHOICES: readonly number[] = [1, 3, 6, 12, 24, 36];

export function contractRenewalDaysOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= CONTRACT_RENEWAL_MAX ? value : CONTRACT_RENEWAL_DEFAULT;
}

export function contractRenewalLabel(days: number): string {
  if (days === 0) return "בלי התראה";
  if (days === 1) return "יום לפני";
  return `${days} ימים לפני`;
}

export function defaultValidityLabel(months: number | null): string {
  if (months === null) return "בלי תוקף קבוע";
  if (months === 1) return "חודש";
  if (months === 12) return "שנה";
  if (months === 24) return "שנתיים";
  if (months % 12 === 0) return `${months / 12} שנים`;
  return `${months} חודשים`;
}

/** "בתוקף עד 31.10.2027 · חידוש ב-01.10.2027", or null when no day is set. */
export function validityLine(validUntil: string | null, renewalOn: string | null): string | null {
  if (!validUntil || !isCalendarDate(validUntil)) return null;
  const parts = [`בתוקף עד ${shortDay(validUntil)}`];
  if (renewalOn && isCalendarDate(renewalOn)) parts.push(`חידוש ב-${shortDay(renewalOn)}`);
  return parts.join(" · ");
}

/** The day the alert counts back from: the renewal day, else the last day. */
export function renewalTarget(validUntil: string | null, renewalOn: string | null): string | null {
  if (!validUntil || !isCalendarDate(validUntil)) return null;
  return renewalOn && isCalendarDate(renewalOn) ? renewalOn : validUntil;
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/**
 * The last day of `months` months from `day` (= app.contract_validity_end; both run
 * tests/unit/fixtures/contract-validity-end.json): the same day `months` months later minus one day; when that month has no
 * such day, its last day (31 Jan + 1 month = 28 or 29 Feb; 1 Jan + 12 months = 31 Dec).
 */
export function validityEnd(day: string, months: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7)) - 1 + months;
  const date = Number(day.slice(8, 10));
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(targetYear, targetMonth, Math.min(date, lastDay)));
  if (date > lastDay) return target.toISOString().slice(0, 10);
  return new Date(target.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** A calendar day plus n days ("YYYY-MM-DD"). */
export function addCalendarDays(day: string, n: number): string {
  return new Date((dayNumber(day) + n) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * "מסתיים בקרוב": still valid today, and today is within `days` days of the renewal day (else the last day). With the alert
 * off (0) the list still shows the next 30 days.
 */
export function endsSoon(validUntil: string | null, renewalOn: string | null, today: string, days: number): boolean {
  const target = renewalTarget(validUntil, renewalOn);
  if (!target || !validUntil || !isCalendarDate(today)) return false;
  const window = days > 0 ? days : CONTRACT_RENEWAL_DEFAULT;
  return dayNumber(validUntil) >= dayNumber(today) && dayNumber(target) - window <= dayNumber(today);
}

/** Owner (278) ב: how far back the list shows contracts whose validity has passed. */
export const EXPIRED_LIST_DAYS = 90;

/** Owner (278) ב: "פג תוקף החוזה": the last day has passed. */
export function contractExpired(validUntil: string | null, today: string): boolean {
  if (!validUntil || !isCalendarDate(validUntil) || !isCalendarDate(today)) return false;
  return dayNumber(validUntil) < dayNumber(today);
}

/** Expired within the last `days` days (the list's "פג תוקף" group). */
export function recentlyExpired(validUntil: string | null, today: string, days: number = EXPIRED_LIST_DAYS): boolean {
  return contractExpired(validUntil, today) && dayNumber(validUntil as string) >= dayNumber(today) - days;
}

const dayField = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.union([z.literal(""), z.string().refine(isCalendarDate, { error: "התאריך לא תקין." })]),
);

/** The dates form on a signed document (empty = none). */
export const validitySchema = z
  .object({ valid_until: dayField, renewal_on: dayField })
  .transform((value) => ({ validUntil: value.valid_until || null, renewalOn: value.renewal_on || null }))
  .superRefine((value, ctx) => {
    if (value.renewalOn && !value.validUntil) {
      ctx.addIssue({ code: "custom", path: ["valid_until"], message: "כדי לקבוע מועד חידוש צריך תאריך סוף תוקף." });
    } else if (value.renewalOn && value.validUntil && value.renewalOn > value.validUntil) {
      ctx.addIssue({ code: "custom", path: ["renewal_on"], message: "מועד החידוש צריך להיות לפני סוף התוקף או באותו יום." });
    }
  });

const CHOOSE = "יש לבחור מתי נוצרת ההתראה.";

export const contractRenewalSchema = z.object({
  contract_renewal_days: z.coerce.number({ error: CHOOSE }).int({ error: CHOOSE }).min(0, { error: CHOOSE }).max(CONTRACT_RENEWAL_MAX, { error: CHOOSE }),
});

/** The template form's field: "" = none, else 1..120 months. */
export const defaultValidityField = z.preprocess(
  (value) => (value === "" || value === undefined || value === null ? null : value),
  z.coerce
    .number({ error: "יש לבחור תוקף." })
    .int({ error: "יש לבחור תוקף." })
    .min(1, { error: "יש לבחור תוקף." })
    .max(DEFAULT_VALIDITY_MAX, { error: "יש לבחור תוקף." })
    .nullable(),
);
