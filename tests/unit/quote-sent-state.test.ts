import { describe, expect, it } from "vitest";

import type { QuoteDocumentData } from "@/features/quotes/design-server";
import { quotePdfDocument } from "@/features/quotes/pdf";
import type { Quote, QuoteLine } from "@/features/quotes/queries";
import { linesAsSent, parseQuoteSentState, quoteAsSent, remakeRender, SENT_REMAKE_SUFFIX, sentStateDiffers, type QuoteSentState } from "@/features/quotes/sent-state";
import { formatMoney } from "@/lib/format";

// Owner's answer (175) ג, 9 November 2026: a PDF as sent made again renders the quote's state as sent (021190), whatever the
// customer later accepted; a quote without one (sent before 021190) keeps 021187's rule.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const wire = {
  vat_rate_bp: 1800,
  subtotal_agorot: 10000,
  discount_total_agorot: 0,
  net_total_agorot: 10000,
  vat_agorot: 1800,
  total_agorot: 11800,
  optional_lines: [{ id: B, selected: false }],
};

function line(id: string, extra: Partial<QuoteLine> = {}): QuoteLine {
  return {
    id,
    position: 0,
    kind: "item",
    productId: null,
    name: "שירות",
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
    bundleDisplay: null,
    bundleParts: [],
    recipientName: null,
    ...extra,
  } as QuoteLine;
}

// the quote as it is after the customer ticked the optional line (021117 recomputed its totals)
const accepted = {
  id: "q1",
  title: "הצעה",
  status: "accepted",
  numberDisplay: "Q-7",
  quoteDate: "2026-11-09",
  validUntil: null,
  pricesIncludeVat: false,
  noVatReason: null,
  noVatNote: null,
  bankDetails: null,
  notes: null,
  terms: null,
  vatRateBp: 1800,
  subtotalAgorot: 15000,
  discountTotalAgorot: 0,
  netTotalAgorot: 15000,
  vatAgorot: 2700,
  totalAgorot: 17700,
} as unknown as Quote;

const lines = [line(A), line(B, { position: 1, isOptional: true, optionalSelected: true, unitPriceAgorot: 5000, totalAgorot: 5000 })];

function data(quote: Quote, rows: QuoteLine[]): QuoteDocumentData {
  return {
    design: { headerText: null, footerText: null, showLogo: false, showBusinessDetails: false, showBankDetailsQuote: false, showBankDetailsOrder: false, showBankDetailsStatement: false, accentColor: null },
    color: null,
    logoUrl: null,
    business: { name: "העסק", taxId: null, address: null, phone: null, email: null },
    customer: null,
    quote,
    lines: rows,
    schedule: [],
  } as unknown as QuoteDocumentData;
}

