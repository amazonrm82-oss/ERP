// USR-08 (owner, 18 October 2026): four shortcuts on the installed app's icon. Each opens in the business the person
// last worked in: the business layout keeps its id in a cookie on this device, and /app/go/<target> sends there.

import { calendarPath } from "@/features/calendar/range";
import { paths } from "@/lib/paths";

export const SHORTCUTS = [
  { target: "new-lead", name: "ליד חדש", path: (orgId: string) => paths.leadNew(orgId) },
  { target: "waiting-leads", name: "לידים מחכים", path: (orgId: string) => paths.leadsWaiting(orgId) },
  { target: "my-day", name: "היום שלי", path: (orgId: string) => paths.org(orgId) },
  { target: "calendar", name: "יומן", path: (orgId: string) => calendarPath(orgId) },
] as const;

export type ShortcutTarget = (typeof SHORTCUTS)[number]["target"];

/** The cookie with the last business worked in on this device (an id only, not a secret). */
export const LAST_ORG_COOKIE = "mx-last-org";
export const LAST_ORG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function shortcutUrl(target: ShortcutTarget): string {
  return `/app/go/${target}`;
}

export function findShortcut(target: string) {
  return SHORTCUTS.find((shortcut) => shortcut.target === target) ?? null;
}

/**
 * Where a shortcut opens: the last business when the person is still an active member of it, else their only business,
 * else nothing (the business picker decides).
 */
export function shortcutOrg(lastOrg: string | null | undefined, memberOf: readonly string[]): string | null {
  if (lastOrg && memberOf.includes(lastOrg)) return lastOrg;
  return memberOf.length === 1 ? memberOf[0] : null;
}
