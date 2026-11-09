// Owner's answer (175) ג, 9 November 2026: a quote sent after migration 021190 keeps its state as sent (the rate, the five
// totals and each optional line's selection; app.quote_sent_states, read through public.quote_sent_state). A PDF as sent made
// again later renders exactly that state; only a quote without one (sent before 021190) falls back to 021187's rule. Pure, so
// it is unit tested.

import { z } from "zod";

import type { Quote, QuoteLine } from "./queries";

const agorot = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number).pipe(z.number().int().safe());

const sentStateSchema = z.object({
  vat_rate_bp: z.number().int().nullable(),
  subtotal_agorot: agorot,
  discount_total_agorot: agorot,
  net_total_agorot: agorot,
  vat_agorot: agorot,
  total_agorot: agorot,
  optional_lines: z.array(z.object({ id: z.string().uuid(), selected: z.boolean() })).max(200),
});

export type QuoteSentState = {
  vatRateBp: number | null;
  subtotalAgorot: number;
  discountTotalAgorot: number;
  netTotalAgorot: number;
  vatAgorot: number;
  totalAgorot: number;
  optionalLines: { id: string; selected: boolean }[];
};

/** public.quote_sent_state's answer, or null (no snapshot, not permitted, or a shape we do not know: then nothing is assumed). */
export function parseQuoteSentState(data: unknown): QuoteSentState | null {
  if (data === null || data === undefined) return null;
  const parsed = sentStateSchema.safeParse(data);
  if (!parsed.success) return null;
  const s = parsed.data;
  return {
    vatRateBp: s.vat_rate_bp,
    subtotalAgorot: s.subtotal_agorot,
    discountTotalAgorot: s.discount_total_agorot,
    netTotalAgorot: s.net_total_agorot,
    vatAgorot: s.vat_agorot,
    totalAgorot: s.total_agorot,
    optionalLines: s.optional_lines,
  };
}

/** The quote with its amounts as sent (everything else on a sent quote is frozen at sending already). */
export function quoteAsSent(quote: Quote, state: QuoteSentState): Quote {
  return {
    ...quote,
    vatRateBp: state.vatRateBp,
    subtotalAgorot: state.subtotalAgorot,
    discountTotalAgorot: state.discountTotalAgorot,
    netTotalAgorot: state.netTotalAgorot,
    vatAgorot: state.vatAgorot,
    totalAgorot: state.totalAgorot,
  };
}

/** The lines with each optional line's selection as sent; a line the snapshot does not name keeps what it has. */
export function linesAsSent(lines: QuoteLine[], state: QuoteSentState): QuoteLine[] {
  const selected = new Map(state.optionalLines.map((line) => [line.id, line.selected]));
  return lines.map((line) => {
    const was = selected.get(line.id);
    return was === undefined || was === line.optionalSelected ? line : { ...line, optionalSelected: was };
  });
}

/** An accepted quote, or one cancelled after it was accepted (quote_cancel_accepted keeps the accepted choice's totals). */
export function wasAccepted(quote: Pick<Quote, "status" | "cancelledFrom">): boolean {
  return quote.status === "accepted" || quote.cancelledFrom === "accepted";
}

/** The line a PDF as sent made again from the snapshot adds to the remake footer. */
export const SENT_REMAKE_SUFFIX = ", כפי שנשלח";

export type RemakeRender = { kind: "sent" } | { kind: "accepted" } | { kind: "live" };

/**
 * Which state a PDF as sent is rendered from. A first PDF (no remake) is the live quote, which is still the sent state (it is
 * made only while the quote is sent or viewed). A remake renders the snapshot when the quote has one; without one, 021187's
 * rule: an accepted quote whose choice changed it is rendered as accepted, any other as it is now.
 */
export function remakeRender(options: { remake: boolean; hasSentState: boolean; acceptedChoiceChanged: boolean }): RemakeRender {
  if (!options.remake) return { kind: "live" };
  if (options.hasSentState) return { kind: "sent" };
  return options.acceptedChoiceChanged ? { kind: "accepted" } : { kind: "live" };
}
