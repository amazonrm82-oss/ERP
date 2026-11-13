import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { INDUSTRY_KITS } from "@/features/industry-templates/kits";
import { industryPage, industryPageTexts, INDUSTRY_PAGE_KEYS, INDUSTRY_PAGE_LINKS, kitSetup } from "@/features/landing/industries";
import { industryMetadata } from "@/features/landing/industry-metadata";
import { SAMPLE_KIT_CONTENT } from "@/features/setup/sample-kits";
import { isPublicPath } from "@/lib/supabase/proxy";
import { paths } from "@/lib/paths";

// VRT-02: the industry marketing pages read what they show from the kits (VRT-01) and the kits' sample data (VRT-03).

// the closed list of tests/unit/industry-kits, tests/unit/sample-kits and tests/db/356-industry-kits
const MEDICAL_WORDS = [
  "אבחנה", "אבחון", "תרופה", "תרופות", "מחלה", "מחלות", "רגישות", "אלרגיה", "כאב", "תסמין", "סימפטום", "רפואי", "רפואית",
  "בריאותי", "הצהרת בריאות", "מצב בריאות", "ניתוח", "הריון", "לחץ דם", "סוכרת", "קופת חולים", "מרשם", "רופא", "היסטוריה",
  "diagnos", "medic", "allerg", "health",
];

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("industry pages (VRT-02)", () => {
  it("has one page per kit, and nothing else", () => {
    expect([...INDUSTRY_PAGE_KEYS]).toEqual(INDUSTRY_KITS.map((k) => k.template.industry));
    for (const key of INDUSTRY_PAGE_KEYS) expect(read(`src/app/industries/${key}/page.tsx`)).toContain(`industryPage("${key}")`);
  });

  it("what the kit sets up is read from the kit itself", () => {
    for (const kit of INDUSTRY_KITS) {
      const page = industryPage(kit.template.industry as (typeof INDUSTRY_PAGE_KEYS)[number]);
      expect(page.setup).toEqual(kitSetup(kit));
      const group = (key: string) => page.setup.find((g) => g.key === key)?.items ?? [];
      expect(group("pipeline")).toEqual(kit.template.pipeline!.stages.map((s) => s.name));
      expect(group("statuses")).toEqual(kit.template.statuses);
      expect(group("meeting_types").map((t) => t.split(" · ")[0])).toEqual(kit.meeting_types.map((m) => m.name));
      expect(group("punch_cards").map((t) => t.split(" · ")[0])).toEqual(kit.products.filter((p) => p.kind === "punch_card").map((p) => p.name));
      const messages = group("messages").join("\n");
      for (const m of [...kit.message_templates, ...kit.whatsapp_templates]) expect(messages).toContain(m.name);
      expect(group("form")).toEqual([kit.form.title]);
    }
  });

  it("the pictures are drawn from the kit's sample data and its own stages and meeting types", () => {
    for (const key of INDUSTRY_PAGE_KEYS) {
      const kit = INDUSTRY_KITS.find((k) => k.template.industry === key)!;
      const sample = SAMPLE_KIT_CONTENT.find((c) => c.kit === key)!;
      const { pictures } = industryPage(key);
      const stages = kit.template.pipeline!.stages.map((s) => s.name);
      for (const column of pictures.board.columns) expect(stages).toContain(column.stage);
      expect(pictures.board.columns.flatMap((c) => c.cards.map((card) => card.name))).toContain(sample.deal.name);
      expect(pictures.leads.rows.map((r) => r.name)).toEqual(sample.leads.map((l) => l.full_name));
      for (const row of pictures.leads.rows) expect(kit.template.statuses).toContain(row.status);
      expect(pictures.day.rows.map((r) => r.type)).toEqual(kit.meeting_types.map((m) => m.name));
      expect(pictures.card?.title).toBe(sample.punch_card!.product);
    }
  });

  it("promises no price: no shekel amount on the pages, only a link to the landing page's price list", () => {
    for (const key of INDUSTRY_PAGE_KEYS) {
      const text = industryPageTexts(industryPage(key)).join("\n");
      expect(text).not.toMatch(/₪|ש"ח|שקל|\d+\s*אגורות/);
    }
    const ui = read("src/features/landing/components/industry-page.tsx");
    expect(ui).not.toMatch(/price_agorot|amount_agorot|₪/);
    expect(ui).toContain("paths.pricing");
    expect(paths.pricing).toBe("/#pricing");
    expect(read("src/features/landing/components/pricing-section.tsx")).toContain('id="pricing"');
  });

  it("the clinic page holds no health or medical words, in its texts or its component", () => {
    const ui = read("src/features/landing/components/industry-page.tsx").toLowerCase();
    for (const key of INDUSTRY_PAGE_KEYS) {
      const text = industryPageTexts(industryPage(key)).join("\n").toLowerCase();
      const meta = JSON.stringify(industryMetadata(key)).toLowerCase();
      for (const word of MEDICAL_WORDS) {
        expect(text, `${key}: ${word}`).not.toContain(word.toLowerCase());
        expect(meta, `${key} metadata: ${word}`).not.toContain(word.toLowerCase());
        expect(ui, `component: ${word}`).not.toContain(word.toLowerCase());
      }
    }
  });

  it("are public, indexed, in the sitemap and linked from the landing page", () => {
    for (const key of INDUSTRY_PAGE_KEYS) {
      expect(isPublicPath(paths.industry(key))).toBe(true);
      const meta = industryMetadata(key);
      expect(meta.robots).toEqual({ index: true, follow: true });
      expect(meta.openGraph?.title).toBeTruthy();
    }
    expect(isPublicPath("/industries/other")).toBe(false);
    expect(read("src/app/sitemap.ts")).toMatch(/INDUSTRY_PAGE_KEYS\.map\(\(key\) => \(\{ url: url\(paths\.industry\(key\)\)/);
    expect(read("src/app/page.tsx")).toContain("<IndustryLinks pages={INDUSTRY_PAGE_LINKS} />");
    expect(read("src/features/landing/components/sections.tsx")).toContain("paths.industry(page.key)");
    expect(INDUSTRY_PAGE_LINKS.map((l) => l.key)).toEqual([...INDUSTRY_PAGE_KEYS]);
  });
});
