import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/database.types";

// PKG-01 with GAP-08: a quick sale of a punch card opens the customer's card with the sale's payments ("נפתחת כשנרשם
// תשלום"). The sale itself is one transaction (public.quick_sale); the cards are opened right after it with the user's
// session through public.punch_card_open_for_sale. A failure never undoes the sale: every unit not opened is counted as
// failed (review finding 3), the screen says so, and the card can be opened from the contact's card.

// Review finding 3: a punch card is sold in whole units, at most 20 a line; refused before the sale
export const PUNCH_SALE_MAX_UNITS = 20;
export const punchSaleQuantitySchema = z
  .number()
  .int({ error: "כרטיסייה נמכרת ביחידות שלמות." })
  .min(1, { error: "כרטיסייה נמכרת ביחידות שלמות." })
  .max(PUNCH_SALE_MAX_UNITS, { error: `אפשר למכור עד ${PUNCH_SALE_MAX_UNITS} כרטיסיות בשורה אחת.` });

/** The first problem with the sale's punch card lines, or null. */
export function punchSaleQuantityProblem(lines: { productId: string; quantity: number }[], punchProductIds: ReadonlySet<string>): string | null {
  for (const line of lines) {
    if (!punchProductIds.has(line.productId)) continue;
    const parsed = punchSaleQuantitySchema.safeParse(line.quantity);
    if (!parsed.success) return parsed.error.issues[0].message;
  }
  return null;
}

/** The ids among `productIds` that are punch card products (read with the user's session). Throws on a read error. */
export async function punchProductIdsOf(supabase: SupabaseClient<Database>, orgId: string, productIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase.from("products").select("id").eq("organization_id", orgId).eq("kind", "punch_card").in("id", ids);
  if (error) throw new Error("punch card products");
  return new Set((data ?? []).map((p) => p.id));
}

/**
 * Opens the sale's cards through public.punch_card_open_for_sale (second review, finding 6): at the price the sale charged
 * for each line, covered by the sale's counted payments together (a cheque series). Every unit not opened counts as failed,
 * a read or call error included, so the screen always says when cards were not opened.
 */
export async function openPunchCardsForSale(
  supabase: SupabaseClient<Database>,
  orgId: string,
  sale: { dealId: string },
  lines: { productId: string; quantity: number }[],
  punchProductIds: ReadonlySet<string>,
): Promise<{ opened: number; failed: number }> {
  const units = lines
    .filter((line) => punchProductIds.has(line.productId))
    .reduce((sum, line) => sum + Math.max(1, Math.min(PUNCH_SALE_MAX_UNITS, Math.floor(line.quantity))), 0);
  if (units === 0) return { opened: 0, failed: 0 };
  const { data, error } = await supabase.rpc("punch_card_open_for_sale", { p_org: orgId, p_deal: sale.dealId });
  const answer = data as { opened?: unknown } | null;
  if (error || !answer || typeof answer.opened !== "number") return { opened: 0, failed: units };
  const opened = Math.min(units, answer.opened);
  return { opened, failed: units - opened };
}

/** The line added to "המכירה נרשמה." */
export function punchSaleText(result: { opened: number; failed: number }): string {
  const parts: string[] = [];
  if (result.opened > 0) parts.push(result.opened === 1 ? "נפתחה כרטיסייה ללקוח." : `נפתחו ${result.opened} כרטיסיות ללקוח.`);
  if (result.failed > 0)
    parts.push(result.failed === 1 ? "כרטיסייה אחת לא נפתחה. אפשר לפתוח אותה מכרטיס הלקוח." : `${result.failed} כרטיסיות לא נפתחו. אפשר לפתוח אותן מכרטיס הלקוח.`);
  return parts.join(" ");
}
