import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addContactCompanySchema, TITLE_MAX, titleArg } from "@/features/contact-companies/schema";

// CON-05: the role at a company is free text, trimmed, at most TITLE_MAX characters, like the database's check.
describe("a contact's role at a company (CON-05)", () => {
  it("is trimmed and empty means none", () => {
    expect(titleArg.parse("  מנהלת רכש  ")).toBe("מנהלת רכש");
    expect(titleArg.parse("   ")).toBeNull();
    expect(titleArg.parse(null)).toBeNull();
    expect(titleArg.safeParse("x".repeat(TITLE_MAX + 1)).success).toBe(false);
    expect(titleArg.safeParse(7).success).toBe(false);
  });

  it("a new link needs a company; the role is optional", () => {
    const company = "00000000-0000-4000-8000-000000000001";
    expect(addContactCompanySchema.parse({ company_id: company, title: "" })).toEqual({ company_id: company, title: null });
    expect(addContactCompanySchema.safeParse({ company_id: "", title: "יועצת" }).success).toBe(false);
    expect(addContactCompanySchema.safeParse({ company_id: company, title: "x".repeat(TITLE_MAX + 1) }).success).toBe(false);
  });

  it("TITLE_MAX is the database's limit", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith("_contact_companies.sql"))!), "utf8");
    expect(sql).toContain(`char_length(title) between 1 and ${TITLE_MAX}`);
  });
});
