import { LOCALE, TIME_ZONE } from "@/lib/app";

const moneyFormat = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "ILS" });
const moneyWholeFormat = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeZone: TIME_ZONE });
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TIME_ZONE,
});
const numberFormat = new Intl.NumberFormat(LOCALE);

/** ₪ from agorot. Whole shekels are shown without the ".00". */
export function formatMoney(agorot: number | null | undefined): string {
  const value = (agorot ?? 0) / 100;
  return Number.isInteger(value) ? moneyWholeFormat.format(value) : moneyFormat.format(value);
}

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateTimeFormat.format(date);
}

/** "1,250.50" / "1250" / "₪ 1,250" -> agorot. Returns null when it is not a valid amount. */
export function parseMoneyToAgorot(input: string): number | null {
  const cleaned = input.replace(/[₪,\s]/g, "");
  if (cleaned === "") {
    return 0;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }
  const [whole, fraction = ""] = cleaned.split(".");
  const agorot = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(agorot) ? agorot : null;
}

/** https://wa.me/<digits> from an E.164 number ("+972501234567"). */
export function whatsappUrl(phoneE164: string | null | undefined): string | null {
  const digits = (phoneE164 ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
}

export function telUrl(phoneE164: string | null | undefined, phone: string | null | undefined): string | null {
  const value = phoneE164 || (phone ?? "").replace(/[^\d+]/g, "");
  return value ? `tel:${value}` : null;
}

// --- Dates in the organization's time zone -----------------------------------

/** Offset of the zone from UTC at the given instant, in minutes (Jerusalem in summer: 180). */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const match = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

/** Calendar date "YYYY-MM-DD" of an instant in the zone. */
export function zoneDate(at: Date, timeZone: string = TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** UTC instant (ISO) of a wall-clock time on a calendar date in the zone. */
export function zonedIso(date: string, time: string, timeZone: string = TIME_ZONE): string {
  // The offset is taken at the target instant itself, not at noon: on a clock
  // change day midnight and noon have different offsets (FXC-04). The first
  // guess uses the offset at the wall-clock time read as UTC; the second
  // corrects it with the offset at the guessed instant.
  const wall = Date.parse(`${date}T${time}Z`);
  const guess = wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  return new Date(wall - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000).toISOString();
}

/** Last millisecond of "today" in the zone, as a UTC ISO string. */
export function endOfToday(now: Date = new Date(), timeZone: string = TIME_ZONE): string {
  return zonedIso(zoneDate(now, timeZone), "23:59:59.999", timeZone);
}

/** Whole days from now until the instant, rounded up; 0 when it has passed. */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) {
    return 0;
  }
  const ms = new Date(iso).getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** Wall-clock time "HH:MM" of an instant in the zone. */
export function zoneTime(at: Date, timeZone: string = TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}
