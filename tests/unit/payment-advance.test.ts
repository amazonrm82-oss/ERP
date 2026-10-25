import { describe, expect, it } from "vitest";

import { advanceLine, advanceLinkValue, parseAdvance } from "@/features/payments/advance";

const ID = "6f0c3a5e-2b4d-4c1e-9a7b-1d2e3f4a5b6c";

describe("advance mark (PAY-03)", () => {
  it("reads the mark and the link; a link without the mark is dropped", () => {
    expect(parseAdvance({})).toEqual({ ok: true, columns: { is_advance: false, advance_quote_id: null, advance_order_id: null } });
    expect(parseAdvance({ is_advance: "on" })).toEqual({ ok: true, columns: { is_advance: true, advance_quote_id: null, advance_order_id: null } });
    expect(parseAdvance({ is_advance: "on", advance_link: advanceLinkValue({ kind: "order", id: ID }) })).toEqual({
      ok: true,
      columns: { is_advance: true, advance_quote_id: null, advance_order_id: ID },
    });
    expect(parseAdvance({ is_advance: "on", advance_link: `quote:${ID}` })).toEqual({ ok: true, columns: { is_advance: true, advance_quote_id: ID, advance_order_id: null } });
    expect(parseAdvance({ advance_link: `quote:${ID}` })).toEqual({ ok: true, columns: { is_advance: false, advance_quote_id: null, advance_order_id: null } });
    expect(parseAdvance({ is_advance: "on", advance_link: "deal:x" }).ok).toBe(false);
  });

  it("words the line under an advance", () => {
    expect(advanceLine({})).toBe("מקדמה");
    expect(advanceLine({ quoteNumber: "Q-7" })).toBe("מקדמה להצעה Q-7");
    expect(advanceLine({ orderNumber: "O-3", quoteNumber: "Q-7" })).toBe("מקדמה להזמנה O-3");
  });
});
