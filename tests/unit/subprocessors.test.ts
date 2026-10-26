import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGREEMENT_SLUGS } from "@/features/legal/agreement";
import { getLegalDocument } from "@/features/legal/documents";
import {
  addDays,
  ANNOUNCED_FIELDS,
  changesAnnouncement,
  collapseSpaces,
  firstNoticeDay,
  normalizeWebsite,
  parsePublicEntry,
  parsePublicList,
  publicListOrThrow,
  publicReadFailureLine,
  withBackoff,
  splitPublicList,
  subprocessorStatus,
  type Subprocessor,
} from "@/features/platform/subprocessors";
import { dbErrorMessage } from "@/lib/errors";

const entry = (over: Partial<Subprocessor>): Subprocessor => ({
  name: "ספק",
  purpose: "תפקיד",
  dataCategories: "מידע",
  location: null,
  website: null,
  effectiveFrom: "2026-10-13",
  endsOn: null,
  ...over,
});

describe("ADM-01 subprocessors", () => {
  it("status by day: upcoming, in force, ended, cancelled", () => {
    const today = "2026-10-26";
    expect(subprocessorStatus({ effectiveFrom: "2026-10-27", endsOn: null, cancelled: false }, today)).toBe("upcoming");
    expect(subprocessorStatus({ effectiveFrom: "2026-10-26", endsOn: null, cancelled: false }, today)).toBe("in_force");
    expect(subprocessorStatus({ effectiveFrom: "2026-10-01", endsOn: "2026-10-27", cancelled: false }, today)).toBe("in_force");
    expect(subprocessorStatus({ effectiveFrom: "2026-10-01", endsOn: "2026-10-26", cancelled: false }, today)).toBe("ended");
    expect(subprocessorStatus({ effectiveFrom: "2026-11-01", endsOn: null, cancelled: true }, today)).toBe("cancelled");
  });

  it("the notice day is 14 days ahead, across months", () => {
    expect(firstNoticeDay("2026-10-26")).toBe("2026-11-09");
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("splits the public list into today and upcoming, dropping ended entries", () => {
    const list = [entry({ name: "a" }), entry({ name: "b", effectiveFrom: "2026-11-20" }), entry({ name: "c", endsOn: "2026-10-26" }), entry({ name: "d", endsOn: "2026-12-01" })];
    const { current, upcoming } = splitPublicList(list, "2026-10-26");
    expect(current.map((e) => e.name)).toEqual(["a", "d"]);
    expect(upcoming.map((e) => e.name)).toEqual(["b"]);
  });

  it("maps the public page's country to the location and returns no website", () => {
    expect(parsePublicEntry({ name: "a", purpose: "p", data_categories: "d", country: "ישראל", website: "https://x.example", effective_from: "2026-10-13", ends_on: null })).toMatchObject({
      location: "ישראל",
      website: null,
    });
  });

  it("parses only the public shape", () => {
    expect(parsePublicEntry({ name: "a", purpose: "p", data_categories: "d", country: null, effective_from: "2026-10-13", ends_on: null })).toEqual(
      entry({ name: "a", purpose: "p", dataCategories: "d" }),
    );
    expect(parsePublicEntry({ name: "a", purpose: "p", data_categories: "d", effective_from: "13.10.2026" })).toBeNull();
    expect(parsePublicEntry({ name: "", purpose: "p", data_categories: "d", effective_from: "2026-10-13" })).toBeNull();
    expect(parsePublicEntry(null)).toBeNull();
  });

  it("parses the public list with its last change day", () => {
    const one = { name: "a", purpose: "p", data_categories: "d", country: null, effective_from: "2026-10-13", ends_on: null };
    expect(parsePublicList({ entries: [one], updated_on: "2026-10-13" })).toEqual({ entries: [entry({ name: "a", purpose: "p", dataCategories: "d" })], updatedOn: "2026-10-13" });
    expect(parsePublicList({ entries: [], updated_on: null })).toEqual({ entries: [], updatedOn: null });
    expect(parsePublicList({ entries: [{ name: "a" }], updated_on: null })).toBeNull();
    expect(parsePublicList([one])).toBeNull();
  });

  it("collapses whitespace like the database, so a spacing fix is not an announcement", () => {
    expect(collapseSpaces("  a\u00a0\u00a0b\t\n c\u202f d\u3000 ")).toBe("a b c d");
    const base = { name: "Supabase", purpose: "מסד נתונים", data_categories: "הכל", effective_from: "2026-11-20" };
    expect(changesAnnouncement(base, { ...base, purpose: " מסד\u00a0 נתונים " }, ANNOUNCED_FIELDS)).toBe(false);
    expect(changesAnnouncement(base, { ...base, purpose: "אחר" }, ANNOUNCED_FIELDS)).toBe(true);
    expect(changesAnnouncement(base, { ...base, effective_from: "2026-11-21" }, ANNOUNCED_FIELDS)).toBe(true);
    expect(changesAnnouncement({ ends_on: "" }, { ends_on: "2026-12-01" }, ["ends_on"])).toBe(true);
    expect(changesAnnouncement({ ends_on: "2026-12-01" }, { ends_on: "2026-12-01" }, ["ends_on"])).toBe(false);
  });

  it("a refused or odd answer throws, so the cache never keeps it", () => {
    expect(() => publicListOrThrow({ refused: "rate" })).toThrow();
    expect(() => publicListOrThrow(null)).toThrow();
    expect(publicListOrThrow({ entries: [], updated_on: "2026-10-13" })).toEqual({ entries: [], updatedOn: "2026-10-13" });
  });

  it("a failed read holds further reads for the back-off, then tries again", async () => {
    let clock = 1_000;
    let calls = 0;
    let fail = true;
    const failures: unknown[] = [];
    const read = withBackoff(
      async () => {
        calls += 1;
        if (fail) throw new Error("refused");
        return "list";
      },
      60_000,
      () => clock,
      (error) => failures.push(error),
    );
    expect(await read()).toBeNull();
    expect(calls).toBe(1);
    expect(failures).toHaveLength(1);
    clock += 59_999;
    expect(await read()).toBeNull();
    expect(calls).toBe(1);
    clock += 1;
    fail = false;
    expect(await read()).toBe("list");
    expect(calls).toBe(2);
    expect(await read()).toBe("list");
    expect(calls).toBe(3);
  });

  it("the failure log line carries only our short reason", () => {
    expect(publicReadFailureLine(new Error("subprocessors_public_page failed: 42501"))).toBe(
      "subprocessors public read failed, showing the static list: subprocessors_public_page failed: 42501",
    );
    expect(publicReadFailureLine(new Error("x".repeat(500)))).toHaveLength(
      "subprocessors public read failed, showing the static list: ".length + 120,
    );
    expect(publicReadFailureLine("boom")).toContain(": unknown");
  });

  it("websites are https only", () => {
    expect(normalizeWebsite("  ")).toBeNull();
    expect(normalizeWebsite(" https://supabase.com ")).toBe("https://supabase.com");
    expect(normalizeWebsite("http://supabase.com")).toBeUndefined();
    expect(normalizeWebsite("https://a b")).toBeUndefined();
  });

  it("the list is not a signed text, so changing it opens no legal version", () => {
    expect(AGREEMENT_SLUGS).not.toContain("subprocessors");
  });

  it("the migration seeds the same providers the legal page listed", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_platform_subprocessors.sql"));
    expect(file).toBeTruthy();
    const sql = readFileSync(join(dir, file!), "utf8");
    const doc = getLegalDocument("subprocessors")!;
    const providers = doc.sections.filter((s) => s.heading !== "עדכון אחרון");
    expect(providers.map((s) => s.heading)).toEqual(["Supabase", "Vercel", "שירותי הדחיפה של הדפדפנים"]);
    for (const section of providers) {
      expect(sql, section.heading).toContain(`'${section.heading}'`);
      for (const text of section.paragraphs) {
        const value = text.replace(/^(תפקיד|מידע): /, "").replace(/'/g, "''");
        if (text.startsWith("מיקום:")) continue; // the location placeholder is not stored; the platform owner fills it once
        expect(sql, text).toContain(value);
      }
    }
  });

  it("every refusal has a message", () => {
    expect(dbErrorMessage({ code: "P0001", hint: "subprocessor:in_force" })).toContain("נעול");
    expect(dbErrorMessage({ code: "P0001", hint: "subprocessor:notice" })).toContain("14");
    expect(dbErrorMessage({ code: "P0001", hint: "subprocessor:end_before_start" })).toContain("אחרי תאריך התחילה");
  });
});
