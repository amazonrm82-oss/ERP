import { describe, expect, it, vi } from "vitest";

// RVW-30 (a): on the waiting-leads screen a private note is not an answer (8cbfafd), the rule of
// report_money_waiting. The client below applies the filters getWaitingLeads sends, so dropping
// `.eq("is_private", false)` makes the lead with only a private note disappear from the list.

type Row = Record<string, unknown>;

const ROWS: Record<string, Row[]> = {
  lead_statuses: [{ id: "open", organization_id: "org", kind: "open" }],
  lead_sources: [],
  leads: [
    { id: "only-private", organization_id: "org", full_name: "רק הערה פרטית", status_id: "open", converted_at: null, import_job_id: null, deleted_at: null, created_at: "2026-10-19T08:00:00Z", owner_id: null, taken_at: null },
    { id: "answered", organization_id: "org", full_name: "קיבל מענה", status_id: "open", converted_at: null, import_job_id: null, deleted_at: null, created_at: "2026-10-19T08:01:00Z", owner_id: null, taken_at: null },
    { id: "system-only", organization_id: "org", full_name: "רק רשומת מערכת", status_id: "open", converted_at: null, import_job_id: null, deleted_at: null, created_at: "2026-10-19T08:02:00Z", owner_id: null, taken_at: null },
  ],
  activities: [
    { id: "a1", organization_id: "org", lead_id: "only-private", type: "note", created_by: "u1", is_private: true },
    { id: "a2", organization_id: "org", lead_id: "answered", type: "call", created_by: "u1", is_private: false },
    { id: "a3", organization_id: "org", lead_id: "system-only", type: "note", created_by: null, is_private: false },
  ],
};

const activityFilters: string[] = [];

function query(table: string) {
  let rows = ROWS[table] ?? [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      if (table === "activities") activityFilters.push(`eq:${column}`);
      rows = rows.filter((r) => r[column] === value);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      rows = rows.filter((r) => values.includes(r[column]));
      return builder;
    },
    is: (column: string, value: unknown) => {
      rows = rows.filter((r) => r[column] === value);
      return builder;
    },
    not: (column: string, op: string, value: unknown) => {
      if (op === "is" && value === null) rows = rows.filter((r) => r[column] !== null && r[column] !== undefined);
      return builder;
    },
    or: () => builder,
    order: () => builder,
    range: async () => ({ data: rows, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: query }) }));
vi.mock("@/features/shell/queries", () => ({ getUserNames: async () => new Map() }));

describe("waiting leads: a private note is not an answer (RVW-30)", () => {
  it("a lead with only a private note is still waiting; a logged call answers; a system entry does not", async () => {
    const { getWaitingLeads } = await import("@/features/leads/waiting");
    const { leads } = await getWaitingLeads("org", null);
    expect(leads.map((l) => l.id)).toEqual(["only-private", "system-only"]);
    expect(activityFilters).toContain("eq:is_private");
  });
});
