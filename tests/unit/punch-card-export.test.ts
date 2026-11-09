import { describe, expect, it } from "vitest";

import { cardForExport, holdings, OPENED_FROM_OTHER_CUSTOMER, paidCardForExport, PURCHASE_FIELDS, PURCHASE_STAFF_FIELDS, within } from "@/features/punch-cards/export";

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

  // PKG-06 (review finding 5): the holder's export never carries who paid (another person's ids)
  it("drops the payer's ids from a card someone else paid for", () => {
    const out = cardForExport({ ...card, payer_contact_id: "parent", payer_company_id: "company" }, uses, [A], "Asia/Jerusalem");
    expect(out).not.toHaveProperty("payer_contact_id");
    expect(out).not.toHaveProperty("payer_company_id");
  });

  // owner (159) ב: a card opened from another customer's document is marked, with no payer name or document number
  it("marks a card another customer paid for, and only such a card", () => {
    const byParent = cardForExport({ ...card, payer_contact_id: "parent" }, uses, [A], "Asia/Jerusalem");
    expect(byParent.opened_from).toBe(OPENED_FROM_OTHER_CUSTOMER);
    expect(OPENED_FROM_OTHER_CUSTOMER).toBe("נפתחה ממסמך של לקוח אחר");
    expect(JSON.stringify(byParent)).not.toContain("parent");
    const byCompany = cardForExport({ ...card, payer_company_id: "company" }, uses, [A], "Asia/Jerusalem");
    expect(byCompany.opened_from).toBe(OPENED_FROM_OTHER_CUSTOMER);
    expect(cardForExport(card, uses, [A], "Asia/Jerusalem")).not.toHaveProperty("opened_from");
    // the payer is the person (a conversion relative of the exported record): no mark
    expect(cardForExport({ ...card, payer_contact_id: "A-lead-contact" }, uses, [A, "A-lead-contact"], "Asia/Jerusalem")).not.toHaveProperty("opened_from");
  });

  // owner (164) ב: the recipient's export carries none of the payer's purchase; the payer's own export carries all of it
  it("leaves the payer's purchase out of a card another customer paid for, and keeps it on a card the person paid for", () => {
    const bought = {
      ...card,
      payment_id: "pay-parent",
      price_agorot: 40000,
      currency: "ILS",
      order_line_id: "ol-1",
      quote_line_id: "ql-1",
      deal_line_id: "dl-1",
      unit_no: 1,
      activated_by: "staff",
      activated_at: "2026-10-01T09:00:00.000Z",
      activated_manually: false,
      created_by: "staff",
      payment_void_at: null,
      status: "active",
      expires_on: "2027-01-01",
    };
    for (const paid of [{ payer_contact_id: "parent" }, { payer_company_id: "company" }]) {
      const out = cardForExport({ ...bought, ...paid }, uses, [A], "Asia/Jerusalem");
      for (const field of PURCHASE_FIELDS) expect(out, field).not.toHaveProperty(field);
      for (const value of ["pay-parent", "ol-1", "ql-1", "dl-1", "parent", "company"]) expect(JSON.stringify(out)).not.toContain(value);
      // what is the recipient's own stays: the card, its entries, validity, status and uses
      expect(out).toMatchObject({ id: card.id, name: card.name, entries_total: card.entries_total, status: "active", expires_on: "2027-01-01", opened_from: OPENED_FROM_OTHER_CUSTOMER });
      expect((out.uses as { id: string }[]).map((u) => u.id)).toEqual(["u1", "u3"]);
    }
    // review LOW 3: the payer was purged (its columns emptied); the server's mark still marks it and drops the purchase
    const purged = cardForExport({ ...bought, opened_for_other_payer: true }, uses, [A], "Asia/Jerusalem");
    expect(purged.opened_from).toBe(OPENED_FROM_OTHER_CUSTOMER);
    expect(purged).not.toHaveProperty("opened_for_other_payer");
    for (const field of PURCHASE_FIELDS) expect(purged, field).not.toHaveProperty(field);
    // the person paid for it themselves: the purchase stays, no mark
    const own = cardForExport(bought, uses, [A], "Asia/Jerusalem");
    expect(own).toMatchObject({ payment_id: "pay-parent", price_agorot: 40000, order_line_id: "ol-1", quote_line_id: "ql-1" });
    expect(own).not.toHaveProperty("opened_from");
    // the payer's own export (punch_cards_paid) carries every purchase field the recipient's leaves out, except the staff
    // fields, which neither export carries
    const payerView = paidCardForExport({ ...bought, payer_contact_id: "parent" });
    const staff: readonly string[] = PURCHASE_STAFF_FIELDS;
    for (const field of PURCHASE_FIELDS) {
      if (staff.includes(field)) expect(payerView, field).not.toHaveProperty(field);
      else expect(payerView, field).toHaveProperty(field);
    }
    expect(JSON.stringify(payerView)).not.toContain("staff");
    expect(payerView).toMatchObject({ payment_id: "pay-parent", price_agorot: 40000, order_line_id: "ol-1", quote_line_id: "ql-1", payer_contact_id: "parent" });
  });

  // owner (168) ב (migration 021189): a merge that folds the recipient R into the payer P rewrites R's holding entries to P,
  // so P holds the card from its creation and its export shows the purchase as P's own; a card that came to R from another
  // holder by a transfer keeps that holder first, so the purchase stays out (transfers unchanged)
  it("shows the purchase to the payer once a merge made the recipient's holding the payer's own", () => {
    const P = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const R = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const merged = {
      id: "c2",
      contact_id: P,
      name: "כרטיסייה",
      entries_total: 10,
      created_at: "2026-10-01T08:00:00Z",
      payment_id: "pay-P",
      price_agorot: 40000,
      order_line_id: "ol-P",
      activated_at: "2026-10-01T09:00:00Z",
      payer_contact_id: null,
      opened_for_other_payer: false,
      former_contact_ids: [R],
    };
    const mergeUse = [{ id: "u9", card_id: "c2", created_at: "2026-10-05T08:00:00Z", used_on: "2026-10-05" }];
    // as the merge now writes it: R's entry names P
    const own = cardForExport({ ...merged, payer_holder_id: P, holder_history: [{ contact: P, until: "2026-10-10T08:00:00Z" }] }, mergeUse, [P], "Asia/Jerusalem");
    expect(own).toMatchObject({ payment_id: "pay-P", price_agorot: 40000, order_line_id: "ol-P" });
    expect(own).not.toHaveProperty("opened_from");
    // R's use, made before the merge, is P's too (the same person)
    expect((own.uses as { id: string }[]).map((u) => u.id)).toEqual(["u9"]);
    expect(own.held).toEqual([
      { from: "2026-10-01", until: "2026-10-10" },
      { from: "2026-10-10", until: null },
    ]);
    // the history the merge wrote before 021189 (R's entry kept): the purchase stays out, as a card that came by a merge
    const before = cardForExport({ ...merged, holder_history: [{ contact: R, until: "2026-10-10T08:00:00Z" }] }, mergeUse, [P], "Asia/Jerusalem");
    for (const field of PURCHASE_FIELDS) expect(before, field).not.toHaveProperty(field);
    // owner (173) ב: a card X held first and transferred to R, then R merged into P: the merge marks P (payer_holder_id), so
    // P gets the purchase as their own; X, who did not pay, sees it as opened from another customer's document, without it
    const transferredCard = {
      ...merged,
      payer_holder_id: P,
      opened_for_other_payer: true,
      former_contact_ids: [X],
      holder_history: [{ contact: X, until: "2026-10-03T08:00:00Z" }, { contact: P, until: "2026-10-10T08:00:00Z" }],
    };
    const payerView = cardForExport(transferredCard, mergeUse, [P], "Asia/Jerusalem");
    expect(payerView).toMatchObject({ payment_id: "pay-P", price_agorot: 40000, order_line_id: "ol-P" });
    expect(payerView).not.toHaveProperty("opened_from");
    expect(payerView).not.toHaveProperty("payer_holder_id");
    expect(JSON.stringify(payerView)).not.toContain(X);
    const firstHolder = cardForExport(transferredCard, mergeUse, [X], "Asia/Jerusalem");
    for (const field of PURCHASE_FIELDS) expect(firstHolder, field).not.toHaveProperty(field);
    expect(firstHolder.opened_from).toBe(OPENED_FROM_OTHER_CUSTOMER);
    expect(JSON.stringify(firstHolder)).not.toContain(P);
    // P transfers it on to Y: Y never gets P's purchase; P, holding it no more, still does
    const later = { ...transferredCard, contact_id: "y", former_contact_ids: [X, P], holder_history: [...transferredCard.holder_history, { contact: P, until: "2026-10-20T08:00:00Z" }] };
    for (const field of PURCHASE_FIELDS) expect(cardForExport(later, [], ["y"], "Asia/Jerusalem"), field).not.toHaveProperty(field);
    expect(cardForExport(later, [], [P], "Asia/Jerusalem")).toMatchObject({ payment_id: "pay-P" });
  });

  // second review L3 and L4
  it("treats a card that was the payer's own from the start as ordinary for a later holder, and keeps staff fields out", () => {
    const P = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const base = {
      id: "c3",
      name: "כרטיסייה",
      entries_total: 10,
      created_at: "2026-10-01T08:00:00Z",
      payment_id: "pay-P",
      price_agorot: 40000,
      activated_by: "staff",
      created_by: "staff",
      activated_manually: false,
      activated_at: "2026-10-01T09:00:00Z",
      payer_contact_id: null,
      payer_holder_id: P,
    };
    // L3: the merge made it wholly P's (no mark); P transferred it to Y: Y sees an ordinary transferred card, no mark
    const ownThenTransferred = { ...base, contact_id: "y", opened_for_other_payer: false, former_contact_ids: [P], holder_history: [{ contact: P, until: "2026-10-20T08:00:00Z" }] };
    const y = cardForExport(ownThenTransferred, [], ["y"], "Asia/Jerusalem");
    expect(y).not.toHaveProperty("opened_from");
    for (const field of PURCHASE_FIELDS) expect(y, field).not.toHaveProperty(field);
    // and P, who held it from its opening, keeps all of the purchase, staff fields included (an ordinary own card)
    expect(cardForExport(ownThenTransferred, [], [P], "Asia/Jerusalem")).toMatchObject({ payment_id: "pay-P", activated_by: "staff", created_by: "staff" });
    // L4: X held it first; P's purchase is P's, without who opened or activated it
    const xFirst = { ...base, contact_id: P, opened_for_other_payer: true, former_contact_ids: [X], holder_history: [{ contact: X, until: "2026-10-03T08:00:00Z" }] };
    const p = cardForExport(xFirst, [], [P], "Asia/Jerusalem");
    expect(p).toMatchObject({ payment_id: "pay-P", price_agorot: 40000, activated_at: "2026-10-01T09:00:00Z" });
    for (const field of PURCHASE_STAFF_FIELDS) expect(p, field).not.toHaveProperty(field);
  });
});
