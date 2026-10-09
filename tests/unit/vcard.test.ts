import { describe, expect, it } from "vitest";

import { buildVCard, vcardDisposition } from "@/lib/vcard";

describe("contact card for the phone (GAP-02)", () => {
  it("writes the person's details as vCard 3.0", () => {
    const card = buildVCard({ name: "דנה לוי", phone: "050-1234567", email: "dana@example.com", company: "שיפוצים בע\"מ", jobTitle: "מנהלת", birthday: "1985-03-15" });
    expect(card.split("\r\n")).toEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:דנה לוי",
      "N:דנה לוי;;;;",
      "TEL;TYPE=CELL:050-1234567",
      "EMAIL:dana@example.com",
      "ORG:שיפוצים בע\"מ",
      "TITLE:מנהלת",
      "BDAY:1985-03-15",
      "END:VCARD",
      "",
    ]);
  });

  it("leaves out what is missing and escapes special characters", () => {
    const card = buildVCard({ name: "כהן, משה; בנו", phone: null, email: "" });
    expect(card).toContain("FN:כהן\\, משה\; בנו");
    expect(card).not.toContain("TEL");
    expect(card).not.toContain("EMAIL");
  });

  it("folds long lines without splitting a Hebrew letter", () => {
    const card = buildVCard({ name: "א".repeat(60) });
    const lines = card.split("\r\n");
    const start = lines.findIndex((l) => l.startsWith("FN:"));
    let end = start + 1;
    while (lines[end].startsWith(" ")) end++;
    const fn = lines.slice(start, end);
    expect(fn.length).toBeGreaterThan(1);
    for (const line of fn) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(fn.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(`FN:${"א".repeat(60)}`);
  });

  it("names the file after the person", () => {
    expect(vcardDisposition("דנה")).toBe(`attachment; filename="contact.vcf"; filename*=UTF-8''${encodeURIComponent("דנה.vcf")}`);
  });
});
