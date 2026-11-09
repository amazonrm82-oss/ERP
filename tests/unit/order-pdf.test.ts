import { describe, expect, it } from "vitest";

import { NOT_A_TAX_INVOICE } from "@/features/orders/components/order-document";
import type { OrderDocumentData } from "@/features/orders/document-server";
import { ORDER_PDF_NOT_A_TAX_INVOICE, orderPdfDocument, orderPdfFileName, orderPdfOutdated } from "@/features/orders/pdf";
import { publicOrderPdfPath } from "@/features/orders/public";
import type { Order, OrderLine } from "@/features/orders/queries";
import { renderPdf } from "@/features/pdf/render";
import { DAMAGED_ORDER_PDF_MESSAGE } from "@/features/quotes/pdf-fingerprint";

import { pdfText } from "./pdf-text";

// ORD-05 PDF (owner, 1 November 2026, answer (1) ב): the order confirmation's PDF, read back from a real file: Hebrew in visual
// order, the number and amounts left to right, "אינו חשבונית מס" on its face and on every page, a long table with its header
// on every page, the delivery date and the shipping address, the bank details stored with the order.

const reverse = (s: string) => [...s].reverse().join("");

function line(i: number): OrderLine {
  return {
    id: `l${i}`,
    position: i,
    kind: "item",
    productId: null,
    name: `התקנת מערכת מספר ${i} (Model X2)`,
    description: i % 7 === 0 ? "כולל הובלה, התקנה באתר הלקוח והדרכה קצרה לצוות." : null,
    unitName: "יח'",
    quantity: 3,
    unitPriceAgorot: 45000,
    discountBp: i % 5 === 0 ? 1000 : null,
    discountAgorot: null,
    vatExempt: false,
    billing: i % 6 === 0 ? "monthly" : "one_time",
    priceSource: "manual",
    priceListName: null,
    totalAgorot: 135000,
    bundleDisplay: null,
    bundleParts: [],
  };
}

function sample(lineCount: number, extra: Partial<Order> = {}): OrderDocumentData {
  const order: Order = {
    id: "o1",
    status: "new",
    source: "manual",
    numberDisplay: "ORD-2041",
    quoteId: null,
    originalOrderId: null,
    dealId: null,
    contactId: null,
    companyId: null,
    deliveryContactId: null,
    ownerId: null,
    orderDate: "2026-11-01",
    deliveryDate: "2026-11-15",
    shippingAddress: "רחוב האלון 5, חיפה",
    notes: "לתאם הגעה מראש: 052-1234567.",
    pricesIncludeVat: false,
    noVatReason: null,
    vatRateBp: 1800,
    subtotalAgorot: 9450000,
    discountTotalAgorot: 0,
    netTotalAgorot: 9450000,
    vatAgorot: 1701000,
    totalAgorot: 11151000,
    customerName: "Acme Ltd.",
    confirmedAt: "2026-11-01T09:00:00Z",
    cancelledAt: null,
    customerDeletedAt: null,
    createdAt: "2026-11-01T08:00:00Z",
    bankDetails: { bankName: "בנק הפועלים", branch: "600", account: "87654321", accountName: "חברת הדוגמה בע\"מ" },
    ...extra,
  };
  return {
    design: { headerText: null, footerText: "תודה שבחרתם בנו", showLogo: true, showBusinessDetails: true, showBankDetailsQuote: true, showBankDetailsOrder: true, showBankDetailsStatement: true, accentColor: null },
    color: "#0f766e",
    logoUrl: null,
    business: { name: 'חברת הדוגמה בע"מ', taxId: "512345678", address: "רחוב הרצל 10, תל אביב", phone: "+972-3-555-1234", email: "office@example.co.il" },
    customer: { name: "Acme Ltd.", attention: "ישראל ישראלי", address: null, email: "billing@acme.example", taxId: null },
    order,
    lines: [{ ...line(0), kind: "group", name: "שלב א: ציוד", unitName: null, totalAgorot: 0 }, ...Array.from({ length: lineCount }, (_, i) => line(i + 1))],
    schedule: [
      { key: "s1", name: "מקדמה", percentBp: 3000, dueDate: null, milestone: "באישור", amountAgorot: 3345300 },
      { key: "s2", name: "יתרה", percentBp: 7000, dueDate: "2026-11-30", milestone: null, amountAgorot: 7805700 },
    ],
  };
}

