import { describe, expect, it } from "vitest";

import { catalogFor, resolveColumns } from "@/features/list-columns/columns";
import type { FilterTree } from "@/features/list-filters/model";
import { filterFields, filterToPostgrest } from "@/features/list-filters/server";
import { QUOTE_EXPORT_HEADER, quoteExportRows } from "@/features/quotes/export-table";
import { QUOTE_DEFAULT_SORT, QUOTE_SORT_COLUMNS, quoteListFilters, quoteListHref } from "@/features/quotes/list";
import { VIEW_FILTER_KEYS, VIEW_OBJECTS } from "@/features/views/types";

// LST-09 for the quotes list: its columns, its sort, its advanced filter, saved views and the export rows.

const ORG = "99999999-9999-4999-8999-999999999999";
const OWNER = "11111111-1111-4111-8111-111111111111";
const ctx = { userId: OWNER, now: new Date("2026-07-15T07:00:00Z") };
const lookups = { members: [{ value: OWNER, label: "דנה" }], tags: [], fields: [] };
const one = (field: string, op: string, value?: string): FilterTree => ({ match: "all", groups: [{ match: "all", conditions: [{ field, op, value }] }] });

describe("the quotes list's columns", () => {
  it("offers the list's columns, starts with today's list, and every column sorts", () => {
    const catalog = catalogFor("quote", []);
    expect(catalog.map((c) => c.key)).toEqual(["status", "customer", "owner", "quote_date", "valid_until", "sent", "total", "created"]);
    expect(resolveColumns("quote", null, catalog).map((c) => c.key)).toEqual(["status", "customer", "owner", "quote_date", "valid_until", "total"]);
    // the first column ("name": number and title) sorts too
    for (const key of ["name", ...catalog.map((column) => column.key)]) expect(Object.keys(QUOTE_SORT_COLUMNS), key).toContain(key);
  });
});

describe("the quotes list's address", () => {
  it("reads the sort, falls back to the newest quote date, and writes it back only when it differs", () => {
    expect(quoteListFilters({}).sort).toEqual(QUOTE_DEFAULT_SORT);
    expect(quoteListFilters({ sort: "-total" }).sort).toEqual({ key: "total", ascending: false });
    expect(quoteListFilters({ sort: "password" }).sort).toEqual(QUOTE_DEFAULT_SORT);
    const filters = quoteListFilters({ status: "sent", owner: OWNER, sort: "customer" });
    expect(quoteListHref(ORG, filters, 2, { f: '{"match":"all"}', sv: "v1" })).toBe(
      `/o/${ORG}/quotes?status=sent&owner=${OWNER}&sort=customer&f=%7B%22match%22%3A%22all%22%7D&sv=v1&page=2`,
    );
    expect(quoteListHref(ORG, quoteListFilters({ sort: "-quote_date" }))).toBe(`/o/${ORG}/quotes`);
  });
});

describe("the quotes list's advanced filter", () => {
  const fields = filterFields("quote", lookups);

  it("has no tag or custom fields", () => {
    expect(fields.map((f) => f.key)).toEqual(["title", "number", "status", "owner", "quote_date", "valid_until", "sent", "total", "created"]);
  });

  it("builds the query from checked values only", () => {
    expect(filterToPostgrest(one("status", "is", "accepted"), fields, ctx).logic).toBe('and(and(status.eq."accepted"))');
    expect(filterToPostgrest(one("status", "is", "won"), fields, ctx).logic).toBeNull();
    // the total is typed in shekels and stored in agorot
    expect(filterToPostgrest(one("total", "gt", "1000"), fields, ctx).logic).toBe("and(and(total_agorot.gt.100000))");
    expect(filterToPostgrest(one("number", "contains", "Q-12"), fields, ctx).logic).toBe('and(and(number_display.ilike."*Q-12*"))');
    expect(filterToPostgrest(one("owner", "is", "me"), fields, ctx).logic).toBe(`and(and(owner_id.eq.${OWNER}))`);
    expect(filterToPostgrest(one("valid_until", "empty"), fields, ctx).logic).toBe("and(and(valid_until.is.null))");
  });
});

describe("saved views of the quotes list", () => {
  it("are a list of their own and keep the list's own selects", () => {
    expect(VIEW_OBJECTS).toContain("quote");
    expect(VIEW_FILTER_KEYS).toEqual(expect.arrayContaining(["status", "f", "owner", "from", "to"]));
  });
});

describe("the quotes export", () => {
  it("writes one row per quote in the header's order, sums in shekels and days in the business's zone", () => {
    const rows = quoteExportRows(
      [
        {
          numberDisplay: "Q-1001",
          title: "שיפוץ מטבח",
          status: "sent",
          customer: "משה כהן",
          ownerId: OWNER,
          quoteDate: "2026-07-14",
          validUntil: "2026-08-13",
          // 23:30 UTC is the next day in Israel
          sentAt: "2026-07-14T23:30:00Z",
          totalAgorot: 1170050,
          createdAt: "2026-07-14T08:00:00Z",
        },
        {
          numberDisplay: null,
          title: "טיוטה",
          status: "draft",
          customer: null,
          ownerId: null,
          quoteDate: "2026-07-15",
          validUntil: null,
          sentAt: null,
          totalAgorot: 0,
          createdAt: "2026-07-15T08:00:00Z",
        },
      ],
      new Map([[OWNER, "דנה"]]),
      "Asia/Jerusalem",
    );
    expect(rows[0]).toHaveLength(QUOTE_EXPORT_HEADER.length);
    expect(rows[0]).toEqual(["Q-1001", "שיפוץ מטבח", "נשלחה", "משה כהן", "דנה", "2026-07-14", "2026-08-13", "2026-07-15", "11700.50", "2026-07-14"]);
    expect(rows[1]).toEqual(["", "טיוטה", "טיוטה", "", "", "2026-07-15", "", "", "0.00", "2026-07-15"]);
  });
});
