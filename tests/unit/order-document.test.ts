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
  design: { headerText: null, footerText: null, showLogo: false, showBusinessDetails: true, accentColor: null },
  color: null,
  logoUrl: null,
  business: { name: "העסק", taxId: "515555555", address: null, phone: null, email: null },
  customer: { name: "דנה כהן", attention: null, address: null, email: null, taxId: null },
  order,
  lines: [line],
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

  it("a draft prints without a number", () => {
    const html = renderToStaticMarkup(createElement(OrderDocument, { data: { ...data, order: { ...order, status: "draft", numberDisplay: null } } }));
    expect(html).toContain("טיוטה, עוד ללא מספר");
  });
});
