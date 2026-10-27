// GAP-12 (owner, 26 October 2026, answers (1) א, (3) ב, (4) ג): an imported customer's opening balance, read from a contacts
// or companies file. Owners and admins only. Each row's balance goes through public.opening_balance_set, which REPLACES the
// customer's active opening balance (the old one is cancelled "הוחלפה בייבוא"), so a re-import never records it twice; a
// balance that holds payment allocations or credit offsets is never replaced (owner, 27 October 2026): that row's balance is skipped.
// Pure (no database): used by the import (server.ts) and its unit tests.

import { DOCUMENT_AMOUNT_MAX, parseSignedAgorot } from "@/features/documents/schema";

import { parseDateCell } from "./record-cells";

export const OPENING_DATE_MIN = "1990-01-01";

/** The file's columns this adds to contacts and companies (offered to owners and admins only). */
export const OPENING_TARGETS: Array<{ key: string; label: string; synonyms: string[] }> = [
  {
    key: "opening_balance",
    label: "יתרת פתיחה (חוב חיובי, זכות במינוס)",
    synonyms: ["יתרת פתיחה", "יתרה", "יתרה פתוחה", "חוב", "opening balance", "balance"],
  },
  { key: "opening_balance_date", label: "תאריך יתרת הפתיחה", synonyms: ["תאריך יתרת פתיחה", "תאריך היתרה", "balance date"] },
  { key: "opening_balance_due", label: "מועד תשלום של יתרת הפתיחה", synonyms: ["מועד תשלום", "לתשלום עד", "due date"] },
];

export const OPENING_KEYS: ReadonlySet<string> = new Set(OPENING_TARGETS.map((t) => t.key));

/** True when the mapping takes an opening balance column. */
export function mapsOpeningBalance(mapping: readonly string[]): boolean {
  return mapping.some((target) => OPENING_KEYS.has(target));
}

export const OPENING_ADMINS_ONLY = "יתרת פתיחה מייבאים רק בעלים ומנהלי מערכת. הסירו את העמודה מהמיפוי.";
export const openingAmountUnknown = (raw: string) => `יתרת הפתיחה "${raw}" אינה סכום (למשל 1,250 או \u200e-300), ולכן לא נרשמה.`;
export const openingDateUnknown = (raw: string) => `תאריך יתרת הפתיחה "${raw}" לא זוהה או שאינו בין 1990 להיום, ולכן היתרה לא נרשמה.`;
export const openingDueUnknown = (raw: string) => `מועד התשלום "${raw}" לא זוהה, לפני תאריך היתרה או שהיתרה היא זכות, ולכן היתרה נרשמה בלי מועד.`;
export const OPENING_ROW_SKIPPED = "יתרת הפתיחה לא נרשמה כי השורה דולגה.";
// GAP-12 follow-up (owner, 27 October 2026, answer (1) ג): the customer's balance holds allocations, so it is not replaced
export const OPENING_ALLOCATED = "יתרת הפתיחה דולגה. הסיבה: יתרת פתיחה קיימת עם תשלומים משויכים: לשחרר שיוכים ולייבא שוב";
export const OPENING_FAILED = "יתרת הפתיחה לא נרשמה בגלל תקלה. אפשר לרשום אותה בכרטיס.";

/** The warning of an opening balance the database did not write: a refused replace names its reason (the row is kept). */
export function openingFailure(error: { code?: string; hint?: string }): string {
  return error.code === "P0001" && error.hint === "opening_balance:allocated" ? OPENING_ALLOCATED : OPENING_FAILED;
}

export type ImportOpening = { amountAgorot: number; date: string; due: string | null };

/**
 * The row's opening balance: an empty amount (or 0) is none; an amount that is not a number, or a date that is not a
 * valid day between 1990 and today, records nothing (never guessed). No date = the business's today. A due date only on
 * a debt and not before the balance's date (answer (4) ג: never filled from the payment terms).
 */
export function importOpening(
  amount: string | undefined,
  date: string | undefined,
  due: string | undefined,
  today: string,
): { opening: ImportOpening | null; warning: string | null } {
  const cell = amount?.trim();
  if (!cell) return { opening: null, warning: null };
  const agorot = parseSignedAgorot(cell);
  if (agorot === null || Math.abs(agorot) > DOCUMENT_AMOUNT_MAX) return { opening: null, warning: openingAmountUnknown(cell) };
  if (agorot === 0) return { opening: null, warning: null };
  const dateCell = date?.trim();
  let day = today;
  if (dateCell) {
    const parsed = parseDateCell(dateCell);
    if (!parsed || parsed < OPENING_DATE_MIN || parsed > today) return { opening: null, warning: openingDateUnknown(dateCell) };
    day = parsed;
  }
  const dueCell = due?.trim();
  if (!dueCell) return { opening: { amountAgorot: agorot, date: day, due: null }, warning: null };
  const dueDay = parseDateCell(dueCell);
  if (!dueDay || dueDay < day || agorot < 0) return { opening: { amountAgorot: agorot, date: day, due: null }, warning: openingDueUnknown(dueCell) };
  return { opening: { amountAgorot: agorot, date: day, due: dueDay }, warning: null };
}

/** What the wizard says when an opening balance column is mapped. */
export const OPENING_HINTS = [
  "יתרת פתיחה נרשמת כמסמך \"יתרת פתיחה\" בלי מספר: סכום חיובי הוא חוב של הלקוח, סכום במינוס הוא זכות שלו.",
  "ללקוח יש יתרת פתיחה אחת בתוקף. ייבוא חוזר מחליף אותה: הקודמת מבוטלת עם הסיבה \"הוחלפה בייבוא\". יתרה שיש לה תשלומים או קיזוזים משויכים לא מוחלפת, והשורה מדווחת עם הסיבה.",
  "ביטול הייבוא (בידי בעלים או מנהל מערכת) מבטל את יתרות הפתיחה שרשם ברשומות שעוברות לסל המחזור. יתרה ברשומה שנשארת, ויתרה קודמת שהוחלפה, לא משתנות.",
  "מועד תשלום נרשם רק אם הוא בקובץ. חוב שהמועד שלו כבר עבר יסומן באיחור.",
];

/**
 * The sentence added to "הייבוא בוטל." when undoing it cancelled opening balances the import recorded (public.undo_import /
 * undo_own_import answer `opening_balances` only when there were any); "" otherwise. A balance the import replaced is not
 * restored.
 */
export function openingsUndoneText(count: number | null | undefined): string {
  if (!count || count < 1) return "";
  return count === 1 ? " גם יתרת הפתיחה שנרשמה בו בוטלה." : ` גם ${count} יתרות הפתיחה שנרשמו בו בוטלו.`;
}
