import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { landingUpcomingCapabilities, UPCOMING_MARK } from "@/features/landing/upcoming";
import { PUBLIC_ROADMAP_ITEMS } from "@/features/roadmap/public-items";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("landing page upcoming capabilities (LND-13, owner answer 304 ב)", () => {
  it("takes every item, and only those, from the public roadmap's static list, in its order", () => {
    const upcoming = landingUpcomingCapabilities();
    expect(upcoming.map((item) => [item.key, item.title])).toEqual(PUBLIC_ROADMAP_ITEMS.map((item) => [item.key, item.title]));
  });

  it("marks each one בקרוב", () => {
    expect(UPCOMING_MARK).toBe("בקרוב");
    for (const item of landingUpcomingCapabilities()) expect(item.mark).toBe("בקרוב");
  });

  it("writes no item of its own: the module reads public-items.ts and holds no title", () => {
    const source = read("src/features/landing/upcoming.ts");
    expect(source).toContain('from "@/features/roadmap/public-items"');
    for (const item of PUBLIC_ROADMAP_ITEMS) expect(source).not.toContain(item.title);
  });

  it("is shown in the price list section, outside the plans branch, with the mark as a badge", () => {
    const source = read("src/features/landing/components/price-list.tsx");
    expect(source).toContain("landingUpcomingCapabilities()");
    expect(source).toContain("{item.mark}");
    expect(source).toMatch(/\)\}\s*<Upcoming \/>\s*<\/div>/);
  });
});
