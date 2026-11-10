import { LOCALE, TIME_ZONE } from "@/lib/app";
import { zoneDate } from "@/lib/format";

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/**
 * "How long ago" in short Hebrew, in the business's time zone (UX-01 phone fixes, "מגע אחרון"): under an hour in
 * minutes, the same day in hours, then "אתמול", then days up to a week, and past a week a short date ("3 בנוב׳",
 * with the year when it is another year). A time in the future (a clock out of step) reads as "לפני רגע".
 * Empty for a missing or broken time.
 */
export function relativeTimeText(iso: string | null | undefined, now: Date, timeZone: string = TIME_ZONE): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "לפני רגע";
  if (minutes < 60) return minutes === 1 ? "לפני דקה" : `לפני ${minutes} דקות`;
  const days = dayNumber(zoneDate(now, timeZone)) - dayNumber(zoneDate(at, timeZone));
  if (days <= 0) {
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? "לפני שעה" : hours === 2 ? "לפני שעתיים" : `לפני ${hours} שעות`;
  }
  if (days === 1) return "אתמול";
  if (days === 2) return "לפני יומיים";
  if (days <= 7) return `לפני ${days} ימים`;
  const sameYear = zoneDate(now, timeZone).slice(0, 4) === zoneDate(at, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone }).format(at);
}

/** The full date and time in the business's time zone, for the title beside a relative time. */
export function fullDateTimeText(iso: string | null | undefined, timeZone: string = TIME_ZONE): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "full", timeStyle: "short", timeZone }).format(at);
}
