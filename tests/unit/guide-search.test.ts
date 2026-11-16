import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { guideDocs, searchOrgGuides } from "@/features/guide/search-server";
import { foldWithMap, GUIDE_QUERY_MAX, guideQuery, guideScore, guideSnippet, searchGuides, type GuideDoc } from "@/features/help/guide-search";
import { helpFold } from "@/features/help/search";
import { helpSearchCommand, type Command } from "@/features/search/command-match";
import { DEFAULT_TERMS, resolveTerms, termKeys } from "@/features/terminology/terms";

const doc = (key: string, title: string, text: string, draft = false): GuideDoc => ({ key, kind: "article", slug: key, title, text, draft });
const plain = (parts: { text: string }[]) => parts.map((p) => p.text).join("");
const hits = (parts: { text: string; hit: boolean }[]) => parts.filter((p) => p.hit).map((p) => p.text);

describe("TRU-04 guide search: folding", () => {
  it("folds each character like helpFold and keeps the way back to the original", () => {
    const text = "לִידִים חדשים: ד\"ר ג`ורג׳ ABC";
    const { folded, map } = foldWithMap(text);
    expect(folded).toBe(helpFold(text));
    expect(map.length).toBe(folded.length);
    for (let i = 0; i < folded.length; i++) expect(helpFold(text[map[i]])).toContain(folded[i]);
  });

  it("reads ?q= safely: first of a repeated parameter, trimmed, cut", () => {
    expect(guideQuery(undefined)).toBe("");
    expect(guideQuery(["  ייבוא ", "x"])).toBe("ייבוא");
    expect(guideQuery("א".repeat(300)).length).toBe(GUIDE_QUERY_MAX);
  });
});

describe("TRU-04 guide search: matching and rank", () => {
  const docs = [
    doc("a", "עבודה עם משימות", "איך פותחים משימה חדשה ומסמנים בוצע"),
    doc("b", "ייבוא מאקסל", "מעלים קובץ, בוחרים עמודות. גם משימות אפשר לייבא, משימות ועוד משימות"),
    doc("c", "לידים חדשים", "כל ליד שמגיע מהטופס"),
  ];

  it("needs every word, folds niqqud and final letters, and finds nothing for nothing", () => {
    expect(searchGuides(docs, "")).toEqual([]);
    expect(searchGuides(docs, "   ")).toEqual([]);
    expect(searchGuides(docs, "לִידִים").map((r) => r.key)).toEqual(["c"]);
    expect(searchGuides(docs, "לידימ").map((r) => r.key)).toEqual(["c"]);
    expect(searchGuides(docs, "ייבוא עמודות").map((r) => r.key)).toEqual(["b"]);
    expect(searchGuides(docs, "ייבוא ירח")).toEqual([]);
  });

  it("puts a title match before any number of body matches", () => {
    expect(searchGuides(docs, "משימות").map((r) => r.key)).toEqual(["a", "b"]);
    expect(guideScore(docs[0], ["משימות"])).toBeGreaterThan(guideScore(docs[1], ["משימות"]) ?? 0);
  });

  it("orders body matches by count, then keeps the list's order", () => {
    const body = [doc("x", "אחד", "שדה"), doc("y", "שניים", "שדה שדה"), doc("z", "שלושה", "שדה")];
    expect(searchGuides(body, "שדה").map((r) => r.key)).toEqual(["y", "x", "z"]);
  });

  it("keeps the draft flag and caps the results", () => {
    const many = Array.from({ length: 30 }, (_, i) => doc(`d${i}`, `מדריך ${i}`, "טקסט", i === 0));
    const results = searchGuides(many, "טקסט");
    expect(results.length).toBe(20);
    expect(results[0].draft).toBe(true);
    expect(searchGuides(many, "טקסט", 5).length).toBe(5);
  });
});

