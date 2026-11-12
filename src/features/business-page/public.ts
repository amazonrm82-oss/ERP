// BIZ-01: what the public business page receives from public.business_page_public(): only public fields. Pure.

import { readWorkingHours, WEEKDAYS } from "@/features/profile/working-hours";

export type PublicBusinessPage = {
  business: string;
  brand: { logoPath: string | null; color: string | null };
  builtWith: boolean;
  about: string | null;
  phone: string | null;
  // digits of the international number, for wa.me
  whatsapp: string | null;
  // an http(s) address to link to
  website: string | null;
  // the week, Sunday first: each day's ranges, or [] for a closed day; null = no hours shown
  hours: { day: string; ranges: string[] }[] | null;
  // the open booking pages the business links to
  booking: { title: string; token: string }[];
  form: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const TOKEN = /^[0-9a-f]{32}$/;
// a bare host (as organizations.website may hold, app.message_website_ok) becomes an https address
const BARE_HOST = /^[a-z0-9֐-׿](?:[a-z0-9֐-׿-]*[a-z0-9֐-׿])?(?:\.[a-z0-9֐-׿](?:[a-z0-9֐-׿-]*[a-z0-9֐-׿])?)+(?:\/\S*)?$/i;

/** The business's website as a link: http(s) as stored, a bare host as https; anything else is not shown. */
export function websiteHref(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^https?:\/\/[^\s/?#]+\.[^\s]+$/i.test(v)) return v;
  if (BARE_HOST.test(v)) return `https://${v}`;
  return null;
}

/** The address a person reads: the host and path, without the scheme and a trailing slash. */
export function websiteLabel(href: string): string {
  return href.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** The weekly hours as lines a visitor reads, Sunday first; a day with no range is closed. */
export function hoursLines(value: unknown): { day: string; ranges: string[] }[] | null {
  const hours = readWorkingHours(value);
  if (!hours || Object.keys(hours).length === 0) return null;
  return WEEKDAYS.map(({ key, label }) => ({
    day: label,
    ranges: (hours[key] ?? []).map((r) => `${r.start}–${r.end === "23:59" ? "24:00" : r.end}`),
  }));
}

export function publicBusinessPageFrom(data: unknown): PublicBusinessPage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const business = str(d.business);
  if (!business) return null;
  const brand = d.brand && typeof d.brand === "object" && !Array.isArray(d.brand) ? (d.brand as Record<string, unknown>) : {};
  const whatsapp = str(d.whatsapp);
  const booking = Array.isArray(d.booking)
    ? d.booking.flatMap((b) => {
        if (!b || typeof b !== "object") return [];
        const row = b as Record<string, unknown>;
        const title = str(row.title);
        const token = str(row.token);
        return title && token && TOKEN.test(token) ? [{ title, token }] : [];
      })
    : [];
  return {
    business,
    brand: { logoPath: str(brand.logo), color: str(brand.color) },
    builtWith: d.built_with === true,
    about: str(d.about),
    phone: str(d.phone),
    whatsapp: whatsapp && /^[1-9][0-9]{7,14}$/.test(whatsapp) ? whatsapp : null,
    website: websiteHref(str(d.website)),
    hours: hoursLines(d.hours ?? null),
    booking,
    form: d.form === true,
  };
}
