import { describe, expect, it } from "vitest";

import { saveTerms, type TermsWriter, type TermValues } from "../../src/features/terminology/save";

const values: TermValues = { contact_term: "patient", lead_term: null, deal_term: "case" };

/** A writer that answers from a script and records the calls. */
function writer(script: { update: { data: { id: string }[] | null; error: { code?: string; message: string } | null }[]; insert?: { data: { id: string }[] | null; error: { code?: string; message: string } | null } }) {
  const calls: string[] = [];
  const updates = [...script.update];
  const w: TermsWriter = {
    update: async () => {
      calls.push("update");
      return updates.shift() ?? { data: [], error: null };
    },
    insert: async () => {
      calls.push("insert");
      return script.insert ?? { data: [], error: null };
    },
  };
  return { w, calls };
}

describe("saving the business's words (FLD-10)", () => {
  it("a later save updates the row and never inserts", async () => {
    const { w, calls } = writer({ update: [{ data: [{ id: "t" }], error: null }] });
    expect(await saveTerms(w, "org", values)).toEqual({ ok: true });
    expect(calls).toEqual(["update"]);
  });

  it("the first save inserts when the update found no row", async () => {
    const { w, calls } = writer({ update: [{ data: [], error: null }], insert: { data: [{ id: "t" }], error: null } });
    expect(await saveTerms(w, "org", values)).toEqual({ ok: true });
    expect(calls).toEqual(["update", "insert"]);
  });

  it("a first save that lost the race to another updates once more", async () => {
    const { w, calls } = writer({
      update: [{ data: [], error: null }, { data: [{ id: "t" }], error: null }],
      insert: { data: null, error: { code: "23505", message: "duplicate" } },
    });
    expect(await saveTerms(w, "org", values)).toEqual({ ok: true });
    expect(calls).toEqual(["update", "insert", "update"]);
  });

  it("not permitted: the insert is refused, or nothing comes back", async () => {
    const refused = writer({ update: [{ data: [], error: null }], insert: { data: null, error: { code: "42501", message: "rls" } } });
    expect(await saveTerms(refused.w, "org", values)).toEqual({ ok: false, error: { code: "42501", message: "rls" } });
    const empty = writer({ update: [{ data: [], error: null }], insert: { data: [], error: null } });
    expect((await saveTerms(empty.w, "org", values)).ok).toBe(false);
  });

  it("an update error is passed on without trying to insert", async () => {
    const { w, calls } = writer({ update: [{ data: null, error: { code: "08006", message: "down" } }] });
    expect(await saveTerms(w, "org", values)).toEqual({ ok: false, error: { code: "08006", message: "down" } });
    expect(calls).toEqual(["update"]);
  });
});
