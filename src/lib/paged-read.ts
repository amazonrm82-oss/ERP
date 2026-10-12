// PostgREST answers a read with at most `max-rows` rows (Supabase default
// 1,000) and says nothing when it cuts (RVW-2). A read that may return more
// rows than that pages through with `.range()` until a short page.
//
// The page size stays well under the cap, so a full page always means "ask
// again" and a short page always means "that was all". If the cap were ever
// set below the page size, every page would come back short and the read
// would stop early; keep READ_PAGE under the project's max-rows.

export const READ_PAGE = 500;

export type PagedRead<T> = {
  rows: T[];
  // false when `limit` stopped the read before the last row
  complete: boolean;
};

/**
 * Reads every row through `readPage(from, to)` (inclusive bounds, as
 * `.range(from, to)` takes them), page after page, until a page comes back
 * shorter than asked. With `limit`, stops once more than `limit` rows are in
 * and answers the first `limit` with `complete: false`.
 */
export async function readAllPages<T>(
  readPage: (from: number, to: number) => Promise<T[]>,
  options: { pageSize?: number; limit?: number } = {},
): Promise<PagedRead<T>> {
  const pageSize = options.pageSize ?? READ_PAGE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("readAllPages: pageSize must be a positive integer");
  const limit = options.limit ?? Infinity;
  const rows: T[] = [];
  for (let from = 0; ; ) {
    const page = await readPage(from, from + pageSize - 1);
    rows.push(...page);
    if (rows.length > limit) return { rows: rows.slice(0, limit), complete: false };
    if (page.length < pageSize) return { rows, complete: true };
    from += page.length;
  }
}

/** The same for a list of ids too long for one URL: one paged read per slice of `ids`. */
export async function readAllPagesByIds<T>(
  ids: string[],
  readPage: (slice: string[], from: number, to: number) => Promise<T[]>,
  options: { sliceSize?: number; pageSize?: number } = {},
): Promise<T[]> {
  const sliceSize = options.sliceSize ?? 200;
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += sliceSize) {
    const slice = ids.slice(i, i + sliceSize);
    const { rows: part } = await readAllPages((from, to) => readPage(slice, from, to), { pageSize: options.pageSize });
    rows.push(...part);
  }
  return rows;
}
