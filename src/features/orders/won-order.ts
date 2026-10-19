import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import type { WonOrderResult } from "./won";

type Client = SupabaseClient<Database>;


/**
 * DEAL-04 wave 2, "what next" in the close window: an order for the deal that was just won, with the user's session.
 * From the deal's accepted quote when it has one (the window's own quote, else its newest accepted original), so the
 * lines and prices are as the customer accepted (ORD-01, owner's answer 2); else from the deal's own lines (answer 4).
 * The database decides everything else (rights, the plan, one order per quote, a deal with no lines).
 */
export async function createOrderForWonDeal(supabase: Client, orgId: string, dealId: string, quoteId?: string): Promise<WonOrderResult> {
  let fromQuote = quoteId ?? null;
  if (!fromQuote) {
    const { data, error } = await supabase
      .from("quotes")
      .select("id")
      .eq("organization_id", orgId)
      .eq("deal_id", dealId)
      .eq("status", "accepted")
      .is("addendum_of", null)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(1);
    if (error) return { ok: false, message: dbErrorMessage(error) };
    fromQuote = data[0]?.id ?? null;
  }
  const { data, error } = fromQuote
    ? await supabase.rpc("order_from_quote", { p_org: orgId, p_quote: fromQuote })
    : await supabase.rpc("order_from_deal", { p_org: orgId, p_deal: dealId });
  if (error) return { ok: false, message: dbErrorMessage(error) };
  if (typeof data !== "string") return { ok: false, message: dbErrorMessage(null) };
  const { data: order, error: readError } = await supabase.from("orders").select("number_display").eq("organization_id", orgId).eq("id", data).maybeSingle();
  if (readError) return { ok: false, message: dbErrorMessage(readError) };
  return { ok: true, orderId: data, numberDisplay: order?.number_display ?? null };
}

/** Whether the deal already has an order that is not cancelled (the window then offers none). */
export async function dealHasOrder(supabase: Client, orgId: string, dealId: string): Promise<{ has: boolean } | { error: { message: string; code?: string } }> {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("deal_id", dealId)
    .neq("status", "cancelled");
  if (error) return { error };
  return { has: (count ?? 0) > 0 };
}
