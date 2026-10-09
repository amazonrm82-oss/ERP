/**
 * Month grids for the date picker. Days are "YYYY-MM-DD" strings and all the
 * math is in UTC, so a user's time zone never shifts a day. Weeks start on
 * Sunday (יום ראשון), as in Israel.
 */

export const WEEKDAYS_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"] as const;
export const WEEKDAYS_LONG = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"] as const;
export const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"] as const;

function toDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, count: number): string {
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() + count);
  return toDay(date);
}

/** The same day of another month; the 31st becomes the month's last day. */
export function addMonths(day: string, count: number): string {
  const date = toDate(day);
  const wanted = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(wanted, last));
  return toDay(date);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: string): number {
  return toDate(day).getUTCDay();
}

export function startOfWeek(day: string): string {
  return addDays(day, -weekday(day));
}

/** Whole weeks (Sunday to Saturday) that cover the month of `day`. */
export function monthGrid(day: string): string[][] {
  const first = `${day.slice(0, 7)}-01`;
  const weeks: string[][] = [];
  let cursor = startOfWeek(first);
  const month = day.slice(0, 7);
  do {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  } while (cursor.slice(0, 7) === month);
  return weeks;
}

/** "אוקטובר 2026" */
export function monthTitle(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** "יום שישי, 9 באוקטובר 2026": what a screen reader says for a day. */
export function longDay(day: string): string {
  return `יום ${WEEKDAYS_LONG[weekday(day)]}, ${Number(day.slice(8, 10))} ב${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** "09.10.2026", as Israelis write a date. */
export function shortDay(day: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
}
