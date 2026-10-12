import { describe, expect, it } from "vitest";

import { TAX_ID_INVALID, TAX_ID_INVALID_FOREIGN } from "@/features/companies/tax-id";
import { COUNTRY_UNKNOWN, importCountry } from "@/features/imports/country";
import { processChunk, type ImportContext } from "@/features/imports/server";

type Existing = { id: string; phone_e164: string | null; email: string | null; tax_id: string | null; name: string | null; country: string };

/** A stand-in for the user's Supabase session: duplicates, countries, updates and inserts. */
function fakeSupabase(existing: Existing[]) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const rpcArgs: Array<Record<string, unknown>> = [];
  const supabase = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      rpcArgs.push(args);
      return { data: existing.map(({ country: _country, ...rest }) => (void _country, rest)), error: null };
    },
    from: () => ({
      select: () => {
        const read = { eq: () => read, in: async () => ({ data: existing.map((e) => ({ id: e.id, country: e.country })), error: null }) };
        return read;
      },
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        const chain = { eq: () => chain, select: async () => ({ data: [{ id: "c1" }], error: null }) };
        return chain;
      },
      insert: async (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
        inserts.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
    }),
  };
  return { supabase, updates, inserts, rpcArgs };
}

const lookups = { statuses: new Map(), defaultStatus: null, sources: new Map(), owners: new Map() };

function context(supabase: unknown, mode: "skip" | "update" | "create", mapping: string[]): ImportContext {
  return { supabase, orgId: "org", userId: "user", entity: "company", mode, mapping, definitions: [] } as unknown as ImportContext;
}

const GB_COMPANY: Existing = { id: "c1", phone_e164: null, email: null, tax_id: "GB123456", name: "Foreign Ltd", country: "GB" };
const IL_COMPANY: Existing = { id: "c1", phone_e164: null, email: null, tax_id: null, name: "חברה ישראלית", country: "IL" };

describe("the country cell of a company import", () => {
  it("accepts an ISO code in any case", () => {
    expect(importCountry("gb")).toBe("GB");
    expect(importCountry(" Fr ")).toBe("FR");
    expect(importCountry("IL")).toBe("IL");
  });

  it("accepts the Hebrew name, with ' and \" for ׳ and ״", () => {
    expect(importCountry(" בריטניה ")).toBe("GB");
    expect(importCountry("ארצות הברית")).toBe("US");
    expect(importCountry("אזרבייג'ן")).toBe("AZ");
    expect(importCountry('ארה"ב')).toBe("US");
  });

  it("accepts the English name and UK / USA", () => {
    expect(importCountry("United Kingdom")).toBe("GB");
    expect(importCountry("germany")).toBe("DE");
    expect(importCountry("UK")).toBe("GB");
    expect(importCountry("usa")).toBe("US");
  });

  it("refuses anything else", () => {
    expect(importCountry("ZZ")).toBeNull();
    expect(importCountry("אנגליה הגדולה")).toBeNull();
    expect(importCountry("G")).toBeNull();
  });
});

describe("company import with a country column", () => {
  it("creates a foreign company with its country and checks the number by it", async () => {
    const fake = fakeSupabase([]);
    const outcomes = await processChunk(context(fake.supabase, "skip", ["name", "country", "tax_id"]), lookups, [["Foreign Ltd", "בריטניה", " AB 123/4 "]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "created" }]);
    expect(fake.inserts[0]).toMatchObject({ name: "Foreign Ltd", country: "GB", tax_id: "AB 123/4" });
  });

  it("checks an Israeli number when the country is Israel", async () => {
    const fake = fakeSupabase([]);
    const outcomes = await processChunk(context(fake.supabase, "create", ["name", "country", "tax_id"]), lookups, [["א", "il", "AB123"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: TAX_ID_INVALID }]);
    expect(fake.inserts).toEqual([]);
  });

  it("refuses a foreign number of the wrong shape", async () => {
    const fake = fakeSupabase([]);
    const outcomes = await processChunk(context(fake.supabase, "create", ["name", "country", "tax_id"]), lookups, [["Foreign Ltd", "GB", "מספר"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: TAX_ID_INVALID_FOREIGN }]);
  });

  it("fails a row whose country is not recognized", async () => {
    const fake = fakeSupabase([]);
    const outcomes = await processChunk(context(fake.supabase, "create", ["name", "country"]), lookups, [["Foreign Ltd", "Narnia"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: COUNTRY_UNKNOWN("Narnia") }]);
  });

  it("a new company with an empty country cell is Israeli, and so is its number", async () => {
    const fake = fakeSupabase([]);
    const outcomes = await processChunk(
      context(fake.supabase, "create", ["name", "country", "tax_id"]),
      lookups,
      [
        ["ישראלית", "", "51-234567-9"],
        ["זרה", "", "AB123"],
      ],
      1,
      "job",
    );
    expect(outcomes).toEqual([
      { row: 1, status: "created" },
      { row: 2, status: "failed", message: TAX_ID_INVALID },
    ]);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({ tax_id: "512345679" });
    // the database default (IL) applies; the import does not write it
    expect(fake.inserts[0]).not.toHaveProperty("country");
  });
});

describe("company import in update mode", () => {
  it("keeps the existing company's country and number when the row has no country", async () => {
    const fake = fakeSupabase([GB_COMPANY]);
    const outcomes = await processChunk(context(fake.supabase, "update", ["name", "city"]), lookups, [["Foreign Ltd", "London"]], 1, "job");

    expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toEqual({ name: "Foreign Ltd", city: "London" });
    expect(fake.updates[0]).not.toHaveProperty("country");
    expect(fake.updates[0]).not.toHaveProperty("tax_id");
  });

  it("checks a number against the existing company's own country", async () => {
    const fake = fakeSupabase([GB_COMPANY]);
    const outcomes = await processChunk(context(fake.supabase, "update", ["name", "country", "tax_id"]), lookups, [["Foreign Ltd", "", "XY-99"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
    expect(fake.updates[0]).toEqual({ name: "Foreign Ltd", tax_id: "XY-99" });
  });

  it("an Israeli company's number stays Israeli when the row has no country", async () => {
    const fake = fakeSupabase([IL_COMPANY]);
    const outcomes = await processChunk(context(fake.supabase, "update", ["name", "tax_id"]), lookups, [["חברה ישראלית", "AB123"]], 1, null);
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: TAX_ID_INVALID }]);
    expect(fake.updates).toEqual([]);
  });

  it("a filled country cell moves the company and checks the number by the new country", async () => {
    const fake = fakeSupabase([IL_COMPANY]);
    const outcomes = await processChunk(context(fake.supabase, "update", ["name", "country", "tax_id"]), lookups, [["חברה ישראלית", "צרפת", "FR 123"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
    expect(fake.updates[0]).toEqual({ name: "חברה ישראלית", country: "FR", tax_id: "FR 123" });
  });

  it("looks up a number without a country both as Israeli and as foreign", async () => {
    const fake = fakeSupabase([GB_COMPANY]);
    await processChunk(context(fake.supabase, "update", ["tax_id", "name"]), lookups, [["51-234567-9", "x"]], 1, null);
    expect(fake.rpcArgs[0].p_tax_ids).toEqual(expect.arrayContaining(["512345679", "51-234567-9"]));
  });
});
