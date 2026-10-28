import { describe, expect, it } from "vitest";

import { collectionFilters, collectionHref, collectionTexts, lateText, parseCollection } from "../../src/features/collection/collection";
import { DEFAULT_TERMS } from "../../src/features/terminology/terms";

const ID = "0b9c5a2e-6c1f-4c55-9a43-1d2e3f4a5b6c";

describe("collection screen (COL-01)", () => {
  it("reads only known filters from the address", () => {
    expect(collectionFilters({ owner: ID, overdue: "1", bucket: "d31_60", ck: "company", cid: ID })).toEqual({
      owner: ID,
      overdue: true,
      bucket: "d31_60",
      customer: { kind: "company", id: ID },
    });
    expect(collectionFilters({ owner: "x", overdue: "yes", bucket: "d1_99", ck: "lead", cid: ID })).toEqual({
      owner: null,
      overdue: false,
      bucket: null,
      customer: null,
    });
    expect(collectionFilters({ ck: "contact" }).customer).toBeNull();
  });

  it("writes the address back, empty filters left out", () => {
    const base = "/o/x/payments/collection";
    expect(collectionHref(base, { owner: null, overdue: false, bucket: null, customer: null })).toBe(base);
    const href = collectionHref(base, { owner: ID, overdue: true, bucket: "current", customer: { kind: "deal", id: ID } });
    expect(collectionFilters(Object.fromEntries(new URL(href, "http://h").searchParams))).toEqual({
      owner: ID,
      overdue: true,
      bucket: "current",
      customer: { kind: "deal", id: ID },
    });
  });

  it("words the days late", () => {
    expect(lateText(null)).toBe("בלי מועד תשלום");
    expect(lateText(1)).toBe("באיחור של יום אחד");
    expect(lateText(12)).toBe("באיחור של 12 ימים");
    expect(lateText(0)).toBe("לתשלום היום");
    expect(lateText(-1)).toBe("לתשלום מחר");
    expect(lateText(-5)).toBe("לתשלום בעוד 5 ימים");
  });

  it("parses the three answers and refuses an unknown shape", () => {
    expect(parseCollection({ allowed: false })).toEqual({ allowed: false });
    const partial = parseCollection({ allowed: true, partial: true, totals: null, shown: null, today: "2026-10-28", more: false, documents: [] });
    expect(partial.allowed && partial.partial && partial.totals).toBeNull();
    // a partial answer never carries totals
    expect(() => parseCollection({ allowed: true, partial: true, totals: { total: 1 }, shown: null, today: "2026-10-28", more: false, documents: [] })).toThrow();
    const full = parseCollection({
      allowed: true,
      partial: false,
      today: "2026-10-28",
      totals: { total: 100, overdue: 0, documents: 1, overdue_documents: 0, current: 100, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 },
      shown: { total: 100, documents: 1 },
      more: false,
      documents: [
        {
          id: ID,
          doc_type: "tax_invoice",
          number: "7",
          doc_date: "2026-10-01",
          due_date: null,
          amount: 100,
          balance: 100,
          days_late: null,
          bucket: "current",
          deal_id: null,
          contact_id: ID,
          company_id: null,
          customer_kind: "contact",
          customer_id: ID,
          customer_name: "דנה",
          owner_id: null,
          held: false,
        },
      ],
    });
    expect(full.allowed && !full.partial && full.documents[0].bucket).toBe("current");
    expect(() => parseCollection({ allowed: true, partial: false })).toThrow();
  });

  it("names the customer's kind in the business's words", () => {
    const texts = collectionTexts(DEFAULT_TERMS);
    expect(texts.kind.company).toBe("חברה");
    expect(texts.kind.contact).toBe(DEFAULT_TERMS.contact.singular);
    expect(texts.kind.deal).toBe(DEFAULT_TERMS.deal.singular);
  });
});
