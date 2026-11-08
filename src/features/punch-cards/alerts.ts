import { z } from "zod";

import { PUNCH_LOW_ENTRIES } from "./balance";

// PKG-03 (owner's answers of 4 November 2026, (130)-(132)): a punch card alerts its rep once when it has few entries left
// and once when its last day is near. The business sets both numbers (public.punch_card_alert_settings; no row = the
// defaults); 0 switches that alert off. The database sends the alerts (app.send_punch_card_alerts, every 15 minutes);
// the contact card's badges use the same numbers.

// customerMessages: PKG-03 (127)-(129), the customer's service message beside the rep's alert; off until the business turns
// it on (the lead's choice, a question to the owner)
export const PUNCH_ALERT_DEFAULTS = { lowEntries: PUNCH_LOW_ENTRIES, expiryDays: 14, customerMessages: false } as const;
export const PUNCH_LOW_ENTRIES_MAX = 100;
export const PUNCH_EXPIRY_DAYS_MAX = 365;

export type PunchAlertSettings = { lowEntries: number; expiryDays: number; customerMessages: boolean };

export const PUNCH_ALERT_FIELD_NAMES = ["low_entries", "expiry_days", "customer_messages"] as const;

const wholeNumber = (missing: string, max: number, unit: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : undefined),
    z
      .number({ error: missing })
      .int({ error: `מספר שלם של ${unit}.` })
      .min(0, { error: `בין 0 ל-${max} ${unit}.` })
      .max(max, { error: `בין 0 ל-${max} ${unit}.` }),
  );

export const punchAlertSettingsSchema = z.object({
  low_entries: wholeNumber("יש לכתוב בכמה כניסות שנשארו להתריע.", PUNCH_LOW_ENTRIES_MAX, "כניסות"),
  expiry_days: wholeNumber("יש לכתוב כמה ימים לפני סוף התוקף להתריע.", PUNCH_EXPIRY_DAYS_MAX, "ימים"),
  // a checkbox: "on" when ticked, missing otherwise
  customer_messages: z.preprocess((value) => value === "on", z.boolean()),
});

/** Whole days from today to a day (both YYYY-MM-DD, business calendar). */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** The "התוקף מתקרב" badge: a usable card whose last day is within the business's number of days (0 = off). */
export function expiryNear(card: { usable: boolean; expiresOn: string | null }, today: string, expiryDays: number): boolean {
  if (!card.usable || card.expiresOn === null || expiryDays <= 0) return false;
  const days = daysUntil(card.expiresOn, today);
  return days >= 0 && days <= expiryDays;
}

/** "כשנשארו 2 כניסות או פחות" / "כבויה" */
export function lowEntriesText(lowEntries: number): string {
  if (lowEntries <= 0) return "כבויה";
  return lowEntries === 1 ? "כשנשארה כניסה אחת" : `כשנשארו ${lowEntries} כניסות או פחות`;
}

/** "14 ימים לפני סוף התוקף" / "כבויה" */
export function expiryDaysText(expiryDays: number): string {
  if (expiryDays <= 0) return "כבויה";
  return expiryDays === 1 ? "יום אחד לפני סוף התוקף" : `${expiryDays} ימים לפני סוף התוקף`;
}

/**
 * Owner (138) ב: the {כניסות} merge field is filled with the whole phrase (= app.punch_card_entries_text; both run
 * tests/unit/fixtures/punch-card-entries.json). Every sender of a punch_card_notice fills it with this.
 */
export function punchEntriesText(left: number): string {
  if (left <= 0) return "לא נשארו כניסות";
  if (left === 1) return "נשארה כניסה אחת";
  return `נשארו ${left} כניסות`;
}

// The notice titles, as app.punch_card_alert_title writes them (tests/unit/punch-card-alerts.test.ts reads the migration).
// Card name and numbers only, never a customer's name.
export function punchAlertTitle(kind: "low" | "expiry", remaining: number, days: number): string {
  if (kind === "low") return `כרטיסייה: ${punchEntriesText(remaining)}`;
  if (days <= 0) return "כרטיסייה: התוקף מסתיים היום";
  if (days === 1) return "כרטיסייה: התוקף מסתיים מחר";
  return `כרטיסייה: התוקף מסתיים בעוד ${days} ימים`;
}
