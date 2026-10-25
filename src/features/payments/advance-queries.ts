import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { AdvanceTarget } from "./advance";
import { moneyRowParents } from "./deal-contact";
import type { MoneySubject } from "./money-subject";

// PAY-03: what a new payment on this card may be an advance for, and the numbers of the quotes and orders advances name.
// Read with the user's session (RLS decides); the database checks the same customer again (payments_advance).

const LIMIT = 50;

/** The sent quotes and numbered orders of this card's deal or contact (not cancelled), newest first. */
export async function listAdvanceTargets(orgId: string, subject: MoneySubject): Promise<AdvanceTarget[]> {
  const supabase = await createClient();
  const parents = await moneyRowParents(supabase, orgId, subject);
  if ("error" in parents || "missing" in parents) return [];
  const on = [parents.deal_id ? `deal_id.eq.${parents.deal_id}` : null, parents.contact_id ? `contact_id.eq.${parents.contact_id}` : null].filter(Boolean).join(",");
  if (!on) return [];
  const [quotes, orders] = await Promise.all([
    supabase
      .from("quotes")
      .select("id, number_display, title")
      .eq("organization_id", orgId)
      .or(on)
      .not("status", "in", "(draft,cancelled)")
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("orders")
      .select("id, number_display")
      .eq("organization_id", orgId)
      .or(on)
      .not("status", "in", "(draft,cancelled)")
      .order("created_at", { ascending: false })
      .limit(LIMIT),
  ]);
  return [
    ...must(orders, "advance orders").map((o): AdvanceTarget => ({ kind: "order", id: o.id, label: `הזמנה ${o.number_display ?? ""}`.trim() })),
    ...must(quotes, "advance quotes").map((q): AdvanceTarget => ({ kind: "quote", id: q.id, label: `הצעה ${q.number_display ?? ""} · ${q.title}`.trim() })),
  ];
}

/** The numbers of the quotes and orders these advances name (the ones the user reads). */
export async function advanceLinkNumbers(orgId: string, links: { quoteId: string | null; orderId: string | null }[]): Promise<{ quotes: Map<string, string>; orders: Map<string, string> }> {
  const quoteIds = [...new Set(links.flatMap((l) => (l.quoteId ? [l.quoteId] : [])))];
  const orderIds = [...new Set(links.flatMap((l) => (l.orderId ? [l.orderId] : [])))];
  const supabase = await createClient();
  const [quotes, orders] = await Promise.all([
    quoteIds.length > 0 ? supabase.from("quotes").select("id, number_display").eq("organization_id", orgId).in("id", quoteIds) : null,
    orderIds.length > 0 ? supabase.from("orders").select("id, number_display").eq("organization_id", orgId).in("id", orderIds) : null,
  ]);
  return {
    quotes: new Map(quotes ? must(quotes, "advance quote numbers").flatMap((q) => (q.number_display ? [[q.id, q.number_display] as const] : [])) : []),
    orders: new Map(orders ? must(orders, "advance order numbers").flatMap((o) => (o.number_display ? [[o.id, o.number_display] as const] : [])) : []),
  };
}
