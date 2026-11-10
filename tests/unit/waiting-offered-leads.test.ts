import { describe, expect, it, vi } from "vitest";

// SPD-01 (owner (186)-(188), (212) ב): the waiting list adds the unowned leads the viewer is offered to take but does not
// read (public.unowned_leads_waiting), once each, in arrival order with the leads the session reads.

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

const OFFERED = [
  // read through the session too: shown once
  { id: "system-only", full_name: "רק רשומת מערכת", email: null, phone: null, phone_e164: null, company_name: null, source_id: null, team_id: null, created_at: "2026-10-19T08:02:00Z" },
  // offered only: shown between the others by arrival
  { id: "offered", full_name: "ליד פנוי", email: null, phone: "050-1112222", phone_e164: "+972501112222", company_name: null, source_id: null, team_id: null, created_at: "2026-10-19T08:00:30Z" },
];

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

// SPD-01 (owner (212) ב): the offered unowned leads come from public.unowned_leads_waiting; none here
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: query, rpc: async () => ({ data: OFFERED, error: null }) }) }));
vi.mock("@/features/shell/queries", () => ({ getUserNames: async () => new Map() }));

describe("waiting leads: unowned leads offered to take (SPD-01)", () => {
  it("adds the offered leads once, oldest first, without an owner", async () => {
    const { getWaitingLeads } = await import("@/features/leads/waiting");
    const { leads } = await getWaitingLeads("org", null, undefined, { offered: true });
    expect(leads.map((l) => l.id)).toEqual(["only-private", "offered", "system-only"]);
    expect(leads.find((l) => l.id === "offered")).toMatchObject({ ownerId: null, takenAt: null, phoneE164: "+972501112222", name: "ליד פנוי" });
  });

  it("every other caller (My day, the default tab) keeps the leads the session reads only", async () => {
    const { getWaitingLeads } = await import("@/features/leads/waiting");
    expect((await getWaitingLeads("org", null)).leads.map((l) => l.id)).toEqual(["only-private", "system-only"]);
  });
});
