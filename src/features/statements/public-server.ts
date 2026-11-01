import "server-only";

import { keyedIpHash } from "@/lib/keyed-ip-hash";
import { createServiceClient } from "@/lib/supabase/service";

import { publicStatementFrom, STATEMENT_LINK_TOKEN, type PublicStatement } from "./public";

// BAL-04 (approved pattern for public secret-link pages, owner 8 October 2026; CLAUDE.md hard rule 5): the customer's
// statement page reads only through public.statement_public() (security definer, service_role only), which checks the token
// and answers only what the page shows. No table is reached directly; no cookies, no visitor id. The sender's IP reaches the
// database only as the keyed hash of FXS-11 (scope "statement"), for the view limit.

export type PublicStatementState = PublicStatement | "not-found" | "rate-limited" | "not-configured";

/** The statement behind a customer's link (a view: 120 per link and 60 per sender in 10 minutes). */
export async function getPublicStatement(token: string, ip: string | null): Promise<PublicStatementState> {
  if (!STATEMENT_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("statement_public", { p_token: token, p_ip_hash: keyedIpHash(ip, "statement") });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`statement_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return publicStatementFrom(data) ?? "not-found";
}