describe("TRU-04 guide search: the snippet", () => {
  it("cuts around the first match, marks the typed words in their written form, and says what was left out", () => {
    const text = `${"מילה ".repeat(40)}כאן מוסיפים לִידִים חדשים ${"סוף ".repeat(60)}`;
    const parts = guideSnippet(text, ["לידימ", "חדשימ"]);
    expect(parts[0].text).toBe("…");
    expect(parts[parts.length - 1].text).toBe("…");
    expect(hits(parts)).toEqual(["לִידִים", "חדשים"]);
    expect(plain(parts).length).toBeLessThanOrEqual(170);
    expect(text.replace(/\s+/g, " ")).toContain(plain(parts).replace(/…/g, "").trim());
  });

  it("starts at the beginning with no cut when the match is early, and with no match", () => {
    expect(plain(guideSnippet("ייבוא קובץ", ["ייבוא"]))).toBe("ייבוא קובץ");
    expect(hits(guideSnippet("ייבוא קובץ", ["ייבוא"]))).toEqual(["ייבוא"]);
    expect(hits(guideSnippet("ייבוא קובץ", ["ירח"]))).toEqual([]);
    expect(guideSnippet("   ", ["א"])).toEqual([]);
  });

  it("merges marks that overlap and keeps text as text (no HTML is built)", () => {
    const parts = guideSnippet("<b>ליד</b> לידים", ["ליד", "לידימ"]);
    expect(plain(parts)).toBe("<b>ליד</b> לידים");
    expect(hits(parts)).toEqual(["ליד", "לידים"]);
  });
});

describe("TRU-04 guide search over the real help content", () => {
  it("searches the articles and the screens' texts, in the business's words", () => {
    const docs = guideDocs(DEFAULT_TERMS, { leads: true });
    expect(docs.some((d) => d.kind === "article")).toBe(true);
    expect(docs.some((d) => d.kind === "screen" && d.key === "screen:home")).toBe(true);
    // every result opens an article that exists
    const slugs = new Set(docs.filter((d) => d.kind === "article").map((d) => d.slug));
    for (const d of docs) expect(slugs.has(d.slug)).toBe(true);
    expect(searchOrgGuides("ייבוא אקסל", DEFAULT_TERMS, { leads: true })[0].slug).toBe("import");
  });

  it("leaves out the leads screen while leads are off, and fills the business's own word", () => {
    expect(guideDocs(DEFAULT_TERMS, { leads: false }).some((d) => d.key === "screen:leads")).toBe(false);
    const terms = resolveTerms(termKeys({ lead_term: "inquiry" }));
    const home = guideDocs(terms, { leads: true }).find((d) => d.key === "screen:home");
    expect(home?.text).toContain(terms.lead.plural);
    expect(home?.text).not.toContain("{lead.");
  });

  it("the help center page searches on the server, never in the browser", () => {
    const page = readFileSync("src/app/o/[orgId]/help/page.tsx", "utf8");
    expect(page).toContain("searchOrgGuides(");
    const component = readFileSync("src/features/guide/components/guide-search.tsx", "utf8");
    expect(component).not.toMatch(/^\s*["']use client["']/);
    expect(component).toContain('role="search"');
    expect(component).toContain('aria-live="polite"');
    expect(component).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("TRU-04 the command palette offers the guide search", () => {
  const help: Command = { key: "nav:help", group: "navigate", label: "מרכז עזרה", hint: null, href: "/o/x/help", keywords: [] };

  it("links to the help center with the typed text", () => {
    const c = helpSearchCommand([help], "  ייבוא   אקסל ");
    expect(c?.group).toBe("help");
    expect(c?.label).toBe("חיפוש במדריכים: ייבוא אקסל");
    expect(c?.href).toBe(`/o/x/help?q=${encodeURIComponent("ייבוא אקסל")}`);
  });

  it("offers nothing for a short text or without the help center", () => {
    expect(helpSearchCommand([help], "א")).toBeNull();
    expect(helpSearchCommand([help], "''")).toBeNull();
    expect(helpSearchCommand([], "ייבוא")).toBeNull();
  });
});
