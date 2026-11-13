import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { marketingSmsMissing, marketingSmsMissingText } from "@/features/message-sending/marketing-details";

const root = join(__dirname, "..", "..");

describe("RVW-89: what a marketing SMS needs from the business's details", () => {
  it("follows the composer: address from the address line or city, phone from the documents' phone or the business phone", () => {
    const none = { addressLine: null, city: null, documentPhone: null, businessPhone: null };
    expect(marketingSmsMissing(none)).toEqual(["address", "phone"]);
    expect(marketingSmsMissing({ ...none, city: " תל אביב ", businessPhone: "03-5555555" })).toEqual([]);
    expect(marketingSmsMissing({ ...none, addressLine: "הרצל 1", documentPhone: "  " })).toEqual(["phone"]);
    expect(marketingSmsMissing({ ...none, documentPhone: "050-1234567" })).toEqual(["address"]);
    expect(marketingSmsMissingText([])).toBeNull();
    expect(marketingSmsMissingText(["address", "phone"])).toBe(
      "SMS שיווקי דורש כתובת וטלפון בהגדרות המסמכים (חסר: כתובת וטלפון). עד שימולאו, הודעות שיווק ובקשות ביקורת ב-SMS לא יישלחו.",
    );
    expect(marketingSmsMissingText(["phone"])).toContain("חסר: טלפון");
  });

  it("reads the same columns the composer fills the envelope from", () => {
    const file = readdirSync(join(root, "supabase", "migrations")).find((f) => f.endsWith("_sms_compose.sql")) as string;
    const sql = readFileSync(join(root, "supabase", "migrations", file), "utf8");
    expect(sql).toContain("'טלפון העסק', coalesce(nullif(btrim(coalesce(v_settings.phone, '')), ''), nullif(btrim(coalesce(v_org.phone, '')), ''))");
    expect(sql).toContain("nullif(btrim(coalesce(v_settings.address_line, '')), '')");
    expect(sql).toContain("nullif(btrim(coalesce(v_settings.city, '')), '')");
  });
});
