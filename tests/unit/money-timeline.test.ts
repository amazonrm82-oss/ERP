import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MONEY_ENTRY_KINDS, moneyEntryKind, moneyEntryLabel } from "@/features/activities/money-entries";
import { DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES } from "@/features/documents/schema";

// DOC-04: the timeline entry names the document type in Hebrew; app.document_type_label (migration money_timeline) mirrors the
// screen's labels, and the guard's list of kinds is the screen's list.
const dir = path.join(process.cwd(), "supabase/migrations");
const migration = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_money_timeline.sql"))!), "utf8");

describe("documents and payments on the timeline (DOC-04)", () => {
  it("app.document_type_label equals DOCUMENT_TYPE_LABELS", () => {
    const fn = migration.slice(migration.indexOf("function app.document_type_label"));
    const body = fn.slice(0, fn.indexOf("$$;"));
    const pairs = Object.fromEntries([...body.matchAll(/when '([a-z_]+)' then '((?:[^']|'')*)'/g)].map((m) => [m[1], m[2].replace(/''/g, "'")]));
    expect(pairs).toEqual(Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, DOCUMENT_TYPE_LABELS[t]])));
  });

  it("the guard and the author trigger name exactly MONEY_ENTRY_KINDS (their latest redefinition)", () => {
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .filter((sql) => sql.includes("function app.activities_money_entry_guard"))
      .at(-1)!;
    const lists = [...latest.matchAll(/in \(('document_recorded'[^)]*)\)/g)].map((m) => m[1].split(",").map((s) => s.trim().replace(/'/g, "")));
    expect(lists.length).toBeGreaterThanOrEqual(3);
    for (const list of lists) expect(list).toEqual([...MONEY_ENTRY_KINDS]);
  });

  it("only system entries of those kinds are money entries", () => {
    expect(moneyEntryKind("system", "payment_received")).toBe("payment_received");
    expect(moneyEntryKind("note", "payment_received")).toBeNull();
    expect(moneyEntryKind("system", "quote_sent")).toBeNull();
    expect(moneyEntryKind("system", null)).toBeNull();
    expect(moneyEntryLabel("document_cancelled")).toBe("מסמך");
    expect(moneyEntryLabel("payment_cancelled")).toBe("תשלום");
    expect(moneyEntryKind("system", "payment_failed")).toBe("payment_failed");
    expect(moneyEntryLabel("payment_refunded")).toBe("תשלום");
  });
});
