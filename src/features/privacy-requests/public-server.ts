import "server-only";

import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import type { Json } from "@/lib/database.types";
import { publicSenderAddress } from "@/lib/ip-prefix";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { RATE_LIMITED_TEXT, rateLimitedJson } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { PRIVACY_LINK_TOKEN, privacyPageFrom, publicRequestSchema, type PrivacyPage } from "./model";
import { serverLog } from "@/lib/log-server";

// PRK-02: the public privacy-request page, in the approved pattern (owner, 26 October 2026, hard rule 5 wave 3 use (3)): the
// page reads only through public.privacy_request_page() (the business's display name and brand) and the form sends only
// through public.privacy_request_submit() (security definer, service_role only), which check the token, count the sender and
// store only type, name, one contact channel and text. The answer never depends on whether the business holds anything
// about the person. No table is reached directly; no cookies, no visitor id.

// FXS-11: the sender's IP as a keyed hash, an IPv6 visitor by its /64 (as OPS-02: one person holds a whole /64 and could rotate
// inside it); the database scopes it again per business and keeps only a bucket number
const senderHash = (ip: string | null) => keyedIpHash(publicSenderAddress(ip), "privacy");
// a human needs more than this to fill in the form
const MIN_FILL_MS = 2000;
const MAX_BODY_BYTES = 8 * 1024;

export type PrivacyPageState = PrivacyPage | "not-found" | "rate-limited" | "not-configured";

/** The page behind a token (a view: 60 per sender, then 300 per link, in 10 minutes). */
export async function getPrivacyPage(token: string, ip: string | null): Promise<PrivacyPageState> {
  if (!PRIVACY_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("privacy_request_page", { p_token: token, p_ip_hash: senderHash(ip) });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`privacy_request_page failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return privacyPageFrom(data) ?? "not-found";
}

const MESSAGES = {
  notFound: "הדף לא נמצא או שאינו פעיל.",
  notConfigured: "הדף אינו זמין כרגע.",
  badRequest: "לא הצלחנו לקרוא את הפרטים שנשלחו.",
  tooLarge: "הפרטים שנשלחו ארוכים מדי.",
  invalid: "יש לתקן את הפרטים ולשלוח שוב.",
  rateLimited: RATE_LIMITED_TEXT,
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;

export type PrivacyReply = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

const json = (status: number, reply: PrivacyReply) => Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });

/** POST /api/forms/privacy/<token>: the request, as JSON (the page's own script posts it). */
export async function handlePrivacySubmit(request: Request, token: string): Promise<Response> {
  if (!PRIVACY_LINK_TOKEN.test(token)) return json(404, { ok: false, message: MESSAGES.notFound });
  const service = createServiceClient();
  if (!service) return json(503, { ok: false, message: MESSAGES.notConfigured });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json(413, { ok: false, message: MESSAGES.tooLarge });
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, message: MESSAGES.tooLarge });
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, { ok: false, message: MESSAGES.badRequest });
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, message: MESSAGES.badRequest });
  }

  const startedAt = Number(body[STARTED_AT_FIELD]);
  const honeypot = typeof body[HONEYPOT_FIELD] === "string" && (body[HONEYPOT_FIELD] as string).trim() !== "";
  const isSpam = honeypot || (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < MIN_FILL_MS);
  // only the four things the page asks; anything else is dropped here, and again in the database
  const parsed = publicRequestSchema.safeParse({
    request_type: body.request_type,
    name: body.name,
    contact_kind: body.contact_kind,
    contact_value: body.contact_value,
    details: typeof body.details === "string" ? body.details : undefined,
  });
  if (!parsed.success && !isSpam) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "_form");
      if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
    }
    return json(400, { ok: false, message: MESSAGES.invalid, fieldErrors });
  }
  const payload = parsed.success ? parsed.data : {};

  const { data, error } = await service.rpc("privacy_request_submit", {
    p_token: token,
    p_payload: payload as unknown as Json,
    p_ip_hash: senderHash(clientIp(request.headers)),
    p_is_spam: isSpam,
  });
  if (error) {
    if (error.code === "P0002") return json(404, { ok: false, message: MESSAGES.notFound });
    if (error.code === "22023") return json(400, { ok: false, message: MESSAGES.invalid });
    await serverLog("error", "privacy_request.submit_failed", { code: error.code });
    return json(500, { ok: false, message: MESSAGES.error });
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return rateLimitedJson({ ok: false, message: MESSAGES.rateLimited });
  }
  // a honeypot hit is answered like the rest
  return json(200, { ok: true });
}
