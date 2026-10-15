import { describe, expect, it } from "vitest";

import { IMPORT_TARGETS, suggestMapping } from "@/features/imports/fields";
import {
  NO_PERMISSION_TO_UPDATE,
  REASON_LIST_EMPTY,
  REASON_NEEDED_TO_DISQUALIFY,
  REASON_NOT_ON_LIST,
  processChunk,
  type ImportContext,
} from "@/features/imports/server";
import { moreRowsText, warnedRowsTitle } from "@/features/imports/wording";

// RVW-9: a lead import may carry the "not relevant" reason, from the business's list only.

type Lead = { id: string; phone_e164: string | null; email: string | null; status_id: string };

/** A stand-in for the user's Supabase session: lead duplicates, their statuses, updates and inserts. */
function fakeSupabase(existing: Lead[] = [], readable: Lead[] = existing) {
  const updates: Array<Record<string, unknown>> = [];
  const headers: Array<[string, string]> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const statusReads: string[][] = [];
  const supabase = {
    rpc: async () => ({ data: existing.map((e) => ({ id: e.id, phone_e164: e.phone_e164, email: e.email, tax_id: null, name: null })), error: null }),
    from: () => ({
      select: () => {
        let ids: string[] = [];
        const read = {
          eq: () => read,
          in: (_col: string, slice: string[]) => {
            ids = slice;
            statusReads.push(slice);
            return read;
          },
          order: () => read,
          range: async (from: number, to: number) => ({
            data: readable
              .filter((e) => ids.includes(e.id))
              .map((e) => ({ id: e.id, status_id: e.status_id }))
              .slice(from, to + 1),
            error: null,
          }),
        };
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
          select: async () => ({ data: [{ id: "l1" }], error: null }),
        };
        return chain;
      },
      insert: async (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
        inserts.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
    }),
  };
  return { supabase, updates, inserts, statusReads };
}

const OPEN = "s-open";
const LOST = "s-lost";
const lookups = {
  statuses: new Map([
    ["חדש", OPEN],
    ["לא רלוונטי", LOST],
  ]),
  defaultStatus: OPEN,
  sources: new Map(),
  owners: new Map(),
  disqualified: new Set([LOST]),
  reasons: new Set(["יקר מדי", "קנה אצל מתחרה"]),
};

const MAPPING = ["full_name", "phone", "status", "disqualify_reason"];

function context(supabase: unknown, mode: "skip" | "update" | "create"): ImportContext {
  return { supabase, orgId: "org", userId: "user", entity: "lead", mode, mapping: MAPPING, definitions: [] } as unknown as ImportContext;
}

