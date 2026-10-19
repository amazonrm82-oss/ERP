import { describe, expect, it } from "vitest";

import { withoutSuperseded } from "@/features/quotes/addenda";

// GAP-10: the staff list of a quote's addenda shows each version chain once.
describe("withoutSuperseded", () => {
  it("leaves out a version that a sent newer version replaces, keeps drafts and single quotes", () => {
    const rows = [
      { id: "a1", previous_id: null, sent_at: "2026-10-01" },
      { id: "a2", previous_id: "a1", sent_at: "2026-10-05" },
      { id: "b1", previous_id: null, sent_at: "2026-10-02" },
      { id: "b2", previous_id: "b1", sent_at: null },
      { id: "c1", previous_id: null, sent_at: null },
    ];
    expect(withoutSuperseded(rows).map((r) => r.id)).toEqual(["a2", "b1", "b2", "c1"]);
    expect(withoutSuperseded([])).toEqual([]);
  });
});
