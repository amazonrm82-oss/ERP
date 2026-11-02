import "server-only";

import { headers } from "next/headers";

import { publicSenderAddress } from "@/lib/ip-prefix";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { isMarkedNotFound } from "@/lib/public-not-found";
import { RATE_LIMITED_TEXT, rateLimitedJson, rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

// OPS-02, owner's answers (40) ב and (42) ד (2 November 2026): the secret-link pages (quote, order, statement, the personal
// booking-manage link) and their routes share ONE limit per sender against guessing links: 120 "not found" answers in 10
// minutes across all of them. Before its own function a path asks whether the sender is already over (a read only:
// public.public_sender_check); after its function answered "not found" the server records one miss
// (public.public_sender_miss, one upsert). A real customer's views are never counted here; their pages keep their own
// per-link and per-sender limits. Both functions are service_role only and keep bucket numbers, never the hash. The sender is
// the keyed IP hash of FXS-11 with the scope "public" (one value per visitor on every page; an IPv6 visitor counted by its /64). No secret or no address = no
// hash = nothing checked or counted (fail open, as every other public limit); a failed call is logged and lets the request
// through. Which paths take it, and why the others do not: tests/unit/public-rate-limits.test.ts.

/** The sender: the keyed hash of the address, an IPv6 one reduced to its /64 (src/lib/ip-prefix.ts; this scope only). */
function senderOf(requestHeaders: Headers): string | null {
  return keyedIpHash(publicSenderAddress(clientIp(requestHeaders)), "public");
}

/** true = go on; false = this sender already had too many "not found" answers in the window. */
export async function publicSenderAllowed(requestHeaders: Headers): Promise<boolean> {
  const sender = senderOf(requestHeaders);
  if (!sender) return true;
  const service = createServiceClient();
  if (!service) return true;
  const { data, error } = await service.rpc("public_sender_check", { p_sender: sender });
  if (error) {
    console.error("[OPS-02] public_sender_check failed", error.code);
    return true;
  }
  return data !== false;
}

/** Records one "not found" answer for this sender. */
export async function recordPublicMiss(requestHeaders: Headers): Promise<void> {
  const sender = senderOf(requestHeaders);
  if (!sender) return;
  const service = createServiceClient();
  if (!service) return;
  const { error } = await service.rpc("public_sender_miss", { p_sender: sender });
  if (error) console.error("[OPS-02] public_sender_miss failed", error.code);
}

/**
 * A page's guard: checks the sender first, runs the page's own read, and records a miss when it answered "not-found". Called
 * inside the page's cache()-wrapped loader (WAB-05: the page and its generateMetadata share it), so one view counts once.
 */
export async function guardPublicPage<T>(read: () => Promise<T>): Promise<T | "rate-limited"> {
  const requestHeaders = await headers();
  if (!(await publicSenderAllowed(requestHeaders))) return "rate-limited";
  const result = await read();
  if (result === "not-found") await recordPublicMiss(requestHeaders);
  return result;
}

/**
 * A route's guard: checks the sender first (refused = the shared 429, JSON with `body` or plain text, with the route's own
 * headers), runs the handler, and records a miss when the handler marked its answer as "not found" (src/lib/public-not-found.ts).
 */
export async function guardPublicRoute(
  request: Request,
  reply: "json" | "text",
  handler: () => Promise<Response>,
  options: { body?: object; headers?: Record<string, string> } = {},
): Promise<Response> {
  if (!(await publicSenderAllowed(request.headers))) {
    return reply === "json"
      ? rateLimitedJson(options.body ?? { ok: false, message: RATE_LIMITED_TEXT }, { headers: options.headers })
      : rateLimitedText(RATE_LIMITED_TEXT, { headers: options.headers });
  }
  const response = await handler();
  if (isMarkedNotFound(response)) await recordPublicMiss(request.headers);
  return response;
}
