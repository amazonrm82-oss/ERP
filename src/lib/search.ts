// Helpers for PostgREST `or=(...)` filters built from user input.

import { searchNorm } from "@/lib/search-norm";

/** Removes the characters that have a meaning inside a quoted PostgREST filter value. */
function sanitize(term: string): string {
  return term.replace(/["\\]/g, "").trim().slice(0, 100);
}

/**
 * `col1.ilike."%term%",col2.ilike."%term%"` for use with `.or()`.
 * Values are double-quoted so commas, dots and parentheses typed by the user
 * cannot break out of the filter. % and _ keep their LIKE meaning, which only
 * widens the user's own search. Lists use textSearchFilter / personSearchFilter
 * (normalized, FXC-11); this stays for searches over other columns.
 */
export function ilikeAny(columns: readonly string[], term: string): string | null {
  const clean = sanitize(term);
  if (clean === "") {
    return null;
  }
  return columns.map((column) => `${column}.ilike."%${clean}%"`).join(",");
}

/** An `or` part that no row satisfies: every row has an id. */
const MATCH_NOTHING = "id.is.null";

/**
 * FXC-11: the list search, the same normalization as the global search. Filters the computed field
 * `search_text` (public.search_text(<table>), migration list_search) with the term folded by searchNorm(),
 * as an exact substring (no near misses in a paginated, sorted list).
 */
export function textSearchFilter(term: string): string | null {
  const clean = sanitize(term);
  if (clean === "") {
    return null;
  }
  const norm = searchNorm(clean).replace(/["\\]/g, "");
  // a term that folds to nothing (only niqqud, geresh or quotes) finds nothing, rather than every row
  return norm.trim() === "" ? MATCH_NOTHING : `search_text.like."%${norm}%"`;
}

/**
 * Search filter for people and companies: the normalized text (name, email and the like, by table), plus the
 * phone as typed and the normalised phone column, so "052-123" finds "+97252123...".
 */
export function personSearchFilter(term: string): string | null {
  const clean = sanitize(term);
  if (clean === "") {
    return null;
  }
  const parts = [textSearchFilter(clean), `phone.ilike."%${clean}%"`].filter((part): part is string => part !== null);
  const digits = term.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length >= 3) {
    parts.push(`phone_e164.ilike."%${digits}%"`);
  }
  return parts.join(",");
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
