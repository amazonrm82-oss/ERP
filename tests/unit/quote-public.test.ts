import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { quoteLinkMessage } from "@/features/quotes/components/quote-link-card";
import { QuoteDocument } from "@/features/quotes/components/quote-document";
import { publicQuoteFrom, publicQuotePath, QUOTE_LINK_TOKEN } from "@/features/quotes/public";

// QUO-08: the answer of public.quote_public() as the customer's page reads it.

const answer = (extra: Record<string, unknown> = {}) => ({
  quote: {
    number: "QT-1042",
    title: "שיפוץ מטבח",
    status: "sent",
    quote_date: "2026-10-16",
    valid_until: "2026-11-15",
    sent_at: "2026-10-16T09:00:00+00:00",
    prices_include_vat: false,
    no_vat_reason: null,
    no_vat_note: null,
    discount_bp: null,
    discount_agorot: null,
    notes: "תודה",
    terms: "שוטף + 30",
    vat_rate_bp: 1800,
    subtotal_agorot: 20000,
    discount_total_agorot: 0,
    net_total_agorot: 20000,
    vat_agorot: 3600,
    total_agorot: 23600,
    currency: "ILS",
  },
  customer: { name: "לקוח בע\"מ", contact: "דנה" },
  lines: [
    { position: 1, kind: "group", name: "שלב א", description: null, unit_name: null, quantity: 1, unit_price_agorot: 0, discount_bp: null, discount_agorot: null, vat_exempt: false, billing: "one_time", is_optional: false, optional_selected: false, total_agorot: 0 },
    { position: 2, kind: "item", name: "עבודה", description: "תיאור", unit_name: "שעה", quantity: "2", unit_price_agorot: 10000, discount_bp: null, discount_agorot: null, vat_exempt: false, billing: "one_time", is_optional: false, optional_selected: false, total_agorot: 20000 },
  ],
  business: { name: "העסק הרשום", tax_id: "515555555", address_line: "הרצל 1", city: "תל אביב", postal_code: null, phone: "03-5555555", email: null },
  design: { header_text: null, footer_text: "פרטי חשבון", show_logo: true, show_business_details: true, accent_color: null },
  brand: { logo: null, color: "#1e56d6" },
  built_with: true,
  ...extra,
});

describe("the customer's quote page (QUO-08)", () => {
  it("reads the answer into the document's shape, with made-up line keys and the names as printed", () => {
    const page = publicQuoteFrom(answer());
    expect(page).not.toBeNull();
    expect(page!.quote).toMatchObject({ numberDisplay: "QT-1042", status: "sent", totalAgorot: 23600, dealId: null, contactId: null, ownerId: null });
    expect(page!.lines.map((l) => [l.id, l.kind, l.quantity])).toEqual([
      ["line-1", "group", 1],
      ["line-2", "item", 2],
    ]);
    expect(page!.customer).toEqual({ name: 'לקוח בע"מ', attention: "דנה", address: null, email: null, taxId: null });
    expect(page!.business).toEqual({ name: "העסק הרשום", taxId: "515555555", address: "הרצל 1, תל אביב", phone: "03-5555555", email: null });
    // the business colour unless the design has its own
    expect(page!.color).toBe("#1e56d6");
    expect(publicQuoteFrom(answer({ design: { ...answer().design, accent_color: "#aabbcc" } }))!.color).toBe("#aabbcc");
    // no logo when the design hides it
    expect(publicQuoteFrom(answer({ design: { ...answer().design, show_logo: false }, brand: { logo: "x/y", color: null } }))!.logoPath).toBeNull();
    // an erased customer name leaves no customer block
    expect(publicQuoteFrom(answer({ customer: { name: null, contact: null } }))!.customer).toBeNull();
  });

  it("anything else is not a page", () => {
    expect(publicQuoteFrom(null)).toBeNull();
    expect(publicQuoteFrom({ rate_limited: true })).toBeNull();
    expect(publicQuoteFrom(answer({ lines: [{ kind: "item" }] }))).toBeNull();
  });

  it("draws the quote with its number, the customer and the stored totals", () => {
    const page = publicQuoteFrom(answer())!;
    const html = renderToStaticMarkup(
      createElement(QuoteDocument, {
        data: { design: page.design, color: page.color, logoUrl: null, business: page.business, customer: page.customer, quote: page.quote, lines: page.lines },
      }),
    );
    for (const text of ["QT-1042", "שיפוץ מטבח", "לקוח בע&quot;מ", "דנה", "שלב א", "עבודה", "236", "פרטי חשבון"]) expect(html, text).toContain(text);
    expect(html).not.toContain("טיוטה");
  });

  it("the link: 64 base64url characters, its path, and the WhatsApp message", () => {
    const token = "A".repeat(62) + "-_";
    expect(QUOTE_LINK_TOKEN.test(token)).toBe(true);
    expect(QUOTE_LINK_TOKEN.test(token.slice(1))).toBe(false);
    expect(QUOTE_LINK_TOKEN.test(`${token.slice(1)}/`)).toBe(false);
    expect(publicQuotePath(token)).toBe(`/f/quote/${token}`);
    expect(quoteLinkMessage("https://x/f/quote/t", "QT-7")).toBe("הצעת מחיר QT-7: https://x/f/quote/t");
    expect(quoteLinkMessage("https://x/f/quote/t", null)).toBe("הצעת מחיר: https://x/f/quote/t");
  });
});
