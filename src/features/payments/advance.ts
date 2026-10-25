import { z } from "zod";

// PAY-03 (owner, 25 October 2026, answer 3): a payment may be marked "מקדמה" and, optionally, linked to one sent quote or
// numbered order of the same customer. The database holds the rules (trigger payments_advance, hint payment:advance_link);
// this file reads the form and words the mark. Pure, unit tested.

export const ADVANCE_FIELD_NAMES = ["is_advance", "advance_link"] as const;

export type AdvanceTarget = { kind: "quote" | "order"; id: string; label: string };
export type AdvanceColumns = { is_advance: boolean; advance_quote_id: string | null; advance_order_id: string | null };

const linkSchema = z.union([
  z.literal(""),
  z.string().regex(/^(quote|order):[0-9a-f-]{36}$/i, { error: "יש לבחור הצעה או הזמנה מהרשימה." }),
]);

/** The value of one target in the form's select. */
export function advanceLinkValue(target: Pick<AdvanceTarget, "kind" | "id">): string {
  return `${target.kind}:${target.id}`;
}

/**
 * The mark and the link a form sends: "is_advance" (a checkbox) and "advance_link" ("" or "quote:<id>" / "order:<id>").
 * A link without the mark is dropped (the database refuses it: payments_advance_shape).
 */
export function parseAdvance(values: Partial<Record<string, unknown>>): { ok: true; columns: AdvanceColumns } | { ok: false; message: string } {
  const isAdvance = values.is_advance === "on";
  const link = linkSchema.safeParse(typeof values.advance_link === "string" ? values.advance_link.trim() : "");
  if (!link.success) return { ok: false, message: link.error.issues[0]?.message ?? "יש לבחור הצעה או הזמנה מהרשימה." };
  if (!isAdvance || link.data === "") return { ok: true, columns: { is_advance: isAdvance, advance_quote_id: null, advance_order_id: null } };
  const [kind, id] = link.data.split(":") as ["quote" | "order", string];
  return { ok: true, columns: { is_advance: true, advance_quote_id: kind === "quote" ? id : null, advance_order_id: kind === "order" ? id : null } };
}

/** The line under a payment that is an advance. */
export function advanceLine(link: { quoteNumber?: string | null; orderNumber?: string | null }): string {
  if (link.orderNumber) return `מקדמה להזמנה ${link.orderNumber}`;
  if (link.quoteNumber) return `מקדמה להצעה ${link.quoteNumber}`;
  return "מקדמה";
}
