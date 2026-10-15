import { describe, expect, it } from "vitest";

import { TAX_ID_INVALID, TAX_ID_INVALID_FOREIGN } from "@/features/companies/tax-id";
import { COUNTRY_UNKNOWN, foreignNumberKey, importCountry } from "@/features/imports/country";
import {
  FOREIGN_HINT,
  TAX_ID_AMBIGUOUS,
  TAX_ID_AMBIGUOUS_COUNTRIES,
  processChunk,
  type ImportContext,
} from "@/features/imports/server";

type Existing = { id: string; phone_e164: string | null; email: string | null; tax_id: string | null; name: string | null; country: string };

/** A stand-in for the user's Supabase session: duplicates, countries, updates and inserts. */
function fakeSupabase(existing: Existing[]) {
  const updates: Array<Record<string, unknown>> = [];
  const headers: Array<[string, string]> = [];
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
        // REC-03: an import's update carries its job id in a header (no follower notices)
        const chain = {
          eq: () => chain,
          setHeader: (name: string, value: string) => {
            headers.push([name, value]);
            return chain;
          },
          select: async () => ({ data: [{ id: "c1" }], error: null }),
        };
        return chain;
      },
      insert: async (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
        inserts.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
    }),
  };
  return { supabase, updates, inserts, rpcArgs, headers };
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
      { row: 2, status: "failed", message: `${TAX_ID_INVALID} ${FOREIGN_HINT}` },
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
    expect(fake.headers).toEqual([["x-crm-import", "job"]]);
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
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: `${TAX_ID_INVALID} ${FOREIGN_HINT}` }]);
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

describe("duplicates by a foreign registration number", () => {
  const STORED: Existing = { id: "c9", phone_e164: null, email: null, tax_id: "AB 123/4", name: "Stored Ltd", country: "GB" };
  const DIGITS: Existing = { id: "c8", phone_e164: null, email: null, tax_id: "512-345-679", name: "Digits Ltd", country: "GB" };
  const run = async (existing: Existing[], cells: string[]) => {
    const fake = fakeSupabase(existing);
    const outcomes = await processChunk(context(fake.supabase, "skip", ["name", "country", "tax_id"]), lookups, [cells], 1, null);
    return { outcomes, taxIds: fake.rpcArgs[0]?.p_tax_ids };
  };

  it("keys a number without case and without spaces, '-', '.' and '/'", () => {
    expect(foreignNumberKey("ab 12-3./4")).toBe("AB1234");
  });

  it("finds the same number in the same country", async () => {
    const { outcomes, taxIds } = await run([STORED], ["New name", "GB", "ab-1234"]);
    expect(taxIds).toEqual(["ab-1234", "GB:AB1234"]);
    expect(outcomes).toEqual([{ row: 1, status: "skipped", message: "כבר קיים" }]);
  });

  it("does not find it in another country", async () => {
    const { outcomes } = await run([STORED], ["New name", "FR", "ab-1234"]);
    expect(outcomes).toEqual([{ row: 1, status: "ok" }]);
  });

  it("a row without a country finds it in any country outside Israel", async () => {
    const { outcomes, taxIds } = await run([STORED], ["New name", "", "ab.1234"]);
    expect(taxIds).toEqual(["ab.1234", "*:AB1234"]);
    expect(outcomes).toEqual([{ row: 1, status: "skipped", message: "כבר קיים" }]);
  });

  it("an Israeli row never meets a foreign company, even with an equal stored number", async () => {
    expect((await run([DIGITS], ["New name", "IL", "512345679"])).outcomes).toEqual([{ row: 1, status: "ok" }]);
    const equal = { ...DIGITS, tax_id: "512345679" };
    expect((await run([equal], ["New name", "IL", "512345679"])).outcomes).toEqual([{ row: 1, status: "ok" }]);
    // without a country in the file an equal stored number still matches, in any country
    expect((await run([equal], ["New name", "", "512345679"])).outcomes).toEqual([{ row: 1, status: "skipped", message: "כבר קיים" }]);
  });
});

