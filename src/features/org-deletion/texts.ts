import { z } from "zod";

/**
 * ADM-03 (owner, 13 November 2026, answers (361) ב, (362) ב, (363) ב): the words of the deletion, kept pure so the unit
 * tests read them.
 */
export const ORG_DELETION_WAIT_DAYS = 30;
/** How long Supabase Auth's email code lasts (the Supabase default); = app.org_deletion_code_seconds(). */
export const ORG_DELETION_CODE_MINUTES = 60;

export type OrgDeletionStatus = {
  pending: boolean;
  scheduledFor: string | null;
  confirmedAt: string | null;
  awaitingUntil: string | null;
};

export const NO_DELETION: OrgDeletionStatus = { pending: false, scheduledFor: null, confirmedAt: null, awaitingUntil: null };

const statusSchema = z
  .object({
    pending: z.boolean(),
    scheduled_for: z.string().nullable(),
    confirmed_at: z.string().nullable(),
    awaiting_until: z.string().nullable(),
  })
  .nullable();

/** The answer of public.org_deletion_status; anything malformed reads as "nothing pending". */
export function deletionStatusFrom(data: unknown): OrgDeletionStatus {
  const parsed = statusSchema.safeParse(data);
  if (!parsed.success || !parsed.data) return NO_DELETION;
  const d = parsed.data;
  return { pending: d.pending, scheduledFor: d.scheduled_for, confirmedAt: d.confirmed_at, awaitingUntil: d.awaiting_until };
}

/** The line under the business header while a deletion is pending; the owner gets the cancel link, others whom to ask. */
export function deletionBannerText(status: OrgDeletionStatus, day: string | null, owner: boolean): string | null {
  if (!status.pending || !day) return null;
  return owner
    ? `העסק יימחק ב-${day}. עד אז אפשר רק לקרוא ולייצא.`
    : `העסק יימחק ב-${day}. עד אז אפשר רק לקרוא ולייצא. לשאלות, פנו לבעל העסק.`;
}

export const typedNameSchema = z.object({
  name: z.string().trim().min(1, "הקלידו את שם העסק").max(200, "השם ארוך מדי"),
});

/** The business name as typed must equal the business's name (spaces at the ends do not count), as the database checks. */
export function typedNameMatches(typed: string, name: string): boolean {
  return typed.trim() !== "" && typed.trim() === name.trim();
}

export const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6,10}$/, "הקלידו את הקוד בן הספרות מהאימייל"),
});

export const CONFIRM_REASON_TEXT: Record<string, string> = {
  invalid: "רק מי שביקש את המחיקה, כשהוא בעל העסק, יכול לאשר אותה.",
  expired: `אין בקשת מחיקה פתוחה (בקשה פתוחה ${ORG_DELETION_CODE_MINUTES} דקות). אפשר לבקש מחיקה מחדש.`,
  mfa: "כדי לאשר צריך להיות מחוברים עם אימות דו-שלבי. התחברו מחדש עם קוד האימות ונסו שוב.",
  pending: "מחיקת העסק כבר אושרה.",
  no_code: "עוד לא נשלח קוד לבקשה הזו, או שהקוד פג. בטלו את הבקשה ובקשו מחיקה מחדש.",
  email_change: "יש בחשבון שלכם שינוי כתובת אימייל שלא הושלם. השלימו או בטלו אותו, ואז בקשו מחיקה מחדש.",
  code: "הקוד לא נכון. בדקו את הקוד באימייל האחרון ונסו שוב.",
  tries: "היו יותר מדי ניסיונות עם קוד שגוי. בטלו את הבקשה ובקשו מחיקה מחדש, וקוד חדש יישלח.",
};

export function confirmReasonText(reason: string | undefined): string {
  return (reason && CONFIRM_REASON_TEXT[reason]) || CONFIRM_REASON_TEXT.invalid;
}

/** The day of an instant in the business's zone, in Hebrew ("13 בדצמבר 2026"); "" for a missing or broken value. */
export function deletionDayText(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", { dateStyle: "long", timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("he-IL", { dateStyle: "long" }).format(at);
  }
}
