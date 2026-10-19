import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createItems, navItems } from "@/features/shell/nav";
import {
  byGender,
  CONTACT_TERMS,
  DEAL_TERMS,
  DEFAULT_TERMS,
  LEAD_TERMS,
  noneYet,
  resolveTerms,
  termKeys,
  waitingPlural,
} from "@/features/terminology/terms";
import { RECORD_TYPES, recordTypeNames } from "@/lib/record-types";

const ORG = "11111111-1111-4111-8111-111111111111";

/** The keys a column of public.org_terms accepts, from the last migration that sets it. */
function keysInMigration(column: string): string[] {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().reverse()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    const match = sql.match(new RegExp(`${column}\\s+text check \\(${column} is null or ${column} in \\(([^)]*)\\)\\)`));
    if (match) return [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  }
  throw new Error(`no migration sets org_terms.${column}`);
}

describe("the business's own words (FLD-10)", () => {
  it("the ready lists are the owner's, and the database accepts exactly them", () => {
    expect(Object.values(CONTACT_TERMS).map((t) => t.singular)).toEqual(["איש קשר", "לקוח", "מטופל", "תלמיד", "חבר"]);
    expect(Object.values(LEAD_TERMS).map((t) => t.singular)).toEqual(["ליד", "פנייה", "מתעניין"]);
    expect(Object.values(DEAL_TERMS).map((t) => t.singular)).toEqual(["עסקה", "הזדמנות", "תיק"]);
    expect(keysInMigration("contact_term")).toEqual(Object.keys(CONTACT_TERMS));
    expect(keysInMigration("lead_term")).toEqual(Object.keys(LEAD_TERMS));
    expect(keysInMigration("deal_term")).toEqual(Object.keys(DEAL_TERMS));
  });

  it("every word carries all its forms, and the forms agree with its gender", () => {
    for (const term of [...Object.values(CONTACT_TERMS), ...Object.values(LEAD_TERMS), ...Object.values(DEAL_TERMS)]) {
      expect(term.plural.length).toBeGreaterThan(0);
      expect(term.newOne).toBe(`${term.singular} ${term.gender === "m" ? "חדש" : "חדשה"}`);
      // the definite article, at the start or inside a construct ("איש הקשר")
      expect(term.theSingular.split(" ").some((word) => word.startsWith("ה")), term.theSingular).toBe(true);
      expect(term.thePlural.split(" ").some((word) => word.startsWith("ה")), term.thePlural).toBe(true);
    }
    expect(LEAD_TERMS.inquiry.newOne).toBe("פנייה חדשה");
    expect(DEAL_TERMS.case.newOne).toBe("תיק חדש");
    expect(waitingPlural(LEAD_TERMS.inquiry)).toBe("פניות שמחכות");
    expect(waitingPlural(LEAD_TERMS.lead)).toBe("לידים שמחכים");
    expect(byGender(DEAL_TERMS.opportunity, "פתוחים", "פתוחות")).toBe("פתוחות");
    expect(noneYet(CONTACT_TERMS.patient)).toBe("אין עדיין מטופלים");
  });

  it("no choice, or an unknown one, is today's words, so nothing changes until a business picks", () => {
    expect(resolveTerms(termKeys(null))).toEqual(DEFAULT_TERMS);
    expect(resolveTerms(termKeys({ contact_term: "nonsense", lead_term: null, deal_term: undefined }))).toEqual(DEFAULT_TERMS);
    expect(DEFAULT_TERMS.contact.plural).toBe(RECORD_TYPES.contact.plural);
    expect(DEFAULT_TERMS.lead.plural).toBe(RECORD_TYPES.lead.plural);
    expect(DEFAULT_TERMS.deal.plural).toBe(RECORD_TYPES.deal.plural);
  });

  it("the menu, the + menu and the record names use the picked words", () => {
    const terms = resolveTerms({ contact: "patient", lead: "inquiry", deal: "case" });
    const nav = Object.fromEntries(navItems(ORG, terms).map((item) => [item.key, item.label]));
    expect([nav.leads, nav.contacts, nav.deals]).toEqual(["פניות", "מטופלים", "תיקים"]);
    const create = Object.fromEntries(createItems(ORG, terms).map((item) => [item.key, item.label]));
    expect([create.lead, create.contact, create.deal]).toEqual(["פנייה חדשה", "מטופל חדש", "תיק חדש"]);
    expect(recordTypeNames("contact", terms)).toEqual({ singular: "מטופל", plural: "מטופלים" });
    // companies and tasks keep their names
    expect(recordTypeNames("company", terms)).toEqual({ singular: "חברה", plural: "חברות" });
    // without a business at hand: today's words
    expect(navItems(ORG).find((item) => item.key === "leads")?.label).toBe("לידים");
  });
});
