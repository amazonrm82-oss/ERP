// A cell of an imported sheet as text. Pure; used by the wizard (browser) and its unit tests.

const MINUTE = 60_000;

/**
 * Numbers without a binary tail, dates as "YYYY-MM-DD". read-excel-file gives a date cell as a Date
 * read as UTC, floored to the millisecond, so 14:30 can arrive as 14:29:59.999: it is rounded to
 * the minute first. A time of day is kept ("YYYY-MM-DD HH:MM") for the task due column (IMP-03);
 * the date-only parsers drop it.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const iso = new Date(Math.round(value.getTime() / MINUTE) * MINUTE).toISOString();
    return iso.slice(11, 16) === "00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  if (typeof value === "number") return Number.isInteger(value) ? value.toFixed(0) : String(value);
  return String(value).trim();
}
