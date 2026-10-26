// GAP-12: history in an import. The original creation date of a record and one note per row (with an optional date),
// read from the file. Pure (no database): used by the import (server.ts, deal-server.ts) and its unit tests.
// The rules the database keeps (app.original_created_on_check, public.import_record_notes): a day between 1990 and
// the business's today; a note of 1..5,000 characters.

import { parseDateCell } from "./record-cells";

export const HISTORY_DATE_MIN = "1990-01-01";
export const IMPORT_NOTE_MAX = 5000;

/** The file's columns this adds to leads, contacts, companies and deals. */
export const HISTORY_TARGETS: Array<{ key: string; label: string; synonyms: string[] }> = [
  {
    key: "original_created_on",
    label: "תאריך יצירה מקורי",
    synonyms: ["תאריך יצירה מקורי", "תאריך יצירה", "נוצר בתאריך", "תאריך פתיחה", "created", "created at", "created date", "creation date", "date created"],
  },
  { key: "import_note", label: "הערות (ייכנסו לציר הזמן)", synonyms: ["הערות", "הערה", "notes", "note", "comments", "היסטוריה"] },
  { key: "import_note_date", label: "תאריך ההערה", synonyms: ["תאריך ההערה", "תאריך הערה", "note date"] },
];

export const originalDateUnknown = (raw: string) => `תאריך היצירה המקורי "${raw}" לא זוהה (למשל 31/12/2015), ולכן לא נשמר.`;
export const originalDateOutOfRange = (raw: string) => `תאריך היצירה המקורי "${raw}" לפני 1990 או בעתיד, ולכן לא נשמר.`;
export const ORIGINAL_DATE_ON_UPDATE = "תאריך היצירה המקורי נשמר רק ברשומות חדשות, ולכן לא עודכן ברשומה הקיימת.";
export const noteDateUnknown = (raw: string) => `תאריך ההערה "${raw}" לא זוהה או שאינו בין 1990 להיום, ולכן ההערה נשמרה בלי תאריך משלה.`;
export const NOTE_TOO_LONG = "ההערה ארוכה מ-5,000 תווים ולא נשמרה.";
export const NOTE_ROW_SKIPPED = "ההערה לא נשמרה כי השורה דולגה.";
export const NOTE_FAILED = "ההערה לא נשמרה בגלל תקלה. אפשר להוסיף אותה בכרטיס.";

/** A day the database takes: a real date between 1990 and today (the business's calendar day). */
function historyDay(raw: string, today: string): { ok: true; date: string } | { ok: false; reason: "format" | "range" } {
  const date = parseDateCell(raw);
  if (!date) return { ok: false, reason: "format" };
  if (date < HISTORY_DATE_MIN || date > today) return { ok: false, reason: "range" };
  return { ok: true, date };
}

/** The original creation date cell: a date, or nothing with the reason (the row is imported without it, never guessed). */
export function originalCreatedOn(raw: string | undefined, today: string): { date: string | null; warning: string | null } {
  const cell = raw?.trim();
  if (!cell) return { date: null, warning: null };
  const day = historyDay(cell, today);
  if (day.ok) return { date: day.date, warning: null };
  return { date: null, warning: day.reason === "format" ? originalDateUnknown(cell) : originalDateOutOfRange(cell) };
}

export type ImportNote = { body: string; date: string | null };

/**
 * The note of a row. An empty note is none (its date alone is ignored); a note over 5,000 characters is not kept; a
 * date that is not a valid day leaves the note without a date of its own (the timeline then dates it by the original
 * creation date, else the import).
 */
export function importNote(body: string | undefined, date: string | undefined, today: string): { note: ImportNote | null; warning: string | null } {
  const text = body?.trim();
  if (!text) return { note: null, warning: null };
  if (Array.from(text).length > IMPORT_NOTE_MAX) return { note: null, warning: NOTE_TOO_LONG };
  const cell = date?.trim();
  if (!cell) return { note: { body: text, date: null }, warning: null };
  const day = historyDay(cell, today);
  return day.ok ? { note: { body: text, date: day.date }, warning: null } : { note: { body: text, date: null }, warning: noteDateUnknown(cell) };
}

/** True when the mapping takes the original date or a note: the wizard then says how they are kept. */
export function mapsHistory(mapping: string[]): boolean {
  return mapping.some((target) => HISTORY_TARGETS.some((t) => t.key === target));
}

/** What the wizard says when history columns are mapped. */
export const HISTORY_HINTS = [
  "תאריך היצירה המקורי נשמר ליד תאריך הייבוא ומוצג ברשימות ובכרטיס. הוא לא משנה את המדידות של המערכת: ליד מיובא לא נספר כליד שמחכה למענה, ומדיניות השמירה סופרת מיום הייבוא.",
  "הערות נכנסות לציר הזמן של הרשומה כ\"הערה מייבוא\", בשם מי שמייבא. הן לא נחשבות מגע עם הלקוח ולא פעילות לאוטומציות. ייבוא חוזר של אותו קובץ לא מוסיף אותן פעמיים, ובעלים ומנהלי מערכת יכולים למחוק הערה שגויה.",
  "תאריכים נקראים כך: 31/12/2015, 31.12.2015 או 2015-12-31. תאריך אחר, לפני 1990 או בעתיד לא נשמר, והשורה תציין את זה. ביטול הייבוא מעביר לסל המחזור את הרשומות החדשות עם ההערות שלהן.",
];

/**
 * The record card's "created" line: an imported record with an original date shows that day first, then when it came in
 * ("4.3.2012 במערכת הקודמת · יובא 26.10.2026, 14:05"); any other record shows its creation as before.
 */
export function createdLineText(createdText: string, originalText: string | null): string {
  return originalText ? `${originalText} במערכת הקודמת · יובא ${createdText}` : createdText;
}
