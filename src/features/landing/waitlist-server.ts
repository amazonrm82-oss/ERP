import "server-only";

import { publicSenderAddress } from "@/lib/ip-prefix";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { RATE_LIMITED_TEXT, rateLimitedJson } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { honeypotFilled, WAITLIST_CONSENT_VERSION, WAITLIST_HONEYPOT, WAITLIST_TEXTS } from "./waitlist";

/**
 * LND-13's anonymous write (CLAUDE.md hard rule 5, owner 13 October 2026): POST /api/forms/plan-notify. With the service key it
 * calls only public.landing_waitlist_submit() (email, plan, consent and its wording version, and the keyed IP hash of scope
 * `waitlist`, of which the database keeps only a bucket number). The honeypot is checked first: a hit is answered like a
 * success and never reaches the database (any non-empty value of any type counts). No cookie or visitor id. The visitor gets
 * the same answer whether the address was new or not. The sender is hashed by publicSenderAddress() (an IPv6 address by its
 * /64), as OPS-02 and PRK-02; without a hash (no hash secret set, or no client address) the request is refused with the
 * rate-limited answer and nothing is stored (fail closed). The database also caps stored rows for everyone (200 an hour,
 * 1,000 a day).
 */
const MAX_BODY = 4 * 1024;

type Reply = { ok: boolean; message: string; field?: string };

export async function handleWaitlist(request: Request): Promise<Response> {
  const respond = (status: number, reply: Reply) => Response.json(reply, { status, headers: { "cache-control": "no-store" } });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return respond(413, { ok: false, message: WAITLIST_TEXTS.error });
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return respond(413, { ok: false, message: WAITLIST_TEXTS.error });
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return respond(400, { ok: false, message: WAITLIST_TEXTS.error });
    body = parsed as Record<string, unknown>;
  } catch {
    return respond(400, { ok: false, message: WAITLIST_TEXTS.error });
  }
  // the honeypot: answered like a success, stored nowhere, told to no one
  if (honeypotFilled(body[WAITLIST_HONEYPOT])) return respond(200, { ok: true, message: WAITLIST_TEXTS.received });

  const ipHash = keyedIpHash(publicSenderAddress(clientIp(request.headers)), "waitlist");
  if (!ipHash) return rateLimitedJson({ ok: false, message: RATE_LIMITED_TEXT });

  const service = createServiceClient();
  if (!service) return respond(503, { ok: false, message: WAITLIST_TEXTS.error });
  const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
  const { data, error } = await service.rpc("landing_waitlist_submit", {
    p_email: str(body.email, 300),
    p_plan: str(body.plan, 40),
    p_consent: body.consent === true,
    p_wording_version: WAITLIST_CONSENT_VERSION,
    p_ip_hash: ipHash,
  });
  if (error) {
    await serverLog("error", "landing_waitlist.failed", { code: error.code });
    return respond(500, { ok: false, message: WAITLIST_TEXTS.error });
  }
  const answer = (data ?? {}) as { status?: string; field?: string; rate_limited?: boolean };
  if (answer.rate_limited) return rateLimitedJson({ ok: false, message: RATE_LIMITED_TEXT });
  if (answer.status === "received") return respond(200, { ok: true, message: WAITLIST_TEXTS.received });
  const field = answer.field === "email" || answer.field === "consent" || answer.field === "plan" ? answer.field : "email";
  return respond(400, { ok: false, message: WAITLIST_TEXTS[field], field });
}
