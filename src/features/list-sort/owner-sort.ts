import type { Sort } from "@/lib/sort";

// OPS-09, owner (379) ב: sorting a whole list by owner ("אחראי", the computed field
// `sort_owner`) is slow on very large lists (about 10 s on 300,000 rows, while the
// hosted statement timeout is 8 s). So when the list as filtered holds more than
// OWNER_SORT_MAX_ROWS records, the owner sort is not offered and a URL that asks for
// it falls back to the list's default sort. Any filter that brings the list down to
// that size (search, status, tag, advanced filter, a saved view, an owner) opens it again.

export const OWNER_SORT_MAX_ROWS = 40_000;

/** The sort key every list uses for its owner column. */
export const OWNER_SORT_KEY = "owner";

export const OWNER_SORT_LIMIT_TEXT = "ברשימה גדולה כזו מיון לפי אחראי אפשרי אחרי סינון";

/** The answer of the probe: the list's row number OWNER_SORT_MAX_ROWS (0-based) read with the list's own filters. */
export type OwnerSortProbeAnswer = { data: unknown[] | null; error: unknown };

/**
 * Whether the owner sort may run, from the probe that asked for the row after the
 * first OWNER_SORT_MAX_ROWS rows. A failed probe counts as a large list: the
 * owner sort is the slow path, so it is the one left out when we cannot tell.
 */
export function ownerSortAllowed(probe: OwnerSortProbeAnswer): boolean {
  return !probe.error && (probe.data?.length ?? 0) === 0;
}

/** The sort the list really uses: the requested one, or the fallback when it is the owner sort and that is not allowed. */
export function resolveOwnerSort<K extends string>(requested: Sort<K>, fallback: Sort<K>, allowed: boolean): { sort: Sort<K>; fellBack: boolean } {
  if (requested.key === OWNER_SORT_KEY && !allowed) {
    return { sort: fallback, fellBack: true };
  }
  return { sort: requested, fellBack: false };
}

export type OwnerSortGuarded<K extends string, T> = {
  result: T;
  // the sort the list was read with
  sort: Sort<K>;
  // the owner column may not be sorted by now (the header says why)
  ownerSortBlocked: boolean;
  // the list asked for the owner sort and got the fallback (the page says why, once)
  ownerSortFellBack: boolean;
};

/**
 * Reads a list page with the owner-sort rule. `probe` reads the row after the
 * first OWNER_SORT_MAX_ROWS with the list's filters (null = no probe: picked
 * rows or an export chunk whose sort was already judged). The probe runs first
 * only when the owner sort was asked for; otherwise beside the read.
 */
export async function withOwnerSortGuard<K extends string, T>(
  requested: Sort<K>,
  fallback: Sort<K>,
  probe: (() => PromiseLike<OwnerSortProbeAnswer>) | null,
  read: (sort: Sort<K>) => Promise<T>,
): Promise<OwnerSortGuarded<K, T>> {
  if (!probe) {
    return { result: await read(requested), sort: requested, ownerSortBlocked: false, ownerSortFellBack: false };
  }
  if (requested.key === OWNER_SORT_KEY) {
    const allowed = ownerSortAllowed(await probe());
    const { sort, fellBack } = resolveOwnerSort(requested, fallback, allowed);
    return { result: await read(sort), sort, ownerSortBlocked: !allowed, ownerSortFellBack: fellBack };
  }
  const [answer, result] = await Promise.all([probe(), read(requested)]);
  return { result, sort: requested, ownerSortBlocked: !ownerSortAllowed(answer), ownerSortFellBack: false };
}
