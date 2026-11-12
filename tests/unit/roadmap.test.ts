import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  groupByStatus,
  adminListCutText,
  parseAdminRoadmap,
  parseAdminRoadmapItems,
  parseRequestIds,
  parseRoadmapItems,
  ROADMAP_DESCRIPTION_MAX,
  ROADMAP_STATUSES,
  ROADMAP_TITLE_MAX,
  votesText,
} from "@/features/roadmap/items";
import { PUBLIC_ROADMAP_ITEMS, PUBLIC_ROADMAP_NOTE } from "@/features/roadmap/public-items";

const migration = readFileSync("supabase/migrations/20261006021197_roadmap.sql", "utf8");

describe("TRU-01 roadmap", () => {
  it("statuses and limits match the migration", () => {
    expect(migration).toContain(`status in (${["planned", "building", "done"].map((s) => `'${s}'`).join(", ")})`);
    expect([...ROADMAP_STATUSES].sort()).toEqual(["building", "done", "planned"]);
    expect(migration).toContain(`between 1 and ${ROADMAP_TITLE_MAX})`);
    expect(migration).toContain(`between 1 and ${ROADMAP_DESCRIPTION_MAX})`);
  });

  it("parses what a business sees, dropping malformed rows", () => {
    const items = parseRoadmapItems([
      { id: "a", title: "א", description: "ת", status: "planned", votes: 3, voted: true, can_vote: true },
      { id: "b", title: "ב", description: "ת", status: "someday", votes: 1 },
      null,
      { id: "c", title: "ג", description: "ת", status: "done", votes: "2", voted: "yes" },
    ]);
    expect(items).toEqual([
      { id: "a", title: "א", description: "ת", status: "planned", votes: 3, voted: true, canVote: true },
      { id: "c", title: "ג", description: "ת", status: "done", votes: 2, voted: false, canVote: false },
    ]);
    expect(parseRoadmapItems(null)).toEqual([]);
  });

  it("parses the platform list", () => {
    expect(
      parseAdminRoadmapItems([{ id: "a", title: "א", description: "ת", status: "building", published: true, sort_order: 4, request_ids: ["r1", 7], votes: 5 }]),
    ).toEqual([{ id: "a", title: "א", description: "ת", status: "building", published: true, sortOrder: 4, requestIds: ["r1"], votes: 5 }]);
    // finance and readonly get null request ids
    expect(parseAdminRoadmapItems([{ id: "a", title: "א", description: "ת", status: "planned", request_ids: null }])[0].requestIds).toBeNull();
  });

  it("reads {items, total} and says when only the newest 500 are shown", () => {
    const item = { id: "a", title: "א", description: "ת", status: "planned" };
    const all = parseAdminRoadmap({ items: [item], total: 1 });
    expect(all.total).toBe(1);
    expect(adminListCutText(all)).toBeNull();
    const cut = parseAdminRoadmap({ items: [item], total: 812 });
    expect(adminListCutText(cut)).toBe("מוצגים 1 הפריטים החדשים מתוך 812.");
    expect(parseAdminRoadmap(null)).toEqual({ items: [], total: 0 });
    expect(parseAdminRoadmap({ items: [item, { ...item, id: "b" }], total: 1 }).total).toBe(2);
  });

  it("the public page is published as approved (answer 192): in the sitemap and the footer, indexable, the note under it", () => {
    const read = (f: string) => readFileSync(f, "utf8");
    expect(read("src/app/sitemap.ts")).toContain("paths.roadmap");
    expect(read("src/components/public-shell.tsx")).toContain("paths.roadmap");
    const page = read("src/app/help/roadmap/page.tsx");
    expect(page).not.toContain("robots");
    expect(page).toContain("PUBLIC_ROADMAP_NOTE");
    const list = read("src/features/roadmap/public-items.ts");
    expect(list).not.toContain("DRAFT");
    expect(list).toContain("Changes to this list need the owner's approval (DECISIONS.md, answer 192)");
  });

  it("the public list is exactly the approved one (answer 192; the signature item removed by the owner, 12 November 2026)", () => {
    expect(PUBLIC_ROADMAP_ITEMS.map((item) => [item.status, item.title])).toEqual([
      ["building", "שליחת מיילים ו-SMS ללקוחות מתוך המערכת"],
      ["building", "לידים מפייסבוק ומאינסטגרם ישר למערכת"],
      ["building", "תזכורות ואישורי פגישה ללקוחות ב-SMS"],
      ["planned", "השהיית מנוי לעסק עונתי"],
    ]);
    expect(PUBLIC_ROADMAP_NOTE).toBe("הסדר והזמנים עשויים להשתנות");
  });

  it("groups building, then planned, then done, leaving empty groups out", () => {
    const groups = groupByStatus([{ status: "done" as const }, { status: "building" as const }, { status: "done" as const }]);
    expect(groups.map((g) => [g.status, g.items.length])).toEqual([
      ["building", 1],
      ["done", 2],
    ]);
  });

  it("counts in Hebrew", () => {
    expect(votesText(0)).toBe("אין עדיין קולות");
    expect(votesText(1)).toBe("קול אחד");
    expect(votesText(1200)).toBe("1,200 קולות");
  });

  it("reads pasted support request ids", () => {
    const id = "0F8B3C2E-1111-4222-8333-944455556666";
    expect(parseRequestIds(`${id}\n${id.toLowerCase()}, `)).toEqual({ ids: [id.toLowerCase()], rest: "" });
    expect(parseRequestIds("not an id").rest).not.toBe("");
    expect(parseRequestIds("")).toEqual({ ids: [], rest: "" });
  });

  it("the public list is Mexuz wording within the limits, with unique keys and no done items", () => {
    const keys = PUBLIC_ROADMAP_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of PUBLIC_ROADMAP_ITEMS) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.title.length).toBeLessThanOrEqual(ROADMAP_TITLE_MAX);
      expect(["building", "planned"]).toContain(item.status);
    }
  });

  it("the public page reads nothing from the database", () => {
    const page = readFileSync("src/app/help/roadmap/page.tsx", "utf8");
    expect(page).not.toMatch(/supabase|\.rpc\(|createClient/);
  });
});
