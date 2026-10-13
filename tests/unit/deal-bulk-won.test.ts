import { describe, expect, it } from "vitest";

import { bulkTasksNotice, closeDateError, pickedTotal } from "@/features/deals/close-window";
import { addBulkOnboardingTasks, type WonDeal } from "@/features/deals/onboarding-server";

const TODAY = "2026-10-15"; // a Thursday: the next working day is Sunday 18 October
const ZONE = "Asia/Jerusalem";

// A stand-in for the Supabase client: each query records its table, filters and payload,
// and is answered by `answer`. Enough for the onboarding task helpers.
type Query = { table: string; op: "select" | "insert"; filters: Record<string, unknown>; payload?: Record<string, unknown> };
function fakeClient(answer: (query: Query) => { data: unknown; error: unknown }) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const query: Query = { table, op: "select", filters: {} };
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => ((query.filters[column] = value), builder),
        neq: (column: string, value: unknown) => ((query.filters[`not ${column}`] = value), builder),
        is: (column: string, value: unknown) => ((query.filters[column] = value), builder),
        in: (column: string, values: unknown) => ((query.filters[column] = values), builder),
        like: (column: string, pattern: unknown) => ((query.filters[`like ${column}`] = pattern), builder),
        limit: () => builder,
        maybeSingle: () => builder,
        insert: (payload: Record<string, unknown>) => ((query.op = "insert"), (query.payload = payload), builder),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          queries.push(query);
          return Promise.resolve(answer(query)).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as never, queries };
}

const deal = (id: string, ownerId: string | null): WonDeal => ({ id, name: `עסקה ${id}`, ownerId, contactId: null, companyId: null });

describe("bulk close window (DEAL-04)", () => {
  it("needs one close date that is not in the future", () => {
    expect(closeDateError(TODAY, TODAY)).toBeNull();
    expect(closeDateError("2020-01-01", TODAY)).toBeNull();
    expect(closeDateError("2026-10-16", TODAY)).toBe("תאריך הסגירה לא יכול להיות בעתיד.");
    expect(closeDateError("", TODAY)).toBe("יש לבחור תאריך סגירה.");
    expect(closeDateError("2026-02-30", TODAY)).toBe("יש לבחור תאריך סגירה.");
  });

  it("sums the amounts of the picked deals", () => {
    expect(pickedTotal(["a", "b"], { a: 1_000, b: 250, c: 99 })).toBe(1_250);
    expect(pickedTotal(new Set(["a", "x"]), { a: 1_000 })).toBe(1_000);
    expect(pickedTotal([], {})).toBe(0);
  });

  it("says what happened to the onboarding tasks", () => {
    expect(bulkTasksNotice(undefined)).toBe("");
    expect(bulkTasksNotice({ created: 0, existing: 0, failed: 0 })).toBe("");
    expect(bulkTasksNotice({ created: 1, existing: 0, failed: 0 })).toBe("נוצרה משימת קליטה אחת.");
    expect(bulkTasksNotice({ created: 3, existing: 2, failed: 1 })).toBe("נוצרו 3 משימות קליטה. ל-2 עסקאות כבר יש משימת קליטה פתוחה. משימת קליטה אחת לא נוצרה.");
  });

  it("adds one task per won deal, never a second open one, with the single window's defaults", async () => {
    const { client, queries } = fakeClient((query) => {
      if (query.table === "org_calendar_settings") return { data: null, error: null };
      if (query.table === "memberships") return { data: [{ user_id: "writer" }], error: null };
      if (query.table === "tasks" && query.op === "select") return { data: query.filters.deal_id === "d2" ? [{ id: "t" }] : [], error: null };
      if (query.table === "tasks" && query.op === "insert") return { data: null, error: query.payload?.deal_id === "d4" ? { message: "denied" } : null };
      return { data: null, error: null };
    });
    const counts = await addBulkOnboardingTasks(client, "org", [deal("d1", "writer"), deal("d2", "writer"), deal("d3", "viewer"), deal("d4", null)], TODAY, ZONE);
    expect(counts).toEqual({ created: 2, existing: 1, failed: 1 });

    // the check looks for an open, live onboarding task of the deal
    const check = queries.find((query) => query.table === "tasks" && query.op === "select");
    expect(check?.filters).toMatchObject({ organization_id: "org", status: "open", deleted_at: null, "like title": "קליטת לקוח:%" });
    const inserts = queries.filter((query) => query.op === "insert").map((query) => query.payload!);
    expect(inserts.map((task) => task.deal_id)).toEqual(["d1", "d3", "d4"]);
    const first = inserts[0];
    expect(first.title).toBe("קליטת לקוח: עסקה d1");
    // the deal's owner when a member who writes; else none (the user, by the database default)
    expect(first.owner_id).toBe("writer");
    expect("owner_id" in inserts[1]).toBe(false);
    expect("owner_id" in inserts[2]).toBe(false);
    // Sunday 18 October, 09:00 in Jerusalem (UTC+3)
    expect(first.due_at).toBe("2026-10-18T06:00:00.000Z");
  });

  it("follows the business's own days off", async () => {
    const { client, queries } = fakeClient((query) => {
      if (query.table === "org_calendar_settings") {
        return { data: { rest_weekdays: [6], holidays_rest: true, holiday_eves_rest: false, rest_occasions: [] }, error: null };
      }
      return { data: query.table === "tasks" && query.op === "select" ? [] : null, error: null };
    });
    await addBulkOnboardingTasks(client, "org", [deal("d1", null)], TODAY, ZONE);
    const insert = queries.find((query) => query.op === "insert");
    // Friday is a working day here
    expect(insert?.payload?.due_at).toBe("2026-10-16T06:00:00.000Z");
  });

  it("creates nothing and counts every deal as failed when the settings cannot be read", async () => {
    const { client, queries } = fakeClient((query) => (query.table === "org_calendar_settings" ? { data: null, error: { message: "x" } } : { data: [], error: null }));
    expect(await addBulkOnboardingTasks(client, "org", [deal("d1", null), deal("d2", null)], TODAY, ZONE)).toEqual({ created: 0, existing: 0, failed: 2 });
    expect(queries.some((query) => query.op === "insert")).toBe(false);
  });

  it("does nothing without deals", async () => {
    const { client, queries } = fakeClient(() => ({ data: null, error: null }));
    expect(await addBulkOnboardingTasks(client, "org", [], TODAY, ZONE)).toEqual({ created: 0, existing: 0, failed: 0 });
    expect(queries).toHaveLength(0);
  });
});
