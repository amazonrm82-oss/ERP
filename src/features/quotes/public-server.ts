import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

import { publicQuoteFrom, QUOTE_LINK_TOKEN, type PublicQuote } from "./public";

// QUO-08: the customer's page of a sent quote, in the approved pattern for secret-link pages (owner, 8 October 2026;
// CLAUDE.md hard rule 5): the server reads only through public.quote_public() (security definer, service_role only),
// which checks the token and answers only what the page shows. No table is reached directly. No IP is used: the views
// are limited per link in the database.

export type PublicQuoteState = PublicQuote | "not-found" | "rate-limited" | "not-configured";

/** The quote behind a customer's link. */
export async function getPublicQuote(token: string): Promise<PublicQuoteState> {
  if (!QUOTE_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("quote_public", { p_token: token });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`quote_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return publicQuoteFrom(data) ?? "not-found";
}
