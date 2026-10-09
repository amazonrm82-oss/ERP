import { describe, expect, it } from "vitest";

import { FEATURES, LIVE_FEATURES, SOON_FEATURES } from "@/features/landing/catalog";

describe("landing page catalog (LND-03, LND-04)", () => {
  it("lists every part of the system the spec names, each once", () => {
    const keys = FEATURES.map((feature) => feature.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ["leads", "contacts", "deals", "tasks", "forms", "automations", "reports", "import", "files", "search", "mobile", "teams", "security"]) {
      expect(LIVE_FEATURES.map((feature) => feature.key)).toContain(key);
    }
  });

  it("keeps what is not built yet apart, never as available", () => {
    expect(SOON_FEATURES.map((feature) => feature.key)).toEqual(["whatsapp", "ads", "money"]);
    expect(LIVE_FEATURES.length + SOON_FEATURES.length).toBe(FEATURES.length);
  });

  it("explains each part in one short sentence", () => {
    for (const feature of FEATURES) {
      expect(feature.title.length).toBeGreaterThan(0);
      expect(feature.text.length).toBeLessThanOrEqual(110);
    }
  });
});
