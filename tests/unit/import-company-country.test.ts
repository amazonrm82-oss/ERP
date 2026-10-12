import { describe, expect, it } from "vitest";

import { processChunk, type ImportContext } from "@/features/imports/server";

// CON-04 review: an import has no country column, so updating an existing
// company from a file must never write `country` (a GB company stays GB).
describe("company import in update mode", () => {
  it("keeps the existing company's country and number when the row has no country", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const chain = {
      eq: () => chain,
      select: async () => ({ data: [{ id: "c1" }], error: null }),
    };
    const supabase = {
      rpc: async () => ({
        data: [{ id: "c1", phone_e164: null, email: null, tax_id: "GB123456", name: "Foreign Ltd" }],
        error: null,
      }),
      from: () => ({
        update: (values: Record<string, unknown>) => {
          updates.push(values);
          return chain;
        },
      }),
    };
    const ctx = {
      supabase,
      orgId: "org",
      userId: "user",
      entity: "company",
      mode: "update",
      mapping: ["name", "city"],
      definitions: [],
    } as unknown as ImportContext;
    const lookups = { statuses: new Map(), defaultStatus: null, sources: new Map(), owners: new Map() };

    const outcomes = await processChunk(ctx, lookups, [["Foreign Ltd", "London"]], 1, "job");

    expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ name: "Foreign Ltd", city: "London" });
    expect(updates[0]).not.toHaveProperty("country");
    expect(updates[0]).not.toHaveProperty("tax_id");
  });
});
