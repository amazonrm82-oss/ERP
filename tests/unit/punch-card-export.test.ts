import { describe, expect, it } from "vitest";

import { cardForExport, holdings, within } from "@/features/punch-cards/export";

// PKG-01/PKG-02 (reviews 3 and 4): a person's export carries only what belongs to their holdings of a punch card
describe("punch cards in a person's export", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  // bought by A on 1 Oct, to B at 23:30 UTC on 10 Oct (02:30 on 11 Oct in Israel), back to A on 20 Oct
  const card = {
    id: "c1",
    contact_id: A,
    name: "כרטיסייה",
    product_id: "p1",
    entries_total: 10,
    created_at: "2026-10-01T08:00:00Z",
    holder_history: [
      { contact: A, until: "2026-10-10T23:30:00Z" },
      { contact: B, until: "2026-10-20T09:00:00Z" },
    ],
    former_contact_ids: [A, B],
    payment_id: "pay-A",
    price_agorot: 50000,
    activated_by: "staff",
    created_by: "staff",
    cancelled_at: "2026-10-15T10:00:00Z",
    cancel_reason: "נכתב בזמן של B",
  };
  const uses = [
    { id: "u1", card_id: "c1", created_at: "2026-10-10T20:00:00Z", used_on: "2026-10-10" },
    { id: "u2", card_id: "c1", created_at: "2026-10-12T08:00:00Z", used_on: "2026-10-12" },
    { id: "u3", card_id: "c1", created_at: "2026-10-21T08:00:00Z", used_on: "2026-10-21" },
    { id: "u4", card_id: "other", created_at: "2026-10-21T08:00:00Z", used_on: "2026-10-21" },
  ];

  it("finds both of A's holdings (A to B to A) and B's one, by instant", () => {
    const a = holdings(card.created_at, card.holder_history, [A], card.contact_id);
    expect(a.map((h) => [h.from.toISOString(), h.until?.toISOString() ?? null])).toEqual([
      ["2026-10-01T08:00:00.000Z", "2026-10-10T23:30:00.000Z"],
      ["2026-10-20T09:00:00.000Z", null],
    ]);
    const b = holdings(card.created_at, card.holder_history, [B], card.contact_id);
    expect(within(new Date("2026-10-15T00:00:00Z"), b)).toBe(true);
    expect(within(new Date("2026-10-21T00:00:00Z"), b)).toBe(false);
  });

  it("gives A, who bought it, the purchase and the entries of both holdings, without B's reason or ids", () => {
    const out = cardForExport(card, uses, [A], "Asia/Jerusalem");
    expect(out).not.toHaveProperty("former_contact_ids");
    expect(out).not.toHaveProperty("holder_history");
    expect(out.payment_id).toBe("pay-A");
    expect(out.cancel_reason).toBeNull();
    expect((out.uses as { id: string }[]).map((u) => u.id)).toEqual(["u1", "u3"]);
    // the holdings shown in the business's days: A's first one ends on 11 Oct in Israel
    expect(out.held).toEqual([
      { from: "2026-10-01", until: "2026-10-11" },
      { from: "2026-10-20", until: null },
    ]);
  });

  it("gives B, who received it, only their holding: no purchase, no current holder, B's reason and entry", () => {
    const out = cardForExport(card, uses, [B], "Asia/Jerusalem");
    for (const field of ["payment_id", "price_agorot", "activated_by", "created_by", "contact_id"]) expect(out, field).not.toHaveProperty(field);
    expect(out.cancel_reason).toBe("נכתב בזמן של B");
    expect((out.uses as { id: string }[]).map((u) => u.id)).toEqual(["u2"]);
  });
});
