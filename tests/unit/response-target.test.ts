import { describe, expect, it } from "vitest";

import { responseTargetLabels } from "@/features/reports/response-target";

describe("response target labels (SPD-06)", () => {
  it("names the 60 minute default explicitly", () => {
    const labels = responseTargetLabels(60);
    expect(labels.kpi).toBe("נענו בתוך 60 דקות");
    expect(labels.column).toBe("תוך 60 דק'");
    expect(labels.clock).toBe("הזמן נספר גם בלילה ובימי מנוחה");
  });

  it("builds the labels from the target the database returns", () => {
    expect(responseTargetLabels(15).kpi).toBe("נענו בתוך 15 דקות");
    expect(responseTargetLabels(90).column).toBe("תוך 90 דק'");
  });
});