describe("the order confirmation PDF (ORD-05)", () => {
  it("is a real PDF: Hebrew in visual order, number and amounts left to right, 'אינו חשבונית מס' on every page", async () => {
    const bytes = await renderPdf(orderPdfDocument(sample(70), null));
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const pages = pdfText(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const pieces = pages.flatMap((page) => page.pieces.map((p) => p.text));
    const all = pieces.join("\n");

    expect(pieces).toContain(reverse("אישור הזמנה"));
    expect(pieces).toContain(`ORD-2041 :${reverse("מספר")}`);
    expect(pieces).toContain("+972-3-555-1234");
    expect(pieces).toContain("office@example.co.il");
    expect(all).toContain(reverse("כתובת משלוח"));
    expect(all).toContain(reverse("מועד אספקה"));
    expect(pieces).toContain(`(Model X2) 7 ${reverse("התקנת מערכת מספר")}`);
    expect(pieces).toContain("₪ 1,350");
    expect(pieces).toContain("₪ 111,510");
    expect(pieces).toContain("10%");
    // the payment schedule and the bank details stored with the order
    expect(pieces).toContain(reverse("לוח תשלומים"));
    expect(pieces).toContain(`87654321 :${reverse("מספר חשבון")}`);
    // the table header on every page the lines are on
    const tablePages = pages.filter((page) => page.pieces.some((p) => p.text.includes("(Model X2)")));
    expect(tablePages.length).toBeGreaterThanOrEqual(2);
    for (const page of tablePages) expect(page.pieces.map((p) => p.text)).toContain(reverse("תיאור"));
    // "אינו חשבונית מס" under the title, by the total and at the foot of every page
    expect(all).toContain(reverse(`מסמך זה ${NOT_A_TAX_INVOICE}.`));
    for (const page of pages) expect(page.pieces.map((p) => p.text).join("\n")).toContain(reverse(NOT_A_TAX_INVOICE));
    expect(all).not.toContain("�");
  });

  it("leaves the bank details out when the design hides them, and an empty order still makes one page", async () => {
    const data = sample(0);
    data.lines = [];
    data.schedule = [];
    data.design = { ...data.design, showBankDetailsOrder: false };
    const pages = pdfText(await renderPdf(orderPdfDocument(data, null)));
    expect(pages).toHaveLength(1);
    const all = pages[0].pieces.map((p) => p.text).join("\n");
    expect(all).toContain(reverse("אין שורות בהזמנה."));
    expect(all).not.toContain("87654321");
  });

  it("lists an itemised bundle's parts under its line, quantities times the line's, and no parts for a single-line bundle (PRD-09)", async () => {
    const data = sample(0);
    const parts = [
      { name: "מזגן", quantity: 2, unitName: null },
      { name: "צנרת", quantity: 1.5, unitName: "מטר" },
    ];
    data.lines = [
      { ...line(1), name: "חבילת התקנה", bundleDisplay: "itemised", bundleParts: parts },
      { ...line(2), name: "חבילה סגורה", bundleDisplay: "single", bundleParts: [{ name: "מסנן", quantity: 1, unitName: null }] },
    ];
    const all = pdfText(await renderPdf(orderPdfDocument(data, null)))
      .flatMap((page) => page.pieces.map((p) => p.text))
      .join("\n");
    // visual order: line quantity 3 x 2 per bundle, 3 x 1.5 metres
    expect(all).toContain(`${reverse("מזגן")} 6 ·`);
    expect(all).toContain(`${reverse("צנרת")} ${reverse("מטר")} 4.5 ·`);
    expect(all).not.toContain(reverse("מסנן"));
  });

  it("prints a punch card line's service recipient as sent, 'עבור: <name>', and nothing on other lines (PKG-06, owner (156) א)", async () => {
    const data = sample(0);
    data.lines = [
      { ...line(1), name: "כרטיסיית חוג", recipientName: "נועה לוי" },
      { ...line(2), name: "שיעור בודד", recipientName: null },
    ];
    const all = pdfText(await renderPdf(orderPdfDocument(data, null)))
      .flatMap((page) => page.pieces.map((p) => p.text))
      .join("\n");
    expect(all).toContain(reverse("עבור: נועה לוי"));
    expect(all.split(reverse("עבור:")).length).toBe(2);
  });

  it("names the file after the order's number, keeps the document's wording, and links the customer's download", () => {
    expect(orderPdfFileName("ORD-2041")).toBe("אישור הזמנה ORD-2041.pdf");
    expect(orderPdfFileName(null)).toBe("אישור הזמנה.pdf");
    expect(ORDER_PDF_NOT_A_TAX_INVOICE).toBe(NOT_A_TAX_INVOICE);
    expect(publicOrderPdfPath("a".repeat(64))).toBe(`/api/forms/order/${"a".repeat(64)}/pdf`);
    expect(DAMAGED_ORDER_PDF_MESSAGE).toContain("ההזמנה");
  });

  it("a PDF is out of date when it was made from other content than the order's present one (review, medium)", () => {
    expect(orderPdfOutdated({ pdfContentChangedAt: null }, { contentStamp: null })).toBe(false);
    expect(orderPdfOutdated({ pdfContentChangedAt: "2026-11-01T10:00:00.123456+00:00" }, { contentStamp: "2026-11-01T10:00:00.123456+00:00" })).toBe(false);
    expect(orderPdfOutdated({ pdfContentChangedAt: "2026-11-01T10:00:01+00:00" }, { contentStamp: "2026-11-01T10:00:00+00:00" })).toBe(true);
    // made before any change, the order changed since
    expect(orderPdfOutdated({ pdfContentChangedAt: "2026-11-01T10:00:01+00:00" }, { contentStamp: null })).toBe(true);
    expect(orderPdfOutdated({ pdfContentChangedAt: "2026-11-01T10:00:01+00:00" }, null)).toBe(false);
  });
});

describe("DSN-17: the order PDF is one of the customer family", () => {
  it("carries the business's colour and logo as the page does", () => {
    const logo = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]), kind: "png" as const };
    const data = sample(1);
    const doc = orderPdfDocument(data, logo);
    expect(doc.color).toBe(data.color);
    expect(doc.logo).toBe(logo);
  });
});