describe("the reason column of a lead import (RVW-9)", () => {
  it("is suggested for Hebrew and English headers", () => {
    expect(suggestMapping(["שם", "סיבה"], IMPORT_TARGETS.lead)).toEqual(["full_name", "disqualify_reason"]);
    expect(suggestMapping(["Disqualify reason"], IMPORT_TARGETS.lead)).toEqual(["disqualify_reason"]);
    expect(suggestMapping(["סיבת פסילה"], IMPORT_TARGETS.lead)).toEqual(["disqualify_reason"]);
  });

  it("keeps a reason that is on the list, after trimming", async () => {
    const fake = fakeSupabase();
    const outcomes = await processChunk(context(fake.supabase, "create"), lookups, [["דנה", "0521234567", "לא רלוונטי", "  יקר מדי "]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "created" }]);
    expect(fake.inserts[0]).toMatchObject({ status_id: LOST, disqualify_reason: "יקר מדי", import_job_id: "job" });
  });

  it("imports a not-relevant row without a reason, with an empty reason", async () => {
    const fake = fakeSupabase();
    const outcomes = await processChunk(context(fake.supabase, "create"), lookups, [["דנה", "0521234567", "לא רלוונטי", ""]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "created" }]);
    expect(fake.inserts[0]).toMatchObject({ status_id: LOST });
    expect(fake.inserts[0]).not.toHaveProperty("disqualify_reason");
  });

  it("drops a reason that is not on the list, imports the row and says so (preview and import)", async () => {
    const preview = await processChunk(context(fakeSupabase().supabase, "create"), lookups, [["דנה", "0521234567", "לא רלוונטי", "יקר"]], 1, null);
    expect(preview).toEqual([{ row: 1, status: "ok", warning: REASON_NOT_ON_LIST("יקר") }]);

    const fake = fakeSupabase();
    const outcomes = await processChunk(context(fake.supabase, "create"), lookups, [["דנה", "0521234567", "לא רלוונטי", "יקר"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "created", warning: REASON_NOT_ON_LIST("יקר") }]);
    expect(fake.inserts[0]).not.toHaveProperty("disqualify_reason");
  });

  it("matches the list exactly: another case or spelling is not on the list", async () => {
    const fake = fakeSupabase();
    const outcomes = await processChunk(context(fake.supabase, "create"), lookups, [["דנה", "0521234567", "לא רלוונטי", "יקר  מדי"]], 1, "job");
    expect(outcomes[0].warning).toBe(REASON_NOT_ON_LIST("יקר  מדי"));
  });

  it("ignores a reason on a row whose status is not 'not relevant', without a warning", async () => {
    const fake = fakeSupabase();
    const outcomes = await processChunk(context(fake.supabase, "create"), lookups, [["דנה", "0521234567", "חדש", "משהו אחר"]], 1, "job");
    expect(outcomes).toEqual([{ row: 1, status: "created" }]);
    expect(fake.inserts[0]).not.toHaveProperty("disqualify_reason");
  });

  describe("update mode", () => {
    const existingOpen: Lead = { id: "l1", phone_e164: "+972521234567", email: null, status_id: OPEN };
    const existingLost: Lead = { ...existingOpen, status_id: LOST };

    it("moving an existing lead into not-relevant without a reason fails the row before writing, in the preview too", async () => {
      for (const jobId of [null, "job"]) {
        const fake = fakeSupabase([existingOpen]);
        const outcomes = await processChunk(context(fake.supabase, "update"), lookups, [["דנה", "0521234567", "לא רלוונטי", ""]], 1, jobId);
        expect(outcomes).toEqual([{ row: 1, status: "failed", message: REASON_NEEDED_TO_DISQUALIFY }]);
        expect(fake.updates).toEqual([]);
      }
      // a reason that is not on the list counts as none
      const fake = fakeSupabase([existingOpen]);
      const outcomes = await processChunk(context(fake.supabase, "update"), lookups, [["דנה", "0521234567", "לא רלוונטי", "סתם"]], 1, "job");
      expect(outcomes).toEqual([{ row: 1, status: "failed", message: REASON_NEEDED_TO_DISQUALIFY }]);
    });

    it("with a reason from the list the existing lead is moved", async () => {
      const fake = fakeSupabase([existingOpen]);
      const outcomes = await processChunk(context(fake.supabase, "update"), lookups, [["דנה", "0521234567", "לא רלוונטי", "קנה אצל מתחרה"]], 1, "job");
      expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
      expect(fake.updates[0]).toMatchObject({ status_id: LOST, disqualify_reason: "קנה אצל מתחרה" });
    });

    it("a lead that is already not relevant is updated without a reason (it keeps its own)", async () => {
      const fake = fakeSupabase([existingLost]);
      const outcomes = await processChunk(context(fake.supabase, "update"), lookups, [["דנה", "0521234567", "לא רלוונטי", ""]], 1, "job");
      expect(outcomes).toEqual([{ row: 1, status: "updated" }]);
      expect(fake.updates[0]).not.toHaveProperty("disqualify_reason");
    });

    it("a matched lead that cannot be read now fails with the no-permission message", async () => {
      const fake = fakeSupabase([existingOpen], []);
      const outcomes = await processChunk(context(fake.supabase, "update"), lookups, [["דנה", "0521234567", "לא רלוונטי", ""]], 1, "job");
      expect(outcomes).toEqual([{ row: 1, status: "failed", message: NO_PERMISSION_TO_UPDATE }]);
      expect(fake.updates).toEqual([]);
    });

    it("with an empty list of reasons the message says so and where to add them", async () => {
      const fake = fakeSupabase([existingOpen]);
      const empty = { ...lookups, reasons: new Set<string>() };
      const outcomes = await processChunk(context(fake.supabase, "update"), empty, [["דנה", "0521234567", "לא רלוונטי", "יקר מדי"]], 1, "job");
      expect(outcomes).toEqual([{ row: 1, status: "failed", message: REASON_LIST_EMPTY }]);
      expect(REASON_LIST_EMPTY).toContain("סיבות לליד לא רלוונטי");
      expect(fake.updates).toEqual([]);
    });

    it("reads the leads' statuses only when a row could need it", async () => {
      const fake = fakeSupabase([existingOpen]);
      await processChunk(context(fake.supabase, "update"), lookups, [["דנה", "0521234567", "חדש", ""]], 1, "job");
      expect(fake.statusReads).toEqual([]);
    });
  });
});

describe("the import summary wording", () => {
  it("says one row in the singular and more in the plural", () => {
    expect(warnedRowsTitle(1)).toBe("שורה אחת יובאה עם הערה:");
    expect(warnedRowsTitle(3)).toBe("3 שורות יובאו עם הערה:");
    expect(warnedRowsTitle(1200)).toBe("1,200 שורות יובאו עם הערה:");
    expect(moreRowsText(1)).toBe("ועוד שורה אחת.");
    expect(moreRowsText(5)).toBe("ועוד 5 שורות.");
  });
});
