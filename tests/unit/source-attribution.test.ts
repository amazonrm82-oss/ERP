import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { firstSourceEmpty, lockedFirstSource, mayChangeFirstSource, sourceLine, sourceRows } from "@/features/attribution/source";
import { FIELD_LABELS, HIDDEN_FIELDS } from "@/features/audit/labels";
import { STEP_WARNINGS } from "@/features/automations/describe";
import { LEAD_UTM_KEYS } from "@/features/leads/schema";
import { dbErrorMessage } from "@/lib/errors";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const migration = readdirSync(MIGRATIONS).find((name) => name.endsWith("_source_attribution.sql")) as string;
const sql = readFileSync(path.join(MIGRATIONS, migration), "utf8");

describe("first and last source (SEG-02, DQL-04)", () => {
  it("one short line of source and campaign", () => {
    expect(sourceLine("פייסבוק", "אביב")).toBe("פייסבוק · אביב");
    expect(sourceLine("פייסבוק", "  ")).toBe("פייסבוק");
    expect(sourceLine(null, "אביב")).toBe("אביב");
    expect(sourceLine(null, null)).toBeNull();
  });

  it("a source block: the source, the campaign and the UTM values, then when it arrived", () => {
    expect(sourceRows({ name: "גוגל", campaign: "חורף", utm: { utm_source: "google", utm_medium: "cpc", extra: { x: "y" } }, atText: "1.10.2026" })).toEqual([
      { label: "מקור", value: "גוגל" },
      { label: "קמפיין", value: "חורף" },
      { label: "מקור הפנייה", value: "google / cpc" },
      { label: "התקבלה", value: "1.10.2026" },
    ]);
    expect(sourceRows({ name: null, campaign: null, utm: null })).toEqual([]);
  });

  it("only owners and admins change a set first source", () => {
    expect(["owner", "admin"].map(mayChangeFirstSource)).toEqual([true, true]);
    expect(["manager", "member", "viewer", null, undefined].map(mayChangeFirstSource)).toEqual([false, false, false, false, false]);
  });

  it("the first source is locked as a whole once any part is set (lead's decision)", () => {
    const all = { source: true, campaign: true, utm: ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] };
    const none = { source: false, campaign: false, utm: [] };
    expect(lockedFirstSource({ sourceId: "s", campaign: null, utm: {} })).toEqual(all);
    expect(lockedFirstSource({ sourceId: null, campaign: "חורף", utm: {} })).toEqual(all);
    expect(lockedFirstSource({ sourceId: null, campaign: null, utm: { utm_term: "x" } })).toEqual(all);
    expect(lockedFirstSource({ sourceId: null, campaign: " ", utm: { extra: { a: "b" } } })).toEqual(none);
    expect(firstSourceEmpty({ sourceId: null, campaign: null, utm: null })).toBe(true);
  });

  it("the history names the new columns in Hebrew or hides the technical ones", () => {
    for (const column of ["last_source_id", "last_campaign", "last_utm", "last_source_at", "campaign", "utm"]) {
      expect(column in FIELD_LABELS || HIDDEN_FIELDS.has(column), column).toBe(true);
    }
    expect(FIELD_LABELS.last_source_id).toBe("מקור אחרון");
    expect(STEP_WARNINGS["the first source is already set"]).toBe("מקור ראשון כבר קיים");
    expect(sql).toContain("'the first source is already set'");
  });

  it("the trigger locks the same UTM keys the lead form edits, and its hint has a message", () => {
    const lock = sql.slice(sql.indexOf("function app.first_source_lock"));
    const keys = /foreach v_key in array array\[([^\]]+)\]/.exec(lock)?.[1].match(/'([a-z_]+)'/g)?.map((k) => k.slice(1, -1));
    expect(keys).toEqual([...LEAD_UTM_KEYS]);
    expect(lock).toContain("app.is_admin(new.organization_id)");
    expect(dbErrorMessage({ code: "P0001", hint: "lead:first_source_locked", message: "x" })).toContain("נעול");
    expect(dbErrorMessage({ code: "P0001", hint: "contact:first_source_locked", message: "x" })).toContain("נעול");
  });
});
