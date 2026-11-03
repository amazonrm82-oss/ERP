import { describe, expect, it, vi } from "vitest";

// RVW-33: a person's export (PRV-02) carries the customer's quote decision, the quote views, the payment schedule and
// the segments the person is in, and nothing of another person's quotes. The client is a stand-in that answers each
// table from ROWS, applying the `or` filters collectPerson sends (`col.in.(…)`, `id.not.is.null`).

type Row = Record<string, unknown>;

const ME = "u-admin";
const ROWS: Record<string, Row[]> = {
  contacts: [{ id: "c1", organization_id: "org", first_name: "רונית", company_id: null }],
  leads: [],
  deals: [{ id: "dl1", contact_id: "c1", company_id: null, name: "עסקה של רונית" }],
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
  files: [
    { id: "f1", name: "Q-1.pdf", quote_id: "q1", storage_path: "org/f1", size_bytes: 10 },
    { id: "f2", name: "Q-2.pdf", quote_id: "q2", storage_path: "org/f2", size_bytes: 10 },
    { id: "f3", name: "O-1.pdf", order_id: "o1", storage_path: "org/f3", size_bytes: 10 },
    { id: "f4", name: "O-2.pdf", order_id: "o2", storage_path: "org/f4", size_bytes: 10 },
  ],
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
  accounting_documents: [
    { id: "d1", contact_id: "c1", deal_id: null, type: "tax_invoice", number: "1" },
    { id: "d2", contact_id: "c2", deal_id: null, type: "tax_invoice", number: "2" },
    // on the person's deal but recorded on another contact: listed, its lines and promises are that contact's
    { id: "d3", contact_id: "c2", deal_id: "dl1", type: "tax_invoice", number: "3" },
    // on the person's deal with no contact: the person's
    { id: "d4", contact_id: null, deal_id: "dl1", type: "proforma", number: "4" },
  ],
  accounting_document_lines: [
    { id: "dl1", document_id: "d1", description: "ייעוץ לרונית" },
    { id: "dl2", document_id: "d2", description: "של מישהו אחר" },
    { id: "dl3", document_id: "d3", description: "של איש הקשר האחר" },
    { id: "dl4", document_id: "d4", description: "על העסקה", created_by: "u-lines" },
  ],
  payment_promises: [
    { id: "pp1", contact_id: "c1", document_id: null, company_id: null, note: "רונית אמרה שתשלם", created_by: "u-other" },
    { id: "pp2", contact_id: null, document_id: "d1", company_id: null, note: "על המסמך" },
    { id: "pp3", contact_id: null, document_id: "d2", company_id: null, note: "מסמך של אחר" },
    { id: "pp4", contact_id: "c2", document_id: null, company_id: null, note: "אחר" },
    { id: "pp5", contact_id: null, document_id: "d3", company_id: null, note: "של איש הקשר האחר" },
    { id: "pp6", contact_id: null, document_id: "d4", company_id: null, note: "על העסקה" },
    // a company's promise is the company's, not the person's
    { id: "pp7", contact_id: null, document_id: null, company_id: "co1", note: "של החברה" },
  ],
  privacy_requests: [
    {
      id: "pr1",
      contact_id: "c1",
      lead_id: null,
      requester_name: "רונית",
      verified_by: "u-verifier",
      closed_by: null,
      updated_by: null,
      former_contact_ids: ["c9"],
      former_lead_ids: [],
    },
    { id: "pr2", contact_id: "c2", lead_id: null, requester_name: "אחר", former_contact_ids: [], former_lead_ids: [] },
    // linked to the person once, now to someone else: stays out
    { id: "pr3", contact_id: null, lead_id: null, requester_name: "מישהו", former_contact_ids: ["c1"], former_lead_ids: [] },
  ],
  deal_lines: [],
  task_checklist_items: [],
  payments: [],
  customer_holds: [],
  orders: [
    { id: "o1", contact_id: "c1", deal_id: null, delivery_contact_id: null },
    { id: "o2", contact_id: "c2", deal_id: null, delivery_contact_id: null },
  ],
  order_lines: [],
  order_payment_steps: [],
  order_decisions: [],
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
  let columns = "*";
  // the columns asked for, as PostgREST would answer them
  const shaped = () =>
    columns === "*"
      ? rows
      : rows.map((r) => Object.fromEntries(columns.split(",").map((c) => c.trim()).filter((c) => c in r).map((c) => [c, r[c]])));
  const builder = {
    select: (cols = "*") => {
      columns = cols;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      if (column !== "organization_id") rows = rows.filter((r) => r[column] === value);
      return builder;
    },
    or: (filter: string) => {
      rows = rows.filter((r) => matches(r, filter));
      return builder;
    },
    order: () => builder,
    range: async () => ({ data: shaped(), error: null }),
    maybeSingle: async () => ({ data: shaped()[0] ?? null, error: null }),
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

    // RVW-62: the person's document lines, payment promises (on the contact and on its documents) and privacy requests
    // (a document on the person's deal recorded on another contact is listed, its lines and promises are not)
    expect((data.accounting_documents as Row[]).map((d) => d.id)).toEqual(["d1", "d3", "d4"]);
    expect((data.accounting_document_lines as Row[]).map((l) => l.id)).toEqual(["dl1", "dl4"]);
    // a company's promise stays out
    expect((data.payment_promises as Row[]).map((p) => p.id)).toEqual(["pp1", "pp2", "pp6"]);
    // the current link only, and never the records a request was once linked to
    expect((data.privacy_requests as Row[]).map((r) => r.id)).toEqual(["pr1"]);
    expect(Object.keys((data.privacy_requests as Row[])[0])).not.toContain("former_contact_ids");
    expect(Object.keys((data.privacy_requests as Row[])[0])).not.toContain("former_lead_ids");
    // the PDFs of the person's quotes and orders, stored in the ZIP; another person's stay out
    expect((data.files as Row[]).map((f) => f.id).sort()).toEqual(["f1", "f3"]);
    expect(result!.files.map((f) => f.path).sort()).toEqual(["org/f1", "org/f3"]);
    // the people named on the new rows are looked up
    const users = (data.lookups as { users: Record<string, string> }).users;
    expect(users["u-verifier"]).toBe("שם u-verifier");
    expect(users["u-lines"]).toBe("שם u-lines");
    // every section the person export declares is in person.json
    const { PERSON_EXPORT_TABLES } = await import("@/features/privacy-export/build");
    for (const table of PERSON_EXPORT_TABLES) {
      if (table === "leads" || table === "contacts") expect(Object.keys(data.people as object)).toContain(table);
      else expect(Object.keys(data), table).toContain(table);
    }

    for (const section of ["quote_decisions", "quote_views", "quote_payment_steps", "segment_members"]) {
      expect(PERSON_EXPORT_README, section).toContain(`- ${section}`);
    }
  });
});
