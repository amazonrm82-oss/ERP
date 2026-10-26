import { LOCALE } from "@/lib/app";

// PRV-01: the bounds of the policy (the database checks the same: lead_retention_settings_months, hint retention:months)
export const RETENTION_MONTHS_MIN = 6;
export const RETENTION_MONTHS_MAX = 120;
export const RETENTION_MONTHS_DEFAULT = 12;
// a round lists the leads 14 days before they are moved (owner, 13 October 2026)
export const RETENTION_NOTICE_DAYS = 14;
// the open round's list, one page (public.lead_retention_round_leads)
export const RETENTION_PAGE_SIZE = 100;

/** "ליד אחד" / "12 לידים", in the business's words. */
export function leadCountText(count: number, singular: string, plural: string, oneWord: string): string {
  return count === 1 ? `${singular} ${oneWord}` : `${count.toLocaleString("he-IL")} ${plural}`;
}

/** What the preview says before the policy is turned on or its months change. */
export function previewText(
  preview: { months: number; now: number; within_notice: number },
  words: { singular: string; plural: string; oneWord: string },
): string {
  if (preview.within_notice === 0) {
    return `אין היום ${words.plural} בלי קשר ${preview.months} חודשים. המדיניות תתחיל לפעול כשיהיו.`;
  }
  const count = leadCountText(preview.within_notice, words.singular, words.plural, words.oneWord);
  const today = preview.now === preview.within_notice ? "" : ` (${preview.now.toLocaleString("he-IL")} מהם כבר היום)`;
  return `${count}${today} ייכנסו לרשימה הראשונה. הרשימה נשלחת לבעלים ולמנהלי המערכת, ורק ${RETENTION_NOTICE_DAYS} יום אחר כך מה שלא סומן "להשאיר" עובר לסל המחזור.`;
}

/** A day in the business's own time zone ("26 באוק׳ 2026"). */
export function formatDayIn(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeZone }).format(date);
}

/** The state of one row of the open round's list; null = still listed, "keep" can be pressed. Neutral words (any term). */
export function retentionRowState(row: { binned: boolean; skipped: boolean; kept_at: string | null }): string | null {
  if (row.binned) return "בסל המחזור";
  if (row.kept_at) return "סומן להשאיר";
  if (row.skipped) return "פעיל שוב";
  return null;
}
