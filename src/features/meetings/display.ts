import type { BadgeTone } from "@/components/ui/badge";
import { LOCALE } from "@/lib/app";
import { zoneDate, zoneTime } from "@/lib/format";

// Shown with the status's own words too, never by colour alone (DSN-04).
export const MEETING_STATUS_TONE: Record<string, BadgeTone> = {
  planned: "accent",
  held: "success",
  cancelled: "neutral",
  no_show: "warning",
};

/**
 * "יום ראשון, 1 בנוב׳ 2026 · 23:30–00:30" in the organization's zone. A meeting
 * that ends on another day shows the end date too.
 */
export function formatMeetingWhen(startsAt: string, endsAt: string, timeZone: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const day = new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: "long", day: "numeric", month: "short", year: "numeric" });
  const sameDay = zoneDate(start, timeZone) === zoneDate(end, timeZone);
  const endText = sameDay ? zoneTime(end, timeZone) : `${day.format(end)} ${zoneTime(end, timeZone)}`;
  return `${day.format(start)} · ${zoneTime(start, timeZone)}–${endText}`;
}

/** The form's date and times for an existing meeting, in the organization's zone. */
export function meetingFormTimes(startsAt: string, endsAt: string, timeZone: string): { date: string; start_time: string; end_time: string } {
  const start = new Date(startsAt);
  return { date: zoneDate(start, timeZone), start_time: zoneTime(start, timeZone), end_time: zoneTime(new Date(endsAt), timeZone) };
}
