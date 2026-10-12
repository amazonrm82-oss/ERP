import { describe, expect, it } from "vitest";

import { buildVCard, escapeVCardText, vcardDisposition } from "@/lib/vcard";

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
    const card = buildVCard({ name: "כהן, משה; בנו", phone: null, email: "", company: "א;ב" });
    // RVW-18: in a JS string "\\;" is backslash + semicolon ("\;" would be a bare semicolon)
    expect(card).toContain("FN:כהן\\, משה\\; בנו");
    expect(card).toContain("N:כהן\\, משה\\; בנו;;;;");
    expect(card).toContain("ORG:א\\;ב");
    expect(card).not.toContain("TEL");
    expect(card).not.toContain("EMAIL");
  });

  it("escapes backslash, comma, semicolon and every kind of line break", () => {
    expect(escapeVCardText("a\\b")).toBe("a\\\\b");
    expect(escapeVCardText("a,b;c")).toBe("a\\,b\\;c");
    expect(escapeVCardText("1\r\n2\n3\r4")).toBe("1\\n2\\n3\\n4");
    // a backslash already in the text stays text: it is escaped first, before the separators
    expect(escapeVCardText("\\;")).toBe("\\\\\\;");
    // a lone CR never reaches the card, where it could break a line
    expect(buildVCard({ name: "שם\rשני" })).toContain("FN:שם\\nשני\r\n");
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
