import { describe, expect, it } from "vitest";

import { READ_PAGE, readAllPages, readAllPagesByIds } from "@/lib/paged-read";

// A fake PostgREST table: `.range(from, to)` answers at most `maxRows` rows, as
// the hosted API does (Supabase default max-rows 1,000), without saying it cut.
function fakeTable(total: number, maxRows = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const readPage = async (from: number, to: number) => {
    calls.push([from, to]);
    return rows.slice(from, Math.min(to + 1, from + maxRows));
  };
  return { rows, calls, readPage };
}

describe("readAllPages (RVW-2)", () => {
  it("reads every row of a table larger than the server's 1,000-row cap", async () => {
    const table = fakeTable(4200);
    const { rows, complete } = await readAllPages(table.readPage);
    expect(complete).toBe(true);
    expect(rows).toHaveLength(4200);
    expect(rows.map((r) => r.id)).toEqual(table.rows.map((r) => r.id));
    // pages of 500, the last one short
    expect(table.calls[0]).toEqual([0, READ_PAGE - 1]);
    expect(table.calls).toHaveLength(9);
  });

  it("the old way (ask 1,001, stop below that) loses rows; the helper with pages of 1,000 does not", async () => {
    const table = fakeTable(4200);
    const old = await table.readPage(0, 1000);
    expect(old.length > 1000).toBe(false); // the old export stopped here with 1,000 rows
    const { rows } = await readAllPages(fakeTable(4200).readPage, { pageSize: 1000 });
    expect(rows).toHaveLength(4200);
  });

  it("stops after one extra empty read when the total is an exact multiple of the page", async () => {
    const table = fakeTable(2000);
    const { rows, complete } = await readAllPages(table.readPage, { pageSize: 1000 });
    expect(rows).toHaveLength(2000);
    expect(complete).toBe(true);
    expect(table.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("an empty table is one read", async () => {
    const table = fakeTable(0);
    expect(await readAllPages(table.readPage)).toEqual({ rows: [], complete: true });
    expect(table.calls).toHaveLength(1);
  });

  it("with a limit, answers the first rows and says the read is not complete", async () => {
    const table = fakeTable(7000);
    const { rows, complete } = await readAllPages(table.readPage, { limit: 5000 });
    expect(complete).toBe(false);
    expect(rows).toHaveLength(5000);
    expect(rows.at(-1)?.id).toBe(4999);
  });

  it("exactly `limit` rows is complete", async () => {
    const { rows, complete } = await readAllPages(fakeTable(5000).readPage, { limit: 5000 });
    expect(complete).toBe(true);
    expect(rows).toHaveLength(5000);
  });

  it("passes a failed read on", async () => {
    let n = 0;
    const failing = async (from: number, to: number) => {
      n += 1;
      if (n === 2) throw new Error("timeout");
      return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    };
    await expect(readAllPages(failing)).rejects.toThrow("timeout");
  });

  it("refuses a page size that is not a positive integer", async () => {
    await expect(readAllPages(fakeTable(10).readPage, { pageSize: 0 })).rejects.toThrow();
  });
});

describe("readAllPagesByIds (RVW-2)", () => {
  it("pages through each slice of ids, even when one slice has more than 1,000 rows", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    // every id has 5 rows: 1,000 rows per slice of 200
    const rowsFor = (slice: string[]) => slice.flatMap((id) => Array.from({ length: 5 }, (_, k) => `${id}:${k}`));
    const slices: number[] = [];
    const rows = await readAllPagesByIds(ids, async (slice, from, to) => {
      slices.push(slice.length);
      return rowsFor(slice).slice(from, Math.min(to + 1, from + 1000));
    });
    expect(rows).toHaveLength(450 * 5);
    expect(new Set(rows).size).toBe(450 * 5);
    expect(slices.filter((n) => n === 200).length).toBeGreaterThan(2);
  });

  it("no ids, no reads", async () => {
    let called = false;
    const rows = await readAllPagesByIds([], async () => {
      called = true;
      return [];
    });
    expect(rows).toEqual([]);
    expect(called).toBe(false);
  });
});
