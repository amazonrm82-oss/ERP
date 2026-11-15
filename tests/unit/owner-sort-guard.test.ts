import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListTable } from "@/features/list-columns/components/list-table";
import {
  OWNER_SORT_LIMIT_TEXT,
  OWNER_SORT_MAX_ROWS,
  ownerSortAllowed,
  resolveOwnerSort,
  withOwnerSortGuard,
  type OwnerSortProbeAnswer,
} from "@/features/list-sort/owner-sort";
import type { Sort } from "@/lib/sort";

// OPS-09, owner (379) ב: the owner sort only after a filter brings the list to 40,000 records or fewer.

type Key = "owner" | "created" | "name";
const created: Sort<Key> = { key: "created", ascending: false };
const owner: Sort<Key> = { key: "owner", ascending: true };
const small: OwnerSortProbeAnswer = { data: [], error: null };
const large: OwnerSortProbeAnswer = { data: [{ id: "x" }], error: null };

describe("owner sort rule", () => {
  it("has the owner's numbers and wording", () => {
    expect(OWNER_SORT_MAX_ROWS).toBe(40_000);
    expect(OWNER_SORT_LIMIT_TEXT).toBe("ברשימה גדולה כזו מיון לפי אחראי אפשרי אחרי סינון");
  });

  it("allows only when no row exists after the first 40,000", () => {
    expect(ownerSortAllowed(small)).toBe(true);
    expect(ownerSortAllowed({ data: null, error: null })).toBe(true);
    expect(ownerSortAllowed(large)).toBe(false);
    // a failed probe is treated as a large list
    expect(ownerSortAllowed({ data: null, error: { message: "timeout" } })).toBe(false);
  });

  it("falls back only from the owner sort", () => {
    expect(resolveOwnerSort(owner, created, false)).toEqual({ sort: created, fellBack: true });
    expect(resolveOwnerSort(owner, created, true)).toEqual({ sort: owner, fellBack: false });
    expect(resolveOwnerSort({ key: "name", ascending: true } as Sort<Key>, created, false)).toEqual({ sort: { key: "name", ascending: true }, fellBack: false });
  });
});

describe("withOwnerSortGuard", () => {
  it("never reads with the owner sort when the list is large", async () => {
    const reads: Sort<Key>[] = [];
    const out = await withOwnerSortGuard(owner, created, async () => large, async (sort) => {
      reads.push(sort);
      return "rows";
    });
    expect(reads).toEqual([created]);
    expect(out).toEqual({ result: "rows", sort: created, ownerSortBlocked: true, ownerSortFellBack: true });
  });

  it("reads with the owner sort when the filtered list is small", async () => {
    const out = await withOwnerSortGuard(owner, created, async () => small, async (sort) => sort.key);
    expect(out).toEqual({ result: "owner", sort: owner, ownerSortBlocked: false, ownerSortFellBack: false });
  });

  it("marks the header for another sort without changing it", async () => {
    const out = await withOwnerSortGuard(created, created, async () => large, async (sort) => sort.key);
    expect(out).toEqual({ result: "created", sort: created, ownerSortBlocked: true, ownerSortFellBack: false });
  });

  it("skips the probe for picked rows and export chunks", async () => {
    const out = await withOwnerSortGuard(owner, created, null, async (sort) => sort.key);
    expect(out).toEqual({ result: "owner", sort: owner, ownerSortBlocked: false, ownerSortFellBack: false });
  });
});

describe("the owner header", () => {
  const render = (blocked: boolean) =>
    renderToStaticMarkup(
      createElement(ListTable<{ id: string }>, {
        rows: [],
        rowKey: (row) => row.id,
        nameCell: () => null,
        columns: [{ key: "owner", width: "normal" }],
        catalog: [{ key: "owner", label: "אחראי" }],
        fields: [],
        cell: () => null,
        customValues: () => ({}),
        sort: { key: "created", ascending: false },
        sortHref: (key) => `?sort=${key}`,
        unsortable: blocked ? { owner: OWNER_SORT_LIMIT_TEXT } : undefined,
        label: "רשימה",
      }),
    );

  it("is a plain header that says why when blocked", () => {
    const html = render(true);
    expect(html).not.toContain("?sort=owner");
    expect(html).toContain(`title="${OWNER_SORT_LIMIT_TEXT}"`);
    expect(html).toContain(`<span class="sr-only">, ${OWNER_SORT_LIMIT_TEXT}</span>`);
  });

  it("sorts as before when not blocked", () => {
    expect(render(false)).toContain("?sort=owner");
  });
});

describe("every list that sorts by owner uses the guard", () => {
  for (const file of ["leads/queries.ts", "contacts/queries.ts", "companies/queries.ts", "deals/queries.ts", "tasks/queries.ts", "quotes/queries.ts"]) {
    it(file, () => {
      const source = readFileSync(`src/features/${file}`, "utf8");
      expect(source).toContain("withOwnerSortGuard(");
      expect(source).toContain("range(OWNER_SORT_MAX_ROWS, OWNER_SORT_MAX_ROWS)");
    });
  }
});
