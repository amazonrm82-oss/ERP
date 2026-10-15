import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listWhatsappLog, whatsappListContext } from "@/features/whatsapp/templates";

// WA-01 follow-up (owner, 14 October 2026): the templates button in list rows and on "My day".
describe("WhatsApp templates in lists (WA-01)", () => {
  const writer = { canWrite: true, user: { displayName: "דנה כהן" }, org: { id: "org-1", name: "העסק של דנה" } };

  it("offers the templates only to someone who can write", () => {
    expect(whatsappListContext(writer)).toEqual({ orgId: "org-1", userName: "דנה כהן", businessName: "העסק של דנה" });
    expect(whatsappListContext({ ...writer, canWrite: false })).toBeNull();
  });

  it("builds the same values as the record page, and nothing without a valid phone", () => {
    const context = whatsappListContext(writer);
    const row = { subject: { kind: "lead" as const, id: "lead-1" }, name: "יוסי לוי", phoneE164: "+972501234567", fullName: "יוסי לוי" };
    expect(listWhatsappLog(context, row)).toEqual({
      orgId: "org-1",
      subject: { kind: "lead", id: "lead-1" },
      name: "יוסי לוי",
      values: { firstName: "יוסי", fullName: "יוסי לוי", userName: "דנה כהן", businessName: "העסק של דנה" },
    });
    // a stored first name wins over the first word
    expect(listWhatsappLog(context, { ...row, firstName: "יוסף" })?.values.firstName).toBe("יוסף");
    // no valid phone (no E.164), or a reader: the row keeps the plain link or none
    expect(listWhatsappLog(context, { ...row, phoneE164: null })).toBeUndefined();
    expect(listWhatsappLog(null, row)).toBeUndefined();
  });

  it("the icon has an accessible name with the person's name", () => {
    const source = readFileSync(path.join(process.cwd(), "src/features/whatsapp/components/whatsapp-button.tsx"), "utf8");
    expect(source).toContain("aria-label={`הודעת WhatsApp אל ${name}`}");
  });
});
