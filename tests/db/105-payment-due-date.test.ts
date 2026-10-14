import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PAYMENT_TERMS, paymentDueDate } from "@/features/billing/terms";

import { asAdmin, asAnon, asUser, closePool, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// CON-08 follow-up (owner, 14 October 2026): one due-date rule. app.payment_due_date() and its
// TS mirror paymentDueDate() must agree on every day, kind and number of days.
describe("payment due date (CON-08)", () => {
  let user: U;

  beforeAll(async () => {
    user = await createUser("due-user");
  });

  const due = (day: string | null, terms: string | null, days: number | null) =>
    asUser(user.id, async (q) =>
      (await q<{ d: string }>("select to_char(app.payment_due_date($1::date, $2, $3), 'YYYY-MM-DD') as d", [day, terms, days])).rows[0].d,
    );

  it("follows the owner's examples, leap days and month ends included", async () => {
    expect(await due("2026-10-13", "immediate", null)).toBe("2026-10-13");
    expect(await due("2026-10-13", "net", 30)).toBe("2026-11-12");
    expect(await due("2026-10-13", "eom", 0)).toBe("2026-10-31");
    expect(await due("2026-10-13", "eom", 45)).toBe("2026-12-15");
    expect(await due("2028-02-10", "eom", 0)).toBe("2028-02-29");
    expect(await due("2028-02-29", "net", 1)).toBe("2028-03-01");
    expect(await due("2027-01-31", "eom", 30)).toBe("2027-03-02");
    expect(await due("2026-12-31", "eom", 365)).toBe("2027-12-31");
    // Saturday is not skipped
    expect(await due("2026-10-01", "net", 30)).toBe("2026-10-31");
  });

  it("refuses invalid terms with 22023, like the TS mirror", async () => {
    const bad: Array<[string | null, string | null, number | null]> = [
      ["2026-10-13", "weekly", 7],
      ["2026-10-13", "immediate", 0],
      ["2026-10-13", "net", null],
      ["2026-10-13", "eom", null],
      ["2026-10-13", "net", -1],
      ["2026-10-13", "eom", 366],
      ["2026-10-13", null, null],
      [null, "net", 30],
      // outside 0001-01-01..9999-12-31, the days the TS mirror works on
      ["infinity", "immediate", null],
      ["-infinity", "net", 1],
      ["0001-12-31 BC", "immediate", null],
      ["9999-12-31", "net", 1],
      ["9999-12-01", "eom", 1],
    ];
    for (const [day, terms, days] of bad) {
      expect(await pgError(due(day, terms, days))).toMatchObject({ code: "22023", hint: "payment_terms:invalid" });
      if (day !== null) expect(() => paymentDueDate(day, { kind: terms ?? "", days }), day).toThrow();
    }
  });

  it("agrees with paymentDueDate() at the edges of the years 0001..9999", async () => {
    const edges: Array<[string, string, number | null]> = [
      ["0001-01-01", "immediate", null],
      ["0001-01-01", "net", 365],
      ["0004-02-10", "eom", 1],
      ["0050-02-10", "eom", 0],
      ["0099-12-31", "eom", 0],
      ["0100-02-15", "eom", 0],
      ["9999-12-15", "eom", 0],
      ["9999-12-31", "net", 0],
      ["9999-12-31", "immediate", null],
    ];
    for (const [day, kind, days] of edges) {
      expect(await due(day, kind, days), `${day} ${kind} ${days}`).toBe(paymentDueDate(day, { kind, days }));
    }
  });

  it("is immutable, pins search_path, and is not executable by anon", async () => {
    const fn = await asAdmin(async (q) =>
      (
        await q<{ volatile: string; config: string[] | null; anon: boolean; auth: boolean }>(
          `select p.provolatile as volatile, p.proconfig as config,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'payment_due_date'`,
        )
      ).rows,
    );
    expect(fn).toHaveLength(1);
    expect(fn[0]).toMatchObject({ volatile: "i", anon: false, auth: true });
    expect(fn[0].config).toContain('search_path=""');
    expect((await pgError(asAnon((q) => q("select app.payment_due_date(current_date, 'immediate', null)")))).code).toBe("42501");
  });

  it("matches paymentDueDate() on every day of 2026-2028, for each kind and N", async () => {
    const numbers = [0, 1, 15, 30, 31, 45, 60, 90, 365];
    const rows = await asAdmin(async (q) =>
      (
        await q<{ day: string; kind: string; days: number | null; due: string }>(
          `with days as (select d::date as day from generate_series('2026-01-01'::date, '2028-12-31'::date, interval '1 day') d),
                cases as (
                  select 'immediate'::text as kind, null::integer as n
                  union all select k, n from unnest(array['net', 'eom']) k cross join unnest($1::integer[]) n
                )
           select to_char(days.day, 'YYYY-MM-DD') as day, cases.kind, cases.n as days,
                  to_char(app.payment_due_date(days.day, cases.kind, cases.n), 'YYYY-MM-DD') as due
             from days cross join cases
            order by 1, 2, 3`,
          [numbers],
        )
      ).rows,
    );
    // 1,096 days (2028 is a leap year) × (1 + 2 × 9) cases
    expect(rows).toHaveLength(1096 * (1 + 2 * numbers.length));
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(PAYMENT_TERMS));
    const mismatches = rows.filter((r) => paymentDueDate(r.day, { kind: r.kind, days: r.days }) !== r.due);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});
