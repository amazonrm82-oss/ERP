// CAL-10: the public booking page's data, parsed from public.booking_page_public() / booking_submit(). Pure (unit-tested).

import { isHexColor } from "@/features/branding/color";
import { isLogoPath } from "@/features/branding/logo";
import { builtWithVisible } from "@/features/built-with/visibility";
import { buildIcs } from "@/features/calendar-feed/ics";
import type { BookingQuestion } from "@/lib/database.types";

import { readQuestions } from "./schema";

export type PublicBooking = {
  title: string;
  intro: string | null;
  business: string;
  rep: string;
  brand: { logoPath: string | null; color: string | null };
  builtWith: boolean;
  timeZone: string;
  meeting: { name: string; durationMinutes: number; format: string; location: string | null };
  questions: BookingQuestion[];
  // local dates (YYYY-MM-DD) in the business's zone
  today: string;
  lastDay: string;
  from: string;
  // the free starts of the week from `from`, as ISO instants
  slots: string[];
};

export type BookingConfirmation = {
  startsAt: string;
  endsAt: string;
  timeZone: string;
  meeting: { name: string; format: string; location: string | null };
  rep: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** The reply of booking_page_public() as the page's data; null when it is not one. */
export function publicBookingFrom(data: unknown): PublicBooking | null {
  if (!isObject(data) || !isObject(data.meeting)) return null;
  const meeting = data.meeting;
  const brand = isObject(data.brand) ? data.brand : {};
  const dates = [data.today, data.last_day, data.from];
  if (!dates.every((d) => typeof d === "string" && DATE.test(d))) return null;
  const title = text(data.title);
  const timeZone = text(data.time_zone);
  if (!title || !timeZone) return null;
  return {
    title,
    intro: text(data.intro),
    business: text(data.business) ?? "",
    rep: text(data.rep) ?? "",
    brand: { logoPath: isLogoPath(brand.logo) ? brand.logo : null, color: isHexColor(brand.color) ? brand.color : null },
    builtWith: builtWithVisible(data.built_with),
    timeZone,
    meeting: {
      name: text(meeting.name) ?? "",
      durationMinutes: typeof meeting.duration_minutes === "number" ? meeting.duration_minutes : 0,
      format: text(meeting.format) ?? "in_person",
      location: text(meeting.location),
    },
    questions: readQuestions(data.questions),
    today: data.today as string,
    lastDay: data.last_day as string,
    from: data.from as string,
    slots: Array.isArray(data.slots) ? data.slots.filter((s): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s))) : [],
  };
}

/** The reply of booking_submit() for a booking that was made; null otherwise. */
export function confirmationFrom(data: unknown): BookingConfirmation | null {
  if (!isObject(data) || data.status !== "booked" || !isObject(data.meeting)) return null;
  const startsAt = text(data.starts_at);
  const endsAt = text(data.ends_at);
  const timeZone = text(data.time_zone);
  if (!startsAt || !endsAt || !timeZone) return null;
  return {
    startsAt,
    endsAt,
    timeZone,
    meeting: { name: text(data.meeting.name) ?? "", format: text(data.meeting.format) ?? "in_person", location: text(data.meeting.location) },
    rep: text(data.rep) ?? "",
  };
}

/** YYYY-MM-DD + n days (calendar arithmetic, no time zone involved). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The local date of an instant in a zone (YYYY-MM-DD). */
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** The free starts grouped by local day, for the 7 days from `from` (days without a free time included, empty). */
export function slotsByDay(page: Pick<PublicBooking, "from" | "lastDay" | "slots" | "timeZone">): Array<{ day: string; slots: string[] }> {
  const days: Array<{ day: string; slots: string[] }> = [];
  for (let n = 0; n < 7; n++) {
    const day = addDays(page.from, n);
    if (day > page.lastDay) break;
    days.push({ day, slots: page.slots.filter((s) => localDate(s, page.timeZone) === day) });
  }
  return days;
}

/** A requested week start (`?from=`): a valid date, else none. */
export function fromParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && DATE.test(value) ? value : null;
}

/**
 * The "add to calendar" file of a booking (owner, 15 October 2026): only what booking_submit answered, plus the
 * business name the page already shows. `uid` is made once per confirmation in the browser (the meeting's id is
 * never sent to the public page).
 */
export function bookingIcs(confirmation: BookingConfirmation, business: string, uid: string, now: Date = new Date()): string {
  const title = [`${confirmation.meeting.name}${confirmation.rep ? ` עם ${confirmation.rep}` : ""}`, business.trim()].filter(Boolean).join(" · ");
  return buildIcs({
    timeZone: confirmation.timeZone,
    now,
    events: [
      {
        id: `booking-${uid}`,
        title,
        startsAt: confirmation.startsAt,
        endsAt: confirmation.endsAt,
        location: confirmation.meeting.location,
        videoUrl: null,
        status: "planned",
        updatedAt: null,
      },
    ],
  });
}
