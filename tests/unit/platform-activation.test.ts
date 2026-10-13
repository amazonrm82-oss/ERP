import { describe, expect, it } from "vitest";

import { activationText, formatSpan } from "@/features/platform/activation";

describe("activation text (GAP-06)", () => {
  it("shows minutes, hours or days", () => {
    expect(formatSpan(0.25)).toBe("15 דקות");
    expect(formatSpan(-1)).toBe("0 דקות");
    expect(formatSpan(5.04)).toBe("5 שעות");
    expect(formatSpan(18.26)).toBe("18.3 שעות");
    expect(formatSpan(72)).toBe("3 ימים");
  });

  it("says how fast the lead was answered and how long after sign-up", () => {
    const text = activationText("2026-10-03T12:30:00Z", "2026-10-03T12:00:00Z", "2026-10-01T12:30:00Z");
    expect(text).toContain("מענה אחרי 30 דקות");
    expect(text).toContain("2 ימים מההרשמה");
  });
});
