// iCalendar (RFC 5545) for meetings (CAL-07): the personal calendar feed and
// the invite file sent to a customer. Plain text, no dependency.

import { APP_NAME } from "@/lib/app";

export type IcsEvent = {
  id: string;
  title: string;
  startsAt: string; // ISO timestamp
  endsAt: string;
  location: string | null;
  videoUrl: string | null;
  status: string; // planned | held | cancelled | no_show
  updatedAt: string | null;
};

export type IcsOrganizer = { name: string; email: string };

/**
 * TEXT values (RFC 5545 3.3.11): backslash, semicolon and comma are escaped and a
 * line break (CRLF, LF or a lone CR) becomes "\n". The backslash goes first, so
 * the ones added here are not doubled. Other control characters are dropped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** A parameter value (RFC 5545 3.2): always quoted, with no double quote or control character inside. */
export function quoteIcsParam(value: string): string {
  return `"${value.replace(/["\u0000-\u001f\u007f]/g, "").trim()}"`;
}

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;

/**
 * Content lines longer than 75 octets are folded (RFC 5545 3.1): CRLF and one
 * space. The space counts on the continuation line, so it carries at most 74
 * octets. A fold never splits a character (Hebrew is two octets in UTF-8).
 */
export function foldIcsLine(line: string): string {
  if (octets(line) <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const charSize = octets(char);
    if (size + charSize > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += charSize;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** UTC DATE-TIME form: 20261103T083000Z. */
export function icsDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The same meeting always has the same UID, in the feed and in an invite file. */
export function meetingUid(id: string): string {
  return `meeting-${id}@${APP_NAME.toLowerCase()}`;
}

// SEQUENCE: grows with every change of the meeting (seconds since 2020, fits 32 bits until 2088)
const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1);
export function meetingSequence(updatedAt: string | null): number {
  if (!updatedAt) return 0;
  const ms = new Date(updatedAt).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor((ms - SEQUENCE_EPOCH) / 1000)) : 0;
}

// a URL property is a URI value, not TEXT: only http(s) with no spaces or control characters
function safeUrl(value: string | null): string | null {
  return value && /^https?:\/\/[^\s"\u0000-\u001f\u007f]+$/i.test(value) ? value : null;
}

function eventLines(event: IcsEvent, stamp: string, organizer: IcsOrganizer | null): string[] {
  const video = safeUrl(event.videoUrl);
  const location = event.location?.trim() || video;
  const lines = [
    "BEGIN:VEVENT",
    `UID:${meetingUid(event.id)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsDateTime(event.startsAt)}`,
    `DTEND:${icsDateTime(event.endsAt)}`,
    `SEQUENCE:${meetingSequence(event.updatedAt)}`,
    `SUMMARY:${escapeIcsText(event.title.trim() || "פגישה")}`,
  ];
  if (event.updatedAt) lines.push(`LAST-MODIFIED:${icsDateTime(event.updatedAt)}`);
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (video) {
    lines.push(`URL:${video}`);
    // most calendar apps do not show URL; the link also goes in the text
    lines.push(`DESCRIPTION:${escapeIcsText(`קישור לשיחת הווידאו: ${video}`)}`);
  }
  if (organizer) {
    lines.push(`ORGANIZER;CN=${quoteIcsParam(organizer.name)}:mailto:${organizer.email}`);
  }
  lines.push(`STATUS:${event.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`, "TRANSP:OPAQUE", "END:VEVENT");
  return lines;
}

export type IcsCalendar = {
  // X-WR-CALNAME / NAME: what the calendar app calls the subscribed calendar
  name?: string;
  timeZone?: string;
  // a feed asks the app to refresh every hour
  refresh?: boolean;
  events: IcsEvent[];
  organizer?: IcsOrganizer | null;
  now?: Date;
};

/** A whole VCALENDAR (METHOD:PUBLISH), CRLF line ends, folded. */
export function buildIcs(calendar: IcsCalendar): string {
  const stamp = icsDateTime(calendar.now ?? new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${APP_NAME}//CRM//HE`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (calendar.name) {
    lines.push(`NAME:${escapeIcsText(calendar.name)}`, `X-WR-CALNAME:${escapeIcsText(calendar.name)}`);
  }
  if (calendar.timeZone && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(calendar.timeZone)) {
    lines.push(`X-WR-TIMEZONE:${calendar.timeZone}`);
  }
  if (calendar.refresh) {
    lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H");
  }
  const organizer = calendar.organizer && /^[^\s@:;,"<>]+@[^\s@:;,"<>]+$/.test(calendar.organizer.email) ? calendar.organizer : null;
  for (const event of calendar.events) {
    lines.push(...eventLines(event, stamp, organizer));
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/** An ASCII file name for Content-Disposition, plus the real name for browsers that read filename*. */
export function icsDisposition(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 80) || "meeting";
  return `attachment; filename="meeting.ics"; filename*=UTF-8''${encodeURIComponent(`${clean}.ics`)}`;
}

/** A feed token as made by public.calendar_feed_create(): 64 characters of base64url. */
export function isFeedToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{64}$/.test(value);
}
