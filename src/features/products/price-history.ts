import type { Json } from "@/lib/database.types";

import { productPriceText } from "./display";
import { VAT_KINDS, type VatKind } from "./schema";

// PRD-07: price changes of a product, rebuilt from its audit entries (app.audit_row stores
// {field: {old, new}} for every changed column). A change touches the price, the "including VAT"
// mode or the VAT kind; the full price before and after is rebuilt by walking back from the
// product as it is now, newest entry first, so an entry that changed only one of the three still
// shows the whole price.

export const PRICE_FIELDS = ["price_agorot", "price_includes_vat", "vat_kind"] as const;

export type PriceState = { priceAgorot: number; priceIncludesVat: boolean; vatKind: VatKind };
export type PriceAuditEntry = { id: number; createdAt: string; actorName: string | null; changes: Json };
export type PriceChange = { id: number; createdAt: string; actorName: string | null; before: string; after: string };

function pair(changes: Json, field: string): { old: Json } | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = changes[field];
  if (!value || typeof value !== "object" || Array.isArray(value) || !("old" in value)) return null;
  return { old: value.old ?? null };
}

function oldState(state: PriceState, changes: Json): PriceState {
  const before = { ...state };
  const price = pair(changes, "price_agorot");
  if (price && (typeof price.old === "number" || typeof price.old === "string") && Number.isFinite(Number(price.old))) {
    before.priceAgorot = Number(price.old);
  }
  const mode = pair(changes, "price_includes_vat");
  if (mode && typeof mode.old === "boolean") before.priceIncludesVat = mode.old;
  const kind = pair(changes, "vat_kind");
  if (kind && typeof kind.old === "string" && (VAT_KINDS as readonly string[]).includes(kind.old)) before.vatKind = kind.old as VatKind;
  return before;
}

/** Entries newest first, the product as it is now: the price changes, newest first, with the price before and after. */
export function priceHistory(current: PriceState, entries: PriceAuditEntry[]): PriceChange[] {
  let state = current;
  const out: PriceChange[] = [];
  for (const entry of entries) {
    const before = oldState(state, entry.changes);
    const beforeText = productPriceText(before);
    const afterText = productPriceText(state);
    // an erased entry or one that changed nothing visible is left out
    if (beforeText !== afterText) {
      out.push({ id: entry.id, createdAt: entry.createdAt, actorName: entry.actorName, before: beforeText, after: afterText });
    }
    state = before;
  }
  return out;
}