describe("a number matches a company only within its country", () => {
  const ALFA: Existing = { id: "il1", phone_e164: null, email: null, tax_id: "514713288", name: "אלפא", country: "IL" };
  const GB_NUM: Existing = { id: "gb1", phone_e164: null, email: null, tax_id: "AB12", name: "Brit", country: "GB" };
  const ACME: Existing = { id: "gb2", phone_e164: null, email: null, tax_id: "12-345", name: "Acme", country: "GB" };
  const BETA: Existing = { id: "de1", phone_e164: null, email: null, tax_id: "12345", name: "Beta", country: "DE" };
  const MAP = ["name", "country", "tax_id"];

  it("update: a GB row does not take over an Israeli company with the same number", async () => {
    const fake = fakeSupabase([ALFA]);
    const outcomes = await processChunk(context(fake.supabase, "update", MAP), lookups, [["Alpha UK", "GB", "514713288"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "created" }]);
    expect(fake.updates).toEqual([]);
    expect(fake.inserts[0]).toMatchObject({ name: "Alpha UK", country: "GB", tax_id: "514713288" });
  });

  it("update and skip: a DE row does not match a GB company with the same number", async () => {
    const update = fakeSupabase([GB_NUM]);
    expect(await processChunk(context(update.supabase, "update", MAP), lookups, [["Deutsch", "DE", "AB12"]], 1, null)).toEqual([{ row: 1, status: "ok" }]);
    const skip = fakeSupabase([GB_NUM]);
    expect(await processChunk(context(skip.supabase, "skip", MAP), lookups, [["Deutsch", "DE", "AB12"]], 1, null)).toEqual([{ row: 1, status: "ok" }]);
  });

  it("update: a row without a country that matches companies in several countries fails, none is picked", async () => {
    const fake = fakeSupabase([ACME, BETA]);
    const outcomes = await processChunk(context(fake.supabase, "update", MAP), lookups, [["Beta GmbH", "", "12345"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: TAX_ID_AMBIGUOUS_COUNTRIES }]);
    expect(fake.updates).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it("update: two companies of one country with the same number fail the row too", async () => {
    const fake = fakeSupabase([ACME, { ...BETA, country: "GB" }]);
    const outcomes = await processChunk(context(fake.supabase, "update", MAP), lookups, [["Beta GmbH", "GB", "12345"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: TAX_ID_AMBIGUOUS }]);
    expect(fake.updates).toEqual([]);
  });

  it("update: with a country the same file row finds the one company of that country", async () => {
    const fake = fakeSupabase([ACME, BETA]);
    const outcomes = await processChunk(context(fake.supabase, "update", MAP), lookups, [["Beta GmbH", "DE", "12345"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
    expect(fake.updates).toHaveLength(1);
  });

  it("skip: an ambiguous row exists either way and is skipped, nothing is written", async () => {
    const fake = fakeSupabase([ACME, BETA]);
    const outcomes = await processChunk(context(fake.supabase, "skip", MAP), lookups, [["Beta GmbH", "", "12345"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "skipped", message: "כבר קיים" }]);
    expect(fake.updates).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it("update matched by key keeps the stored spelling of the number", async () => {
    const stored: Existing = { id: "c9", phone_e164: null, email: null, tax_id: "AB 123/4", name: "Stored Ltd", country: "GB" };
    const fake = fakeSupabase([stored]);
    const outcomes = await processChunk(context(fake.supabase, "update", ["name", "tax_id", "city"]), lookups, [["Stored Ltd", "ab-1234", "London"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
    expect(fake.updates[0]).toEqual({ name: "Stored Ltd", city: "London" });
  });

  it("a number that is neither Israeli nor foreign gets no hint", async () => {
    const fake = fakeSupabase([]);
    const outcomes = await processChunk(context(fake.supabase, "create", MAP), lookups, [["א", "", "מספר"]], 1, null);
    expect(outcomes).toEqual([{ row: 1, status: "failed", message: TAX_ID_INVALID }]);
  });
});
