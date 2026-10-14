import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { companyBilling, contactBilling, effectiveBilling, type BillingColumns } from "@/features/billing/billing";
import { companyBillingSchema, contactBillingSchema } from "@/features/billing/schema";
import {
  PAYMENT_DAYS_MAX,
  PAYMENT_TERMS,
  PAYMENT_TERMS_LABELS,
  PAYMENT_TERMS_SHORTCUTS,
  PaymentTermsError,
  paymentDueDate,
  paymentTermsOf,
  paymentTermsText,
} from "@/features/billing/terms";

const empty: BillingColumns = {
  billing_name: null,
  billing_tax_id: null,
  billing_address: null,
  shipping_address: null,
  billing_email: null,
  payment_terms: null,
  payment_days: null,
  price_list_id: null,
};

const form = (values: Record<string, string>) => ({
  billing_name: "",
  billing_tax_id: "",
  billing_address: "",
  shipping_address: "",
  billing_email: "",
  payment_terms: "",
  payment_days: "",
  price_list_id: "",
  ...values,
});

// CON-08: billing details of companies and contacts
describe("billing details (CON-08)", () => {
  it("the payment terms are the list of the database constraint", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261006017600_billing_details.sql"), "utf8");
    expect(sql).toContain("when payment_terms = 'immediate' then payment_days is null");
    expect(sql).toContain("when payment_terms in ('net', 'eom') then payment_days is not null and payment_days between 0 and 365");
    expect([...PAYMENT_TERMS].sort()).toEqual(["eom", "immediate", "net"]);
    expect(PAYMENT_DAYS_MAX).toBe(365);
  });

  it("reads only the shapes the database allows", () => {
    expect(paymentTermsOf("immediate", null)).toEqual({ kind: "immediate", days: null });
    expect(paymentTermsOf("immediate", 3)).toBeNull();
    expect(paymentTermsOf("eom", 30)).toEqual({ kind: "eom", days: 30 });
    expect(paymentTermsOf("net", null)).toBeNull();
    expect(paymentTermsOf("net", 366)).toBeNull();
    expect(paymentTermsOf("weekly", 7)).toBeNull();
    expect(paymentTermsOf(null, null)).toBeNull();
  });

  it("says the terms the way Israelis write them", () => {
    expect(paymentTermsText({ kind: "immediate", days: null })).toBe("מיידי");
    expect(paymentTermsText({ kind: "eom", days: 0 })).toBe("שוטף");
    expect(paymentTermsText({ kind: "eom", days: 30 })).toBe("שוטף+30");
    expect(paymentTermsText({ kind: "eom", days: 45 })).toBe("שוטף+45");
    expect(paymentTermsText({ kind: "net", days: 30 })).toBe("30 יום מתאריך המסמך");
    expect(paymentTermsText({ kind: "net", days: 1 })).toBe("1 יום מתאריך המסמך");
    expect(paymentTermsText({ kind: "net", days: 0 })).toBe("ביום המסמך");
    expect(paymentTermsText(null)).toBeNull();
  });

  it("computes the due date (for COL-02)", () => {
    expect(paymentDueDate("2026-10-13", { kind: "immediate", days: null })).toBe("2026-10-13");
    expect(paymentDueDate("2026-10-13", { kind: "net", days: 30 })).toBe("2026-11-12");
    expect(paymentDueDate("2026-10-13", { kind: "eom", days: 0 })).toBe("2026-10-31");
    expect(paymentDueDate("2026-10-13", { kind: "eom", days: 30 })).toBe("2026-11-30");
    // February of a leap year, and the end of the year
    expect(paymentDueDate("2028-02-10", { kind: "eom", days: 0 })).toBe("2028-02-29");
    expect(paymentDueDate("2026-12-31", { kind: "eom", days: 60 })).toBe("2027-03-01");
    // the years 0001..0099 stay themselves (Date.UTC would move them to 19xx), and the top edge
    expect(paymentDueDate("0050-02-10", { kind: "eom", days: 0 })).toBe("0050-02-28");
    expect(paymentDueDate("0004-02-10", { kind: "eom", days: 1 })).toBe("0004-03-01");
    expect(paymentDueDate("0001-01-01", { kind: "net", days: 365 })).toBe("0002-01-01");
    expect(paymentDueDate("9999-12-15", { kind: "eom", days: 0 })).toBe("9999-12-31");
    expect(paymentDueDate("9999-12-31", { kind: "net", days: 0 })).toBe("9999-12-31");
    // a rest day is not skipped: Saturday 31 October 2026 stays
    expect(paymentDueDate("2026-10-01", { kind: "net", days: 30 })).toBe("2026-10-31");
  });

  it("refuses terms the database would refuse, like app.payment_due_date (22023)", () => {
    const bad: Array<[string, { kind: string; days: number | null }]> = [
      ["2026-10-13", { kind: "weekly", days: 7 }],
      ["2026-10-13", { kind: "immediate", days: 0 }],
      ["2026-10-13", { kind: "net", days: null }],
      ["2026-10-13", { kind: "eom", days: -1 }],
      ["2026-10-13", { kind: "net", days: 366 }],
      ["2026-10-13", { kind: "net", days: 1.5 }],
      ["2026-02-30", { kind: "net", days: 1 }],
      // the edges of app.payment_due_date: years 0001..9999 only
      ["0000-06-01", { kind: "immediate", days: null }],
      ["9999-12-31", { kind: "net", days: 1 }],
      ["9999-12-01", { kind: "eom", days: 1 }],
    ];
    for (const [day, terms] of bad) {
      expect(() => paymentDueDate(day, terms)).toThrow(PaymentTermsError);
    }
  });

  it("names every kind in the terms select", () => {
    expect(Object.keys(PAYMENT_TERMS_LABELS).sort()).toEqual([...PAYMENT_TERMS].sort());
  });

  it("offers the owner's shortcuts, in order", () => {
    expect(PAYMENT_TERMS_SHORTCUTS.map((terms) => paymentTermsText(terms))).toEqual(["מיידי", "שוטף", "שוטף+30", "שוטף+60", "שוטף+90"]);
  });

  it("the TS rule says the same as the migration's (kinds, range, error)", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_payment_due_date.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(dir, file!), "utf8");
    expect(sql).toContain("p_terms not in ('immediate', 'net', 'eom')");
    expect(sql).toContain(`p_days > ${PAYMENT_DAYS_MAX}`);
    expect(sql).toContain("hint = 'payment_terms:invalid'");
    expect(new PaymentTermsError().hint).toBe("payment_terms:invalid");
  });

  it("a contact's empty fields show its company's values, marked as from the company", () => {
    const company = { ...companyBilling({ ...empty, tax_id: "514700000", billing_email: "billing@acme.co.il", payment_terms: "eom", payment_days: 30, price_list_id: "pl-1" }), name: "אקמה בע\"מ" };
    const own = contactBilling({ ...empty, billing_email: "dana@example.com" });
    const shown = effectiveBilling(own, company);
    expect(shown.email).toEqual({ value: "dana@example.com", fromCompany: false });
    expect(shown.name).toEqual({ value: "אקמה בע\"מ", fromCompany: true });
    expect(shown.taxId).toEqual({ value: "514700000", fromCompany: true });
    expect(shown.terms).toEqual({ value: { kind: "eom", days: 30 }, fromCompany: true });
    expect(shown.priceListId).toEqual({ value: "pl-1", fromCompany: true });
    expect(shown.address).toEqual({ value: null, fromCompany: false });
    // without a company (or one the user may not read) nothing is filled in
    expect(effectiveBilling(own, null).name).toEqual({ value: null, fromCompany: false });
  });

  it("parses the company form: terms with days, empty values as null", () => {
    expect(companyBillingSchema.parse(form({ billing_name: " אקמה ", payment_terms: "eom" }))).toMatchObject({
      billing_name: "אקמה",
      payment_terms: "eom",
      payment_days: 0,
      billing_email: null,
      price_list_id: null,
    });
    expect(companyBillingSchema.parse(form({ payment_terms: "immediate", payment_days: "30" }))).toMatchObject({ payment_terms: "immediate", payment_days: null });
    expect(companyBillingSchema.parse(form({ payment_terms: "", payment_days: "30" }))).toMatchObject({ payment_terms: null, payment_days: null });
    // an empty days box is 0 under both kinds (owner, 14 October 2026)
    expect(companyBillingSchema.parse(form({ payment_terms: "net" }))).toMatchObject({ payment_terms: "net", payment_days: 0 });
    expect(companyBillingSchema.parse(form({ payment_terms: "net", payment_days: " " }))).toMatchObject({ payment_terms: "net", payment_days: 0 });
    expect(companyBillingSchema.parse(form({ payment_terms: "eom", payment_days: "" }))).toMatchObject({ payment_terms: "eom", payment_days: 0 });
    expect(contactBillingSchema.parse(form({ payment_terms: "net", payment_days: "" }))).toMatchObject({ payment_terms: "net", payment_days: 0 });
    expect(companyBillingSchema.safeParse(form({ payment_terms: "net", payment_days: "366" })).success).toBe(false);
    expect(companyBillingSchema.safeParse(form({ payment_terms: "net", payment_days: "-1" })).success).toBe(false);
    expect(companyBillingSchema.safeParse(form({ payment_terms: "weekly" })).success).toBe(false);
    expect(companyBillingSchema.safeParse(form({ billing_email: "not an email" })).success).toBe(false);
    expect(companyBillingSchema.parse(form({ billing_email: "Billing@Acme.co.il" }))).toMatchObject({ billing_email: "billing@acme.co.il" });
    // the company form has no number of its own: companies.tax_id is the company's number
    expect("billing_tax_id" in companyBillingSchema.parse(form({ billing_tax_id: "123" }))).toBe(false);
  });

  it("a contact's number must have a valid check digit and is stored as 9 digits", () => {
    expect(contactBillingSchema.parse(form({ billing_tax_id: "000000018" }))).toMatchObject({ billing_tax_id: "000000018" });
    expect(contactBillingSchema.parse(form({ billing_tax_id: "12345-678 2" }))).toMatchObject({ billing_tax_id: "123456782" });
    expect(contactBillingSchema.safeParse(form({ billing_tax_id: "123456789" })).success).toBe(false);
    expect(contactBillingSchema.parse(form({}))).toMatchObject({ billing_tax_id: null });
  });
});
