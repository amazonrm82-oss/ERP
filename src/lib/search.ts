// Helpers for PostgREST `or=(...)` filters built from user input.

/** Removes the characters that have a meaning inside a quoted PostgREST filter value. */
function sanitize(term: string): string {
  return term.replace(/["\\]/g, "").trim().slice(0, 100);
}

/**
 * `col1.ilike."%term%",col2.ilike."%term%"` for use with `.or()`.
 * Values are double-quoted so commas, dots and parentheses typed by the user
 * cannot break out of the filter. % and _ keep their LIKE meaning, which only
 * widens the user's own search.
 */
export function ilikeAny(columns: readonly string[], term: string): string | null {
  const clean = sanitize(term);
  if (clean === "") {
    return null;
  }
  return columns.map((column) => `${column}.ilike."%${clean}%"`).join(",");
}

/**
 * Search filter for people: name / email / phone as typed, plus the normalised
 * phone column so "052-123" finds "+97252123...".
 */
export function personSearchFilter(nameColumns: readonly string[], term: string): string | null {
  const base = ilikeAny([...nameColumns, "email", "phone"], term);
  if (!base) {
    return null;
  }
  const digits = term.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 3 ? `${base},phone_e164.ilike."%${digits}%"` : base;
}

export const PAGE_SIZE = 50;

/** 1-based page number from a search param; anything invalid is page 1. */
export function parsePage(value: string | string[] | undefined): number {
  const page = typeof value === "string" ? Number.parseInt(value, 10) : 1;
  return Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
}

export function firstParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
