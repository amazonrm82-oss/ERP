import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuoteDocument } from "@/features/quotes/components/quote-document";
import type { QuoteDocumentData } from "@/features/quotes/design-server";
import { DEFAULT_QUOTE_DESIGN, designFromRow, quoteColor, quoteDesignSchema, sentCustomer } from "@/features/quotes/design";
import type { Quote, QuoteLine } from "@/features/quotes/queries";

const form = (values: Record<string, string>) => ({ header_text: "", footer_text: "", color_mode: "brand", ...values });

describe("quote design rules (QUO-05)", () => {
  it("no row is the defaults; the quote's own colour wins over the business colour", () => {
    expect(designFromRow(null)).toEqual(DEFAULT_QUOTE_DESIGN);
    expect(quoteColor(DEFAULT_QUOTE_DESIGN, "#112233")).toBe("#112233");
    expect(quoteColor({ ...DEFAULT_QUOTE_DESIGN, accentColor: "#aabbcc" }, "#112233")).toBe("#aabbcc");
    expect(quoteColor(DEFAULT_QUOTE_DESIGN, null)).toBeNull();
    // a stored value that is not a colour is ignored
    expect(designFromRow({ header_text: null, footer_text: null, show_logo: true, show_business_details: false, accent_color: "red" }).accentColor).toBeNull();
  });

  it("the form: unchecked boxes are off, the business colour clears the own one, an own colour must be a colour", () => {
    const off = quoteDesignSchema.safeParse(form({ header_text: "  שלום  " }));
    expect(off.success && off.data).toEqual({ header_text: "שלום", footer_text: null, show_logo: false, show_business_details: false, accent_color: null });
    const own = quoteDesignSchema.safeParse(form({ color_mode: "own", accent_color: "#ABC", show_logo: "on", show_business_details: "on" }));
    expect(own.success && own.data).toMatchObject({ show_logo: true, show_business_details: true, accent_color: "#aabbcc" });
    expect(quoteDesignSchema.safeParse(form({ color_mode: "own", accent_color: "כחול" })).success).toBe(false);
    expect(quoteDesignSchema.safeParse(form({ color_mode: "brand", accent_color: "#aabbcc" })).success && true).toBe(true);
    expect(quoteDesignSchema.safeParse(form({ header_text: "א".repeat(501) })).success).toBe(false);
  });
});

const quote = (extra: Partial<Quote> = {}): Quote => ({
  id: "q",
  previousId: null,
  title: "שיפוץ מטבח",
  status: "draft",
  numberDisplay: null,
  sentAt: null,
  customerName: null,
  customerContactName: null,
  customerDeletedAt: null,
  dealId: null,
  contactId: null,
  companyId: null,
  ownerId: null,
  quoteDate: "2026-10-16",
  validUntil: "2026-11-15",
  pricesIncludeVat: false,
  noVatReason: null,
  noVatNote: null,
  discountBp: null,
  discountAgorot: null,
  notes: null,
  terms: null,
  vatRateBp: 1800,
  subtotalAgorot: 27000,
  discountTotalAgorot: 0,
  netTotalAgorot: 27000,
  vatAgorot: 4860,
  totalAgorot: 31860,
  createdAt: "2026-10-16",
  ...extra,
});

const line = (extra: Partial<QuoteLine>): QuoteLine => ({
  id: "l",
  position: 1,
  kind: "item",
  productId: null,
  name: "שורה",
  description: null,
  unitName: null,
  quantity: 1,
  unitPriceAgorot: 10000,
  discountBp: null,
  discountAgorot: null,
  vatExempt: false,
  billing: "one_time",
  isOptional: false,
  optionalSelected: false,
  source: "manual",
  priceListId: null,
  priceListName: null,
  totalAgorot: 10000,
  ...extra,
});

const data = (extra: Partial<QuoteDocumentData> = {}): QuoteDocumentData => ({
  design: { ...DEFAULT_QUOTE_DESIGN, headerText: "כותרת עליונה לדוגמה", footerText: "פרטי חשבון לדוגמה" },
  color: "#1e56d6",
  logoUrl: "https://example.com/logo.png",
  business: { name: "העסק הרשום בע\"מ", taxId: "515555555", address: "הרצל 1, תל אביב", phone: "03-5555555", email: "office@example.com" },
  customer: { name: "לקוח בע\"מ", attention: "ישראל ישראלי", address: "הדוגמה 2", email: "c@example.com", taxId: null },
  quote: quote(),
  lines: [
    line({ id: "g", kind: "group", name: "שלב א", unitPriceAgorot: 0, totalAgorot: 0 }),
    line({ id: "a", name: "עבודה", quantity: 3, discountBp: 1000, totalAgorot: 27000 }),
    line({ id: "o", name: "תוספת רשות", isOptional: true, totalAgorot: 5000 }),
  ],
  ...extra,
});

