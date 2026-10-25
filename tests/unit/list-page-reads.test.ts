import { beforeEach, describe, expect, it, vi } from "vitest";

// FXC-09: a list page asks for the same lookups in its filter and in its table cells. Each reader is memoized per
// request with React's cache(); the unit environment loads React's client build, where cache() does not memoize,
// so this test gives cache() a plain memo (one request) and counts the reads that reach the database.

const reads: string[] = [];
const ROWS: Record<string, unknown[]> = {
  lead_statuses: [{ id: "s1", name: "חדש", kind: "open", is_default: true, position: 0 }],
  lead_sources: [{ id: "o1", name: "אתר", is_active: true }],
  memberships: [{ user_id: "u1", role: "owner", seat_type: "full", status: "active", is_available: true, created_at: "2026-10-01T00:00:00Z" }],
  profiles: [{ id: "u1", full_name: "דנה", email: "dana@example.test" }],
  tags: [{ id: "t1", name: "חם", color: null }],
  record_types: [],
};

function query(table: string) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    // PAY-03: the plan's money keys (one subscriptions and one plans read per request)
    maybeSingle: () => ({
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
        reads.push(table);
        const row = table === "subscriptions" ? { plan_key: "pro", feature_overrides: {} } : table === "plans" ? { features: {} } : null;
        return Promise.resolve({ data: row, error: null }).then(resolve);
      },
    }),
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => {
      reads.push(table);
      return Promise.resolve({ data: ROWS[table] ?? [], error: null }).then(resolve);
    },
  };
  return builder;
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // one request: every call with the same arguments shares the first call's promise
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>();
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key)!;
    };
  };
  return { ...actual, cache };
});
// PRM-01: inline editing also asks my_permissions (an RPC, not a table read; the owner holds every key)
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: query, rpc: async () => ({ data: [], error: null }) }),
}));
vi.mock("@/features/shell/queries", () => ({
  getOrgContext: async () => CONTEXT,
  getUserNames: async () => new Map(),
  canEditRecordHint: () => true,
}));

const CONTEXT = {
  user: { id: "u1", email: null, fullName: null, displayName: "דנה" },
  org: { id: "org", name: "עסק", status: "active", timeZone: "Asia/Jerusalem", currency: "ILS" },
  role: "owner",
  isAvailable: true,
  supportUntil: null,
  subscription: null,
  canWrite: true,
  canDelete: true,
  closed: false,
} as const;

describe("list page lookups are read once per request (FXC-09)", () => {
  beforeEach(() => {
    reads.length = 0;
    vi.resetModules();
  });

  it("the filter, the table cells and the page share one read of statuses, sources, members and tags", async () => {
    const { prepareListFilter, startListFilterLookups } = await import("@/features/list-filters/prepare");
    const { inlineEditing } = await import("@/features/inline-edit/server");
    const { getLeadLookups } = await import("@/features/leads/queries");
    const { listTags } = await import("@/features/tags/queries");

    // the leads page: the filter's choices start next to the columns, then the filter, then the table's pieces
    await startListFilterLookups("org", "lead");
    const filter = await prepareListFilter("org", "lead", "", "u1", []);
    const [editing, lookups, tags] = await Promise.all([inlineEditing("org", CONTEXT as never), getLeadLookups("org"), listTags("org")]);

    expect(filter.fields.length).toBeGreaterThan(0);
    expect(editing.owners).toEqual([{ value: "u1", label: "דנה" }]);
    expect(lookups.statuses).toHaveLength(1);
    expect(tags).toHaveLength(1);
    expect([...reads].sort()).toEqual(["lead_sources", "lead_statuses", "memberships", "profiles", "tags"]);
  });

  it("each list type reads its own choices once", async () => {
    const { prepareListFilter, startListFilterLookups } = await import("@/features/list-filters/prepare");
    for (const object of ["contact", "company", "deal", "task"] as const) {
      reads.length = 0;
      vi.resetModules();
      const prepare = await import("@/features/list-filters/prepare");
      await prepare.startListFilterLookups("org", object);
      await prepare.prepareListFilter("org", object, "", "u1", []);
      const counts = reads.reduce<Record<string, number>>((acc, table) => ({ ...acc, [table]: (acc[table] ?? 0) + 1 }), {});
      expect(Object.values(counts).every((n) => n === 1), `${object}: ${JSON.stringify(counts)}`).toBe(true);
    }
    expect(typeof prepareListFilter).toBe("function");
    expect(typeof startListFilterLookups).toBe("function");
  });
});
