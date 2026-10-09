import { describe, expect, it } from "vitest";

import { recordSummary } from "@/features/share/summary";

describe("record summary for WhatsApp (GAP-04)", () => {
  it("puts the title in bold and leaves out empty lines", () => {
    expect(
      recordSummary("שיפוץ מטבח", [
        ["איש קשר", "דנה לוי"],
        ["טלפון", "050-1234567"],
        ["חברה", null],
        ["הערות", "  "],
      ]),
    ).toBe("*שיפוץ מטבח*\nאיש קשר: דנה לוי\nטלפון: 050-1234567");
  });
});
