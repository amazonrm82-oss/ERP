import { LOCALE, TIME_ZONE } from "@/lib/app";
import { zoneTime } from "@/lib/format";

// GAP-11: helpers of the printed day agenda and record card.

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone });
    return timeZone;
  } catch {
    return TIME_ZONE;
  }
}

/** The line at the top of a printed page: "הודפס ב-14 באוק׳ 2026, 09:05", in the business's time zone. */
export function printedAtText(at: Date, timeZone: string): string {
  const zone = safeZone(timeZone);
  const date = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeZone: zone }).format(at);
  return `הודפס ב-${date}, ${zoneTime(at, zone)}`;
}

/** "09:00–10:30" for a meeting, "14:00" for a task (no end), in the business's time zone. */
export function printTimeText(item: { startsAt: string; endsAt: string | null }, timeZone: string): string {
  const zone = safeZone(timeZone);
  const start = zoneTime(new Date(item.startsAt), zone);
  return item.endsAt ? `${start}–${zoneTime(new Date(item.endsAt), zone)}` : start;
}

/**
 * Whether a timeline entry goes on paper. The screen already shows only what the user may read;
 * a private note (GAP-05) that someone else wrote is seen by owners/admins on screen, but it is
 * left out of the printout so it does not leave the room on paper.
 */
export function printsTimelineEntry(entry: { isPrivate: boolean; createdBy: string | null }, userId: string): boolean {
  return !entry.isPrivate || entry.createdBy === userId;
}

/** The line under a file's name on paper (owner, 14 October 2026): date and who uploaded it, nothing else. */
export function printedFileLine(dateText: string, uploaderName: string | null): string {
  const uploader = uploaderName?.trim();
  return uploader ? `${dateText} · הועלה על ידי ${uploader}` : dateText;
}
