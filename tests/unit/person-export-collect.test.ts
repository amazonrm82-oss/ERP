import { describe, expect, it, vi } from "vitest";

// RVW-33: a person's export (PRV-02) carries the customer's quote decision, the quote views, the payment schedule and
// the segments the person is in, and nothing of another person's quotes. The client is a stand-in that answers each
// table from ROWS, applying the `or` filters collectPerson sends (`col.in.(…)`, `id.not.is.null`).

type Row = Record<string, unknown>;

const ME = "u-admin";
const ROWS: Record<string, Row[]> = {
  contacts: [{ id: "c1", organization_id: "org", first_name: "רונית", company_id: null }],
  leads: [],
  deals: [],
  deal_contacts: [],
  contact_channels: [],
  contact_companies: [],
  contact_relations: [],
  activities: [
    { id: "a1", contact_id: "c1", type: "note", is_private: false, created_by: "u-other" },
    { id: "a2", contact_id: "c1", type: "note", is_private: true, created_by: "u-other" },
  ],
  tasks: [],
  meetings: [],
  files: [],
  consents: [],
  form_submissions: [],
  quotes: [
    { id: "q1", contact_id: "c1", deal_id: null, number: "Q-1" },
    { id: "q2", contact_id: "c2", deal_id: null, number: "Q-2" },
  ],
  quote_lines: [{ id: "l1", quote_id: "q1" }],
  quote_decisions: [
    {
      id: "qd1",
      quote_id: "q1",
      decision: "accepted",
      signer_name: "רונית כהן",
      signer_id_number: "000000018",
      signature_kind: "drawn",
      signature_image: "data:image/png;base64,AAAA",
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0",
      decline_reason: null,
    },
    { id: "qd2", quote_id: "q2", decision: "rejected", decline_reason: "של מישהו אחר", ip: "198.51.100.1" },
  ],
  quote_views: [
    { id: "v1", quote_id: "q1", view_count: 3, first_viewed_at: "2026-10-18T08:00:00Z", last_viewed_at: "2026-10-19T08:00:00Z" },
    { id: "v2", quote_id: "q2", view_count: 1 },
  ],
  quote_payment_steps: [
    { id: "p1", quote_id: "q1", name: "מקדמה", percent_bp: 3000 },
    { id: "p2", quote_id: "q2", name: "אחר", percent_bp: 10000 },
  ],
  segment_members: [
    { id: "m1", segment_id: "s1", contact_id: "c1", lead_id: null, added_by: "u-other" },
    { id: "m2", segment_id: "s2", contact_id: "c2", lead_id: null, added_by: "u-other" },
  ],
  segments: [
    { id: "s1", name: "לקוחות VIP" },
    { id: "s2", name: "רשימה אחרת" },
  ],
  companies: [],
  lead_statuses: [],
  lead_sources: [],
  stages: [],
  pipelines: [],
  field_definitions: [],
  contact_relation_types: [],
};

/** Whether a row passes one PostgREST `or` filter of the shapes collectPerson builds. */
function matches(row: Row, filter: string): boolean {
  const parts = filter.match(/[a-z_]+\.(?:in\.\([^)]*\)|not\.is\.null)/g) ?? [];
  return parts.some((part) => {
    const [column, op] = part.split(".");
    if (op === "not") return row[column] !== null && row[column] !== undefined;
    const values = part.slice(part.indexOf("(") + 1, -1).split(",");
    return values.includes(String(row[column]));
  });
}

function query(table: string) {
  let rows = ROWS[table] ?? [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      if (column !== "organization_id") rows = rows.filter((r) => r[column] === value);
      return builder;
    },
    or: (filter: string) => {
      rows = rows.filter((r) => matches(r, filter));
      return builder;
    },
    order: () => builder,
    range: async () => ({ data: rows, error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: query }) }));
vi.mock("@/features/shell/queries", () => ({ getUserNames: async (ids: string[]) => new Map(ids.map((id) => [id, `שם ${id}`])) }));

describe("a person's export carries the quote decision, views, schedule and segments (RVW-33)", () => {
  it("the contact's own quote's rows are in, another person's are not; the README names the new sections", async () => {
    const { collectPerson } = await import("@/features/privacy-export/collect");
    const { PERSON_EXPORT_README } = await import("@/features/privacy-export/build");
    const result = await collectPerson("org", "contact", "c1", ME);
    expect(result).not.toBeNull();
    const data = result!.data as Record<string, unknown>;

    expect((data.quotes as Row[]).map((q) => q.id)).toEqual(["q1"]);
    expect(data.quote_decisions).toEqual([ROWS.quote_decisions[0]]);
    const decision = (data.quote_decisions as Row[])[0];
    // the personal fields of the decision travel as stored
    expect([decision.signer_name, decision.signer_id_number, decision.signature_image, decision.ip, decision.user_agent]).toEqual([
      "רונית כהן",
      "000000018",
      "data:image/png;base64,AAAA",
      "203.0.113.7",
      "Mozilla/5.0",
    ]);
    expect((data.quote_views as Row[]).map((v) => v.id)).toEqual(["v1"]);
    expect((data.quote_payment_steps as Row[]).map((p) => p.id)).toEqual(["p1"]);
    expect((data.segment_members as Row[]).map((m) => m.id)).toEqual(["m1"]);
    expect((data.lookups as { segments: Record<string, string> }).segments).toEqual({ s1: "לקוחות VIP" });
    expect((data.lookups as { users: Record<string, string> }).users["u-other"]).toBe("שם u-other");
    // the rule for others' private notes still holds
    expect((data.activities as Row[]).map((a) => a.id)).toEqual(["a1"]);

    for (const section of ["quote_decisions", "quote_views", "quote_payment_steps", "segment_members"]) {
      expect(PERSON_EXPORT_README, section).toContain(`- ${section}`);
    }
  });
});
