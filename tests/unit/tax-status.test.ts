import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { taxSettingsSchema } from "@/features/tax/schema";
import { taxSettingsFromRow } from "@/features/tax/settings";
import { chargesVat, LEGAL_FORMS, VAT_STATUSES, vatStatusLabel } from "@/features/tax/status";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261006013500_tax_status.sql"), "utf8");

const listOf = (constraint: string, column: string): string[] => {
  const list = new RegExp(`${constraint}\\s+check \\(${column} in \\(([^)]*)\\)\\)`).exec(migration)?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
};

// TAX-01: the VAT status is apart from the legal form, and decides alone whether VAT is charged
describe("VAT status (TAX-01)", () => {
  it("the app's lists are the lists of the database checks", () => {
    expect(listOf("org_document_settings_vat_status_check", "vat_status")).toEqual([...VAT_STATUSES]);
    expect(listOf("org_document_settings_legal_form_check", "legal_form")).toEqual([...LEGAL_FORMS]);
  });

  it("chargesVat() is the rule of app.vat_status_charges()", () => {
    const body = /function app\.vat_status_charges[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(migration)?.[1] ?? "";
    const sqlRule = Object.fromEntries([...body.matchAll(/when '([a-z_]+)' then ([a-z_]+)/g)].map((m) => [m[1], m[2]]));
    expect(sqlRule).toEqual({ licensed: "true", exempt: "false", nonprofit: "false", other: "p_other_charges_vat" });
    for (const status of VAT_STATUSES) {
      for (const other of [true, false, null]) {
        const expected = sqlRule[status] === "p_other_charges_vat" ? other : sqlRule[status] === "true";
        expect(chargesVat(status, other), `${status}/${String(other)}`).toBe(expected);
      }
    }
  });

  it("an exempt business or a nonprofit never charges VAT; unknown is null, never yes", () => {
    expect(chargesVat("exempt", true)).toBe(false);
    expect(chargesVat("nonprofit", true)).toBe(false);
    expect(chargesVat("licensed", false)).toBe(true);
    expect(chargesVat(null, true)).toBeNull();
    expect(chargesVat("other", null)).toBeNull();
  });

  it("a missing row or an unknown value reads as not set", () => {
    expect(taxSettingsFromRow(null)).toEqual({ legalForm: null, vatStatus: null, vatStatusOther: null, otherChargesVat: null });
    expect(taxSettingsFromRow({ legal_form: "llc", vat_status: "weird", vat_status_other: null, other_charges_vat: null }).vatStatus).toBeNull();
    expect(vatStatusLabel(null, null)).toBe("לא הוגדר");
    expect(vatStatusLabel("other", "חברה לתועלת הציבור")).toBe("חברה לתועלת הציבור");
    expect(vatStatusLabel("exempt", "x")).toBe("עוסק פטור");
    // owner's labels (13 October 2026); the stored values stay the same
    expect(vatStatusLabel("licensed", null)).toBe('עוסק מורשה או חברה בע"מ');
    expect(vatStatusLabel("nonprofit", null)).toBe('עמותה או מלכ"ר');
    expect(vatStatusLabel("other", null)).toBe("מעמד אחר");
  });

  it("the form: status required; the other status needs a name and an answer, others drop them", () => {
    expect(taxSettingsSchema.safeParse({ vat_status: "", legal_form: "" }).success).toBe(false);
    expect(taxSettingsSchema.parse({ vat_status: "exempt", legal_form: "company", vat_status_other: "x", other_charges_vat: "yes" })).toEqual({
      legal_form: "company",
      vat_status: "exempt",
      vat_status_other: null,
      other_charges_vat: null,
    });
    const missing = taxSettingsSchema.safeParse({ vat_status: "other", legal_form: "", vat_status_other: " ", other_charges_vat: "" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path[0]).sort()).toEqual(["other_charges_vat", "vat_status_other"]);
    expect(taxSettingsSchema.parse({ vat_status: "other", legal_form: null, vat_status_other: " מלכ\"ר ציבורי ", other_charges_vat: "no" })).toEqual({
      legal_form: null,
      vat_status: "other",
      vat_status_other: 'מלכ"ר ציבורי',
      other_charges_vat: false,
    });
    expect(taxSettingsSchema.safeParse({ vat_status: "licensed", legal_form: "llc" }).success).toBe(false);
  });
});
