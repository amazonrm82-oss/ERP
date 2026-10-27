import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NOT_A_TAX_INVOICE, OrderDocument } from "@/features/orders/components/order-document";
import type { OrderDocumentData } from "@/features/orders/document-server";
import type { Order, OrderLine } from "@/features/orders/queries";

const order: Order = {
  id: "o-1",
  status: "new",
  source: "manual",
  numberDisplay: "ORD-1001",
  quoteId: null,
  originalOrderId: null,
  dealId: null,
  contactId: "c-1",
  companyId: null,
  deliveryContactId: null,
  ownerId: null,
  orderDate: "2026-10-19",
  deliveryDate: "2026-10-26",
  shippingAddress: "הרצל 1, חיפה",
  notes: "להתקשר לפני",
  pricesIncludeVat: false,
  noVatReason: null,
  vatRateBp: 1800,
  subtotalAgorot: 20000,
  discountTotalAgorot: 0,
  netTotalAgorot: 20000,
  vatAgorot: 3600,
  totalAgorot: 23600,
  customerName: "דנה כהן",
  confirmedAt: "2026-10-19T10:00:00Z",
  cancelledAt: null,
  customerDeletedAt: null,
  bankDetails: null,
  createdAt: "2026-10-19T10:00:00Z",
};

const line: OrderLine = {
  id: "l-1",
  position: 0,
  kind: "item",
  productId: null,
  name: "עבודה",
  description: null,
  unitName: null,
  quantity: 2,
  unitPriceAgorot: 10000,
  discountBp: null,
  discountAgorot: null,
  vatExempt: false,
  billing: "monthly",
  priceSource: "manual",
  priceListName: null,
  totalAgorot: 20000,
};

const data: OrderDocumentData = {
  design: { headerText: null, footerText: null, showLogo: false, showBusinessDetails: true, showBankDetailsQuote: true, showBankDetailsOrder: true, accentColor: null },
  color: null,
  logoUrl: null,
  business: { name: "העסק", taxId: "515555555", address: null, phone: null, email: null },
  customer: { name: "דנה כהן", attention: null, address: null, email: null, taxId: null },
  order,
  lines: [line],
  schedule: [],
};

// ORD-05 part one: the order confirmation says on its face that it is not a tax invoice (SPEC-ADDITIONS 6.3)
describe("order confirmation (ORD-05)", () => {
  it("names itself, says it is not a tax invoice, and shows the number, delivery and shipping details", () => {
    const html = renderToStaticMarkup(createElement(OrderDocument, { data }));
    expect(NOT_A_TAX_INVOICE).toBe("אינו חשבונית מס");
    expect(html).toContain("אישור הזמנה");
    expect(html.split(NOT_A_TAX_INVOICE).length - 1).toBe(2);
    expect(html).toContain("ORD-1001");
    expect(html).toContain("הרצל 1, חיפה");
    expect(html).toContain("להתקשר לפני");
    expect(html).toContain("חודשי");
  });

  it("shows the payment schedule with each step's share, and no section without one (ORD-04)", () => {
    expect(renderToStaticMarkup(createElement(OrderDocument, { data }))).not.toContain("לוח תשלומים");
    const html = renderToStaticMarkup(
      createElement(OrderDocument, {
        data: {
          ...data,
          schedule: [
            { key: "s1", name: "מקדמה", percentBp: 3000, dueDate: "2026-10-26", milestone: null, amountAgorot: 7080 },
            { key: "s2", name: "יתרה", percentBp: 7000, dueDate: null, milestone: "באספקה", amountAgorot: 16520 },
          ],
        },
      }),
    );
    expect(html).toContain("לוח תשלומים");
    expect(html).toContain("מקדמה");
    expect(html).toContain("באספקה");
    expect(html).toContain("30%");
    expect(html).toContain("70.80");
    expect(html).toContain("165.20");
  });

  it("a draft prints without a number", () => {
    const html = renderToStaticMarkup(createElement(OrderDocument, { data: { ...data, order: { ...order, status: "draft", numberDisplay: null } } }));
    expect(html).toContain("טיוטה, עוד ללא מספר");
  });
});

// TAX-02: the bank details stored when the order got its number, while the design shows them
describe("bank details on an order confirmation (TAX-02)", () => {
  const bank = { bankName: "בנק לאומי", branch: "800", account: "87654321", accountName: null };
  it("shows the stored block and hides it when the design says so or there is none", () => {
    expect(renderToStaticMarkup(createElement(OrderDocument, { data }))).not.toContain("פרטים להעברה בנקאית");
    const html = renderToStaticMarkup(createElement(OrderDocument, { data: { ...data, order: { ...order, bankDetails: bank } } }));
    expect(html).toContain("פרטים להעברה בנקאית");
    expect(html).toContain("87654321");
    const hidden = renderToStaticMarkup(
      createElement(OrderDocument, { data: { ...data, design: { ...data.design, showBankDetailsOrder: false }, order: { ...order, bankDetails: bank } } }),
    );
    expect(hidden).not.toContain("87654321");
  });
});
