import { describe, expect, it } from "vitest";

import { saveQuoteDesignRow } from "@/features/quotes/design-save";

type Result = { data: unknown[] | null; error: { code: string; message: string } | null };

/** A fake client: each update or insert answers the next queued result, and the calls are recorded. */
function fake(results: Result[]) {
  const calls: string[] = [];
  const next = async () => results.shift() as Result;
  const client = {
    from: () => ({
      update: () => ({ eq: () => ({ select: () => (calls.push("update"), next()) }) }),
      insert: () => ({ select: () => (calls.push("insert"), next()) }),
    }),
  };
  return { client: client as unknown as Parameters<typeof saveQuoteDesignRow>[0], calls };
}
const row = { data: [{ organization_id: "o" }], error: null };
const none = { data: [], error: null };

// QUO-05 fix: update first, insert only when there is no row, update once more when the insert lost a race.
describe("saveQuoteDesignRow", () => {
  it("updates an existing row and never inserts", async () => {
    const { client, calls } = fake([row]);
    expect(await saveQuoteDesignRow(client, "o", { header_text: "x" })).toEqual({ saved: true, error: null });
    expect(calls).toEqual(["update"]);
  });

  it("inserts when there is no row", async () => {
    const { client, calls } = fake([none, row]);
    expect(await saveQuoteDesignRow(client, "o", { header_text: "x" })).toEqual({ saved: true, error: null });
    expect(calls).toEqual(["update", "insert"]);
  });

  it("updates once more when the insert lost a race (23505), and passes any other error on", async () => {
    const raced = fake([none, { data: null, error: { code: "23505", message: "dup" } }, row]);
    expect(await saveQuoteDesignRow(raced.client, "o", {})).toEqual({ saved: true, error: null });
    expect(raced.calls).toEqual(["update", "insert", "update"]);
    const refused = fake([none, { data: null, error: { code: "42501", message: "denied" } }]);
    expect((await saveQuoteDesignRow(refused.client, "o", {})).error?.code).toBe("42501");
    expect(refused.calls).toEqual(["update", "insert"]);
  });
});