describe("the quote document (QUO-05)", () => {
  it("shows the design, the business, the customer, the lines with group sums and the stored totals", () => {
    const html = renderToStaticMarkup(createElement(QuoteDocument, { data: data() }));
    for (const text of ["כותרת עליונה לדוגמה", "פרטי חשבון לדוגמה", "העסק הרשום בע&quot;מ", "515555555", "לקוח בע&quot;מ", "לידי", "שלב א", "עבודה", "רשות, לא כלולה בסיכום"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain("logo.png");
    expect(html).toContain("מע&quot;מ 18%");
    expect(html).toContain("318.60");
    expect(html).toContain("טיוטה, עוד ללא מספר");
    expect(html).toContain("שורות רשות שלא סומנו אינן כלולות בסיכום.");
  });

  it("FXA-09: the title is the page's main heading, or a level lower inside a page that has its own", () => {
    expect(renderToStaticMarkup(createElement(QuoteDocument, { data: data() }))).toMatch(/<h1[^>]*><bdi>/);
    const preview = renderToStaticMarkup(createElement(QuoteDocument, { data: data(), headingLevel: 3 }));
    expect(preview).not.toContain("<h1");
    expect(preview).toMatch(/<h3[^>]*><bdi>/);
    expect(renderToStaticMarkup(createElement(QuoteDocument, { data: data(), headingLevel: 2 }))).not.toContain("<h1");
  });

  it("hides what the design turns off, and shows no VAT line on a quote without VAT", () => {
    const html = renderToStaticMarkup(
      createElement(QuoteDocument, {
        data: data({
          design: { ...DEFAULT_QUOTE_DESIGN, showBusinessDetails: false },
          logoUrl: null,
          quote: quote({ noVatReason: "eilat", vatRateBp: 0, vatAgorot: 0, totalAgorot: 27000 }),
        }),
      }),
    );
    expect(html).not.toContain("515555555");
    expect(html).not.toContain("logo.png");
    expect(html).not.toContain("מע&quot;מ 18%");
    expect(html).toContain("הצעה בלי מע&quot;מ: אילת");
    const exempt = renderToStaticMarkup(createElement(QuoteDocument, { data: data({ quote: quote({ vatRateBp: 0, vatAgorot: 0, totalAgorot: 27000 }) }) }));
    expect(exempt).not.toContain("מע&quot;מ 0%");
  });

  it("a sent quote shows its number instead of the draft line (QUO-07)", () => {
    const html = renderToStaticMarkup(createElement(QuoteDocument, { data: data({ quote: quote({ status: "sent", numberDisplay: "QT-1042" }) }) }));
    expect(html).toContain("QT-1042");
    expect(html).not.toContain("טיוטה, עוד ללא מספר");
  });
});

describe("the customer on a sent quote (QUO-07)", () => {
  const live = { name: "שם חדש בע\"מ", attention: "דנה", address: "הדוגמה 2", email: "c@example.com", taxId: "515555555" };
  it("a draft shows the live record", () => {
    expect(sentCustomer({ status: "draft", customerName: "שם ישן", customerContactName: null }, live)).toBe(live);
  });
  it("a sent quote keeps the names as printed, and the address from the record while it exists", () => {
    expect(sentCustomer({ status: "sent", customerName: "שם ישן", customerContactName: "ישראל" }, live)).toEqual({ ...live, name: "שם ישן", attention: "ישראל" });
    expect(sentCustomer({ status: "sent", customerName: "שם ישן", customerContactName: null }, null)).toEqual({
      name: "שם ישן",
      attention: null,
      address: null,
      email: null,
      taxId: null,
    });
  });
  it("an erased quote (no names left) falls back to the record, which is gone", () => {
    expect(sentCustomer({ status: "sent", customerName: null, customerContactName: null }, null)).toBeNull();
  });
});

