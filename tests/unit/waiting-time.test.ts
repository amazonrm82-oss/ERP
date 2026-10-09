import { describe, expect, it } from "vitest";

import { waitingText } from "@/lib/waiting-time";

const min = 60_000;

describe("how long a lead has waited (SPD-02)", () => {
  it("counts minutes, then hours and minutes, then days", () => {
    expect(waitingText(20_000)).toBe("פחות מדקה");
    expect(waitingText(min)).toBe("דקה");
    expect(waitingText(45 * min)).toBe("45 דקות");
    expect(waitingText(60 * min)).toBe("שעה");
    expect(waitingText(121 * min)).toBe("שעתיים ודקה");
    expect(waitingText(5 * 60 * min + 12 * min)).toBe("5 שעות ו-12 דקות");
    expect(waitingText(26 * 60 * min)).toBe("יום");
    expect(waitingText(50 * 60 * min)).toBe("יומיים");
    expect(waitingText(9 * 24 * 60 * min)).toBe("9 ימים");
  });
});
