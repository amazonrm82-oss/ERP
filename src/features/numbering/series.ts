import { formatNumber } from "@/lib/format";

/**
 * Running number series of quotes and orders (QUO-03, ORD-03), as
 * public.number_sequences holds them. Keep the kinds, the prefix rule and the
 * start range in step with the table's checks (unit test reads the migration).
 * The number itself is handed out only by app.next_document_number() in the
 * database; this file only shows and checks the settings.
 */
export const SERIES_KINDS = ["quote", "order"] as const;
export type SeriesKind = (typeof SERIES_KINDS)[number];

export const PREFIX_MAX = 12;
// letters (Latin, Hebrew), digits and - / . _ ; may be empty
export const PREFIX_CHARS = /^[A-Za-z0-9א-ת/._-]*$/;
// the whole rule of number_sequences_prefix_check: those characters, and never a digit at the end,
// so a printed number cannot repeat after a prefix change ("Q-1" + 35 = "Q-" + 135 = "Q-135")
export const PREFIX_PATTERN = /^([A-Za-z0-9א-ת/._-]*[A-Za-zא-ת/._-])?$/;
export const START_MIN = 1;
export const START_MAX = 999_999_999;

export const SERIES_LABELS: Record<SeriesKind, { title: string; example: string }> = {
  quote: { title: "הצעות מחיר", example: "QT-" },
  order: { title: "הזמנות", example: "ORD-" },
};

export type NumberSeries = {
  kind: SeriesKind;
  prefix: string;
  startNumber: number;
  // the last number handed out; null = none yet (the start can still change)
  lastNumber: number | null;
};

export function isSeriesKind(value: unknown): value is SeriesKind {
  return typeof value === "string" && (SERIES_KINDS as readonly string[]).includes(value);
}

/** The series of a kind as the screen uses it; no row = the defaults (no prefix, start 1). */
export function seriesFrom(kind: SeriesKind, row: { prefix: string; start_number: number; last_number: number | null } | null | undefined): NumberSeries {
  if (!row) return { kind, prefix: "", startNumber: START_MIN, lastNumber: null };
  return { kind, prefix: row.prefix, startNumber: Number(row.start_number), lastNumber: row.last_number === null ? null : Number(row.last_number) };
}

/** The number the next document of the series gets (app.next_document_number's rule). */
export function nextNumber(series: Pick<NumberSeries, "startNumber" | "lastNumber">): number {
  return series.lastNumber === null ? series.startNumber : series.lastNumber + 1;
}

/** How a number is shown on the document: prefix then digits, no separators. */
export function displayNumber(prefix: string, number: number): string {
  return `${prefix}${number}`;
}

/** The start can change only while no number of the series was handed out. */
export function startLocked(series: Pick<NumberSeries, "lastNumber">): boolean {
  return series.lastNumber !== null;
}

export function usedText(series: NumberSeries): string {
  return series.lastNumber === null
    ? "עדיין לא ניתן מספר בסדרה הזו."
    : `המספר האחרון שניתן: ${displayNumber(series.prefix, series.lastNumber)}. ${formatNumber(series.lastNumber - series.startNumber + 1)} מספרים עד היום.`;
}

export const NUMBERING_NOTE =
  "כל הצעה או הזמנה מקבלת את המספר הבא בסדרה כשהיא נוצרת. מספר שניתן לא חוזר לעולם, גם אם המסמך בוטל, ושני מסמכים לא מקבלים אותו מספר.";

/**
 * Jump forward (owner, 14 October 2026): after the first number an owner or admin may set a
 * higher next number; public.number_sequence_jump() enforces the same rule in the database.
 * Returns the message to show, or null when the jump is allowed.
 */
export function jumpProblem(series: Pick<NumberSeries, "lastNumber">, next: number): string | null {
  if (series.lastNumber === null) return "עדיין לא ניתן מספר בסדרה הזו. אפשר לשנות את המספר ההתחלתי.";
  if (!Number.isInteger(next)) return "יש לכתוב מספר שלם.";
  if (next <= series.lastNumber + 1) return `המספר הבא החדש צריך להיות גבוה מ-${series.lastNumber + 1}.`;
  if (next > START_MAX) return `המספר הבא צריך להיות עד ${START_MAX.toLocaleString("en-US")}.`;
  return null;
}

// left-to-right isolate around a document number inside a Hebrew sentence
const ltr = (text: string) => `\u2066${text}\u2069`;

/** The confirmation of a jump: the numbers left unused for good, as they would print. */
export function jumpGapText(prefix: string, lastNumber: number, next: number): string {
  return `המספרים בין ${ltr(displayNumber(prefix, lastNumber))} ל-${ltr(displayNumber(prefix, next))} יישארו ריקים לתמיד.`;
}
