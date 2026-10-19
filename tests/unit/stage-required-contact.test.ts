import { describe, expect, it, vi } from "vitest";

import { REQUIRED_ASKED_FIELD } from "@/features/custom-fields/required-move";
import { inputName } from "@/features/custom-fields/types";

// DEAL-05 review: a stage that requires the contact offers the newest 200 contacts, but the server accepts any contact
// the person's session reads in this business and that is not in the bin. The stand-in client plays RLS: CONTACTS
// holds what a select by organization and id returns (another business's contact and a binned one are filtered out).

const ORG = "11111111-1111-4111-8111-111111111111";
const DEAL = "22222222-2222-4222-8222-222222222222";
const STAGE = "33333333-3333-4333-8333-333333333333";
const OLD = "44444444-4444-4444-8444-444444444444";
const FOREIGN = "55555555-5555-4555-8555-555555555555";
const BINNED = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;
const CONTACTS: Row[] = [
  { id: OLD, organization_id: ORG, full_name: "לקוח ותיק", deleted_at: null },
  { id: FOREIGN, organization_id: "99999999-9999-4999-8999-999999999999", full_name: "של עסק אחר", deleted_at: null },
  { id: BINNED, organization_id: ORG, full_name: "בסל", deleted_at: "2026-10-01T00:00:00Z" },
];

function query(table: string) {
  let rows: Row[] =
    table === "stages"
      ? [{ id: STAGE, organization_id: ORG, pipeline_id: "p", required_fields: ["contact_id"] }]
      : table === "deals"
        ? [{ id: DEAL, organization_id: ORG, amount_agorot: 100, expected_close_date: null, contact_id: null }]
        : table === "contacts"
          ? CONTACTS
          : [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      rows = rows.filter((r) => r[column] === value);
      return builder;
    },
    is: (column: string, value: unknown) => {
      rows = rows.filter((r) => (r[column] ?? null) === value);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      rows = rows.filter((r) => values.includes(r[column]));
      return builder;
    },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: query }) }));
vi.mock("@/features/custom-fields/queries", () => ({ listFieldDefinitions: async () => [] }));
// the dropdown's 200 newest: OLD is not among them
vi.mock("@/features/contacts/queries", () => ({
  listContactOptions: async () => Array.from({ length: 200 }, (_, i) => ({ id: `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`, name: `חדש ${i}` })),
}));

const sendContact = (id: string) => {
  const form = new FormData();
  form.set(REQUIRED_ASKED_FIELD, "1");
  form.set(inputName("builtin:contact_id"), id);
  return form;
};

describe("the required contact of a stage (DEAL-05 review)", () => {
  it("a contact outside the newest 200 is accepted when the person reads it; another business's or a binned one is refused", async () => {
    const { requiredForMove } = await import("@/features/custom-fields/required-server");
    const accepted = await requiredForMove(ORG, "deal", DEAL, { "builtin:stage": STAGE }, sendContact(OLD));
    expect(accepted).toEqual({ ok: true, merge: undefined, columns: { contact_id: OLD } });
    for (const id of [FOREIGN, BINNED]) {
      const refused = await requiredForMove(ORG, "deal", DEAL, { "builtin:stage": STAGE }, sendContact(id));
      expect(refused.ok, id).toBe(false);
      expect(!refused.ok && "fieldErrors" in refused && refused.fieldErrors?.[inputName("builtin:contact_id")]).toBe("יש לבחור איש קשר מהרשימה.");
    }
    // not asked yet: the refusal offers the 200 for the dropdown
    const first = await requiredForMove(ORG, "deal", DEAL, { "builtin:stage": STAGE }, null);
    expect(!first.ok && "missing" in first && first.missing[0].choices).toHaveLength(200);
  });
});