describe("a quote's state as sent (owner (175) ג)", () => {
  it("reads the database's answer and refuses an unknown shape", () => {
    const state = parseQuoteSentState(wire)!;
    expect(state).toEqual({
      vatRateBp: 1800,
      subtotalAgorot: 10000,
      discountTotalAgorot: 0,
      netTotalAgorot: 10000,
      vatAgorot: 1800,
      totalAgorot: 11800,
      optionalLines: [{ id: B, selected: false }],
    });
    expect(parseQuoteSentState(null)).toBeNull();
    expect(parseQuoteSentState({ ...wire, total_agorot: "12.5" })).toBeNull();
    expect(parseQuoteSentState({ ...wire, optional_lines: [{ id: "x", selected: true }] })).toBeNull();
    expect(parseQuoteSentState({ ...wire, total_agorot: "11800" })?.totalAgorot).toBe(11800);
  });

  it("puts the sent amounts and selections back; lines the snapshot does not name keep theirs", () => {
    const state = parseQuoteSentState(wire) as QuoteSentState;
    const quote = quoteAsSent(accepted, state);
    expect([quote.subtotalAgorot, quote.netTotalAgorot, quote.vatAgorot, quote.totalAgorot]).toEqual([10000, 10000, 1800, 11800]);
    expect(quote.title).toBe(accepted.title);
    const sentLines = linesAsSent(lines, state);
    expect(sentLines.map((l) => l.optionalSelected)).toEqual([false, false]);
    expect(sentLines[0]).toBe(lines[0]);
    expect(linesAsSent(lines, { ...state, optionalLines: [] })).toEqual(lines);
  });

  it("chooses the state a PDF as sent is rendered from", () => {
    expect(remakeRender({ remake: false, hasSentState: true, acceptedChoiceChanged: true })).toEqual({ kind: "live" });
    expect(remakeRender({ remake: true, hasSentState: true, acceptedChoiceChanged: true })).toEqual({ kind: "sent" });
    expect(remakeRender({ remake: true, hasSentState: true, acceptedChoiceChanged: false })).toEqual({ kind: "sent" });
    // 021187's fallback for a quote sent before 021190
    expect(remakeRender({ remake: true, hasSentState: false, acceptedChoiceChanged: true })).toEqual({ kind: "accepted" });
    expect(remakeRender({ remake: true, hasSentState: false, acceptedChoiceChanged: false })).toEqual({ kind: "live" });
    expect(SENT_REMAKE_SUFFIX).toBe(", כפי שנשלח");
  });

  it("the PDF document made from the snapshot prints the sent total and the optional line as not included", () => {
    const state = parseQuoteSentState(wire) as QuoteSentState;
    const doc = quotePdfDocument(data(quoteAsSent(accepted, state), linesAsSent(lines, state)), null, { remadeNote: `נוצר מחדש${SENT_REMAKE_SUFFIX}` });
    const totals = doc.blocks.find((b) => b.kind === "totals");
    expect(totals && totals.kind === "totals" ? totals.rows.at(-1)?.value : null).toBe(formatMoney(11800));
    expect(totals && totals.kind === "totals" ? totals.notes : []).toContain("שורות רשות שלא סומנו אינן כלולות בסיכום.");
    expect(doc.footerNote).toBe("נוצר מחדש, כפי שנשלח");
    // the live accepted quote would print the accepted total
    const live = quotePdfDocument(data(accepted, lines), null);
    const liveTotals = live.blocks.find((b) => b.kind === "totals");
    expect(liveTotals && liveTotals.kind === "totals" ? liveTotals.rows.at(-1)?.value : null).toBe(formatMoney(17700));
  });
});

describe("the remake's \"as sent\" mark only when the state as sent differs from today (owner (176) ב)", () => {
  const state = parseQuoteSentState(wire) as QuoteSentState;
  const same = { vatRateBp: 1800, subtotalAgorot: 10000, discountTotalAgorot: 0, netTotalAgorot: 10000, vatAgorot: 1800, totalAgorot: 11800 };
  const sameLines = [line(A), line(B, { position: 1, isOptional: true, optionalSelected: false })];

  it("equal state and quote: no mark", () => {
    expect(sentStateDiffers(same, sameLines, state)).toBe(false);
    expect(sentStateDiffers(same, [], state)).toBe(false);
  });

  it("each of the rate and the five totals differing is a difference", () => {
    for (const key of Object.keys(same) as (keyof typeof same)[]) {
      expect(sentStateDiffers({ ...same, [key]: (same[key] ?? 0) + 1 }, sameLines, state)).toBe(true);
    }
    expect(sentStateDiffers({ ...same, vatRateBp: null }, sameLines, state)).toBe(true);
    expect(sentStateDiffers({ ...same, vatRateBp: null }, sameLines, { ...state, vatRateBp: null })).toBe(false);
  });

  it("an optional line's selection differing is a difference, even with equal totals", () => {
    const ticked = [line(A), line(B, { position: 1, isOptional: true, optionalSelected: true })];
    expect(sentStateDiffers(same, ticked, state)).toBe(true);
    // the accepted quote of this file: totals and selection differ
    expect(sentStateDiffers(accepted, lines, state)).toBe(true);
  });

  it("the order of the lines does not matter; a line the snapshot does not name is not judged", () => {
    expect(sentStateDiffers(same, [...sameLines].reverse(), state)).toBe(false);
    const two = { ...state, optionalLines: [{ id: B, selected: false }, { id: A, selected: true }] };
    const rows = [line(B, { optionalSelected: false }), line(A, { optionalSelected: true })];
    expect(sentStateDiffers(same, rows, two)).toBe(false);
    expect(sentStateDiffers(same, [...rows].reverse(), { ...two, optionalLines: [...two.optionalLines].reverse() })).toBe(false);
    expect(sentStateDiffers(same, [line(A, { optionalSelected: true })], state)).toBe(false);
  });
});
