// PKG-07, owner (117) ב: the punch cards report's "expiring" window is the user's choice of 7 / 14 / 30 / 60 days, default
// 30, kept per user and business in public.list_preferences (object_type 'punch_report', columns [{"days": n}]; the
// database's constraint list_preferences_punch_report_shape holds the same closed list).

export const PUNCH_DAYS_CHOICES = [7, 14, 30, 60] as const;
export type PunchDays = (typeof PUNCH_DAYS_CHOICES)[number];
export const PUNCH_DAYS_DEFAULT: PunchDays = 30;
export const PUNCH_REPORT_PREFERENCE = "punch_report";

export function isPunchDays(value: unknown): value is PunchDays {
  return typeof value === "number" && (PUNCH_DAYS_CHOICES as readonly number[]).includes(value);
}

/** The window stored in a preference row's `columns`, or the default for anything else. */
export function punchDaysFromColumns(columns: unknown): PunchDays {
  const first = Array.isArray(columns) && columns.length === 1 ? (columns[0] as { days?: unknown } | null) : null;
  return first && isPunchDays(first.days) ? first.days : PUNCH_DAYS_DEFAULT;
}
