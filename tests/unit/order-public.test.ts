import { describe, expect, it } from "vitest";

import { ORDER_ACCEPT_WORDING_VERSION, ORDER_LINK_TOKEN, publicOrderFrom, publicOrderPath, statusOrderFrom } from "@/features/orders/public";

// ORD-05: the customer's page reads public.order_public's answer into the order document's shape; anything else is refused.

const answer = {
  order: {
    number: "ORD-1001",
    status: "new",
    order_date: "2026-10-20",
    delivery_date: "2026-10-27",
    shipping_address: "רחוב 1",
    notes: "הערה",
    prices_include_vat: false,
    no_vat_reason: null,
    no_vat_note: null,
    discount_bp: null,
    discount_agorot: null,
    vat_rate_bp: 1800,
    subtotal_agorot: 20000,
    discount_total_agorot: 0,
    net_total_agorot: 20000,
    vat_agorot: 3600,
    total_agorot: 23600,
    currency: "ILS",
  },
  customer: { name: "דנה" },
  lines: [
    {
      position: 0,
      kind: "item",
      name: "עבודה",
      description: null,
      unit_name: null,
      quantity: 2,
      unit_price_agorot: 10000,
      discount_bp: null,
      discount_agorot: null,
      vat_exempt: false,
      billing: "one_time",
      total_agorot: 20000,
    },
  ],
  schedule: [{ name: "מקדמה", percent_bp: 10000, due_date: null, milestone: "באישור", amount_agorot: 23600 }],
  business: { name: "העסק", tax_id: null, address_line: "הרצל 1", city: "חיפה", postal_code: null, phone: null, email: null },
  design: { header_text: null, footer_text: null, show_logo: true, show_business_details: true, accent_color: null },
  brand: { logo: null, color: null },
  built_with: true,
  decision: null,
  fingerprint: "a".repeat(64),
};

describe("the customer's order page (ORD-05)", () => {
  it("reads the answer with made-up keys and no ids", () => {
    const page = publicOrderFrom(answer)!;
    expect(page.order).toMatchObject({ numberDisplay: "ORD-1001", status: "new", totalAgorot: 23600, dealId: null, contactId: null });
    expect(page.lines.map((l) => l.id)).toEqual(["line-1"]);
    expect(page.schedule[0]).toMatchObject({ key: "step-1", amountAgorot: 23600 });
    expect(page.business.address).toBe("הרצל 1, חיפה");
    expect(page.fingerprint).toBe("a".repeat(64));
    expect(publicOrderFrom({ ...answer, lines: "x" })).toBeNull();
    expect(publicOrderFrom({ ...answer, decision: { decision: "accepted", decided_at: "2026-10-20T10:00:00Z" }, fingerprint: null })?.decision).toEqual({
      decision: "accepted",
      decidedAt: "2026-10-20T10:00:00Z",
    });
  });

  it("reads a cancelled order's status page, and nothing else as one", () => {
    expect(statusOrderFrom({ status_page: { state: "cancelled", number: "ORD-7", business: "העסק", logo: null, color: null, phone: "03-1" } })).toEqual({
      statusPage: true,
      state: "cancelled",
      number: "ORD-7",
      business: "העסק",
      logoPath: null,
      phone: "03-1",
    });
    expect(statusOrderFrom(answer)).toBeNull();
  });

  it("the link and the wording version have the shapes the database checks", () => {
    const token = "A".repeat(64);
    expect(ORDER_LINK_TOKEN.test(token)).toBe(true);
    expect(ORDER_LINK_TOKEN.test("A".repeat(63))).toBe(false);
    expect(publicOrderPath(token)).toBe(`/f/order/${token}`);
    expect(ORDER_ACCEPT_WORDING_VERSION).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});

describe("bank details on the customer's order page (TAX-02)", () => {
  it("reads `bank` into the order; absent (older answers) or null is none", () => {
    expect(publicOrderFrom(answer)!.order.bankDetails).toBeNull();
    expect(publicOrderFrom(answer)!.design.showBankDetailsOrder).toBe(true);
    const page = publicOrderFrom({
      ...answer,
      design: { ...answer.design, show_bank_details_order: true },
      bank: { bank_name: "בנק", bank_branch: "12", bank_account: "1234567", bank_account_name: null },
    })!;
    expect(page.order.bankDetails).toEqual({ bankName: "בנק", branch: "12", account: "1234567", accountName: null });
    expect(publicOrderFrom({ ...answer, design: { ...answer.design, show_bank_details_order: false }, bank: null })!.design.showBankDetailsOrder).toBe(false);
  });
});
