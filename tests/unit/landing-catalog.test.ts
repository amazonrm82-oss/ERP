import { describe, expect, it } from "vitest";

import { FEATURES, LIVE_FEATURES } from "@/features/landing/catalog";

describe("landing page catalog (LND-03, LND-04)", () => {
  it("lists every part of the system the spec names, each once", () => {
    const keys = FEATURES.map((feature) => feature.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ["leads", "contacts", "deals", "tasks", "forms", "automations", "reports", "import", "files", "search", "mobile", "teams", "security", "quotes", "orders", "payments", "money", "booking", "signatures", "punch_cards", "presence", "goals"]) {
      expect(LIVE_FEATURES.map((feature) => feature.key)).toContain(key);
    }
  });

  it("lists only what works today; what is on its way comes from the public roadmap list (owner, 12 November 2026)", () => {
    expect(LIVE_FEATURES.length).toBe(FEATURES.length);
  });

  it("explains each part in one short sentence", () => {
    for (const feature of FEATURES) {
      expect(feature.title.length).toBeGreaterThan(0);
      expect(feature.text.length).toBeLessThanOrEqual(110);
    }
  });
});
