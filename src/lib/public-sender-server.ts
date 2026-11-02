import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { RATE_LIMITED_TEXT, rateLimitedJson, rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

// OPS-02, owner's answer (40) ב (2 November 2026): every public page and route that reads the database by a token first counts
// the request against ONE limit per sender across all public pages together (120 in 10 minutes), BEFORE the token is looked
// up, so guessing links costs the guesser. The count lives in the database (public.public_sender_take, service_role only,
// 65,536 reused buckets, no hash kept), so it holds across every server instance. The sender is the keyed IP hash of FXS-11
// with the scope "public" (one value per visitor on every page). No secret or no address = no hash = not counted (fail open,
// as every other public limit), and a failed call is logged and lets the request through: this limit is a brake on guessing,
// each page's own limits still stand behind it. The inventory of which paths take it is tests/unit/public-rate-limits.test.ts.

/** true = go on; false = this sender made too many public requests in the window. */
export async function takePublicRequest(requestHeaders: Headers): Promise<boolean> {
  const sender = keyedIpHash(clientIp(requestHeaders), "public");
  if (!sender) return true;
  const service = createServiceClient();
  if (!service) return true;
  const { data, error } = await service.rpc("public_sender_take", { p_sender: sender });
  if (error) {
    console.error("[OPS-02] public_sender_take failed", error.code);
    return true;
  }
  return data !== false;
}

/**
 * A page's take, once per request: React's cache() of the request scope, so the page and its generateMetadata (which share
 * one loader, WAB-05) and any second loader of the same request count one view.
 */
export const takePublicPageView = cache(async (): Promise<boolean> => takePublicRequest(await headers()));

/**
 * A route's take: null = go on, else the shared 429: JSON (`body`, default {ok: false, message}) or plain text, with the
 * route's own extra headers (CORS, Referrer-Policy).
 */
export async function refusePublicRequest(
  request: Request,
  reply: "json" | "text",
  options: { body?: object; headers?: Record<string, string> } = {},
): Promise<Response | null> {
  if (await takePublicRequest(request.headers)) return null;
  return reply === "json"
    ? rateLimitedJson(options.body ?? { ok: false, message: RATE_LIMITED_TEXT }, { headers: options.headers })
    : rateLimitedText(RATE_LIMITED_TEXT, { headers: options.headers });
}
