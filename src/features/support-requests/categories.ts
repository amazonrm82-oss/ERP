// USR-12: the support request's closed lists. Mirrors support_requests_category_check / _status_check (unit test reads
// the migration).

export const SUPPORT_CATEGORIES = {
  question: "שאלה על השימוש",
  bug: "משהו לא עובד",
  billing: "חבילה וחיוב",
  feature: "בקשה לשיפור",
  other: "אחר",
} as const;
export type SupportCategory = keyof typeof SUPPORT_CATEGORIES;

export const SUPPORT_STATUSES = { open: "נשלחה", in_progress: "בטיפול", closed: "טופלה" } as const;
export type SupportStatus = keyof typeof SUPPORT_STATUSES;

export const SUPPORT_SUBJECT_MAX = 120;
export const SUPPORT_MESSAGE_MAX = 2000;
export const SUPPORT_PAGE_MAX = 300;

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === "string" && Object.hasOwn(SUPPORT_CATEGORIES, value);
}

export function supportStatusLabel(value: string): string {
  return Object.hasOwn(SUPPORT_STATUSES, value) ? SUPPORT_STATUSES[value as SupportStatus] : value;
}

/**
 * The page the person came from, as a path of this site only: no query, no fragment (a public link's token or a
 * search never travels), at most 300 characters. Anything else = no page.
 */
export function supportPagePath(referrer: string | null, host: string | null): string | null {
  if (!referrer || !host) return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.host !== host || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const path = url.pathname;
  if (!path.startsWith("/") || /\s/.test(path) || path.length > SUPPORT_PAGE_MAX) return null;
  return path;
}

/** The server's check of a sent path (the database checks the same shape). */
export function validPagePath(value: string): boolean {
  return value.length >= 1 && value.length <= SUPPORT_PAGE_MAX && /^\/[^?#\s]*$/.test(value);
}
