import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CARD_FIELD_KEYS, cardSchema, shownFields } from "@/features/business-cards/model";
import { publicCardFrom } from "@/features/business-cards/public";
import { buildVCard } from "@/lib/vcard";

describe("business cards (BIZ-02)", () => {
  it("keeps the list of shown fields equal to the migration's", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith("_business_cards.sql"))!), "utf8");
    const list = /public_fields <@ array\[([^\]]+)\]/.exec(sql)?.[1] ?? "";
    expect(list.split(",").map((s) => s.trim().replace(/'/g, "")).sort()).toEqual([...CARD_FIELD_KEYS].sort());
  });

  it("shows a ticked field only when it has a value", () => {
    const input = { job_title: "יועצת", about: null, phone: "052-1234567", email: null, website: null };
    expect(shownFields(input, ["job_title", "about", "phone", "whatsapp", "email"])).toEqual(["job_title", "phone", "whatsapp"]);
    expect(shownFields({ ...input, phone: null }, ["whatsapp"])).toEqual([]);
  });

  it("checks the details like the database", () => {
    const base = { job_title: "", about: "", phone: "", email: "", website: "", public_fields: [], is_active: true };
    expect(cardSchema.safeParse(base).success).toBe(true);
    expect(cardSchema.safeParse({ ...base, email: "x" }).success).toBe(false);
    expect(cardSchema.safeParse({ ...base, website: "example.com" }).success).toBe(false);
    expect(cardSchema.safeParse({ ...base, website: "https://example.co.il" }).success).toBe(true);
    expect(cardSchema.safeParse({ ...base, public_fields: ["salary"] }).success).toBe(false);
  });

  it("reads the public card defensively", () => {
    expect(publicCardFrom(null)).toBeNull();
    expect(publicCardFrom({ business: "עסק" })).toBeNull();
    const card = publicCardFrom({ name: "דנה", business: "עסק", brand: {}, built_with: true, whatsapp: "+97250", website: "javascript:alert(1)", form: true });
    expect(card).toMatchObject({ name: "דנה", whatsapp: null, website: null, form: true, phone: null });
  });

  it("puts the site on the contact file only when it is a web address", () => {
    expect(buildVCard({ name: "דנה", url: "https://example.co.il" })).toContain("URL:https://example.co.il");
    expect(buildVCard({ name: "דנה", url: "javascript:alert(1)" })).not.toContain("URL:");
  });
});
