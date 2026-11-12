import "server-only";

import { parseAttribution } from "@/features/intake/attribution";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import type { Json } from "@/lib/database.types";
import { clientIp, keyedIpHash as keyedHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { RATE_LIMITED_TEXT, rateLimitedJson } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { publicBusinessPageFrom, type PublicBusinessPage } from "./public";

// BIZ-01: the public business page, in the approved pattern for secret-link pages (owner, 11 November 2026, answer (271) ב;
// hard rule 5): the server reads only through public.business_page_public() and sends the contact form only through
// public.business_page_submit() (security definer, service_role only), which check the token and answer only public fields;
// the form goes on to the existing intake_submit. No table is reached directly; no cookies, no visitor id.

const TOKEN = /^[0-9a-f]{32}$/;

// FXS-11: the sender's IP as a keyed hash (src/lib/keyed-ip-hash.ts); the database scopes it further per page
const keyedIpHash = (ip: string | null) => keyedHash(ip, "bizpage");
// a human needs more than this to fill in the details
const MIN_FILL_MS = 2000;
const MAX_BODY_BYTES = 8 * 1024;

export type PublicBusinessPageState = PublicBusinessPage | "not-found" | "rate-limited" | "not-configured";

/** The page behind a token (a view: 60 per sender in 10 minutes). */
export async function getPublicBusinessPage(token: string, ip: string | null): Promise<PublicBusinessPageState> {
  if (!TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("business_page_public", { p_token: token, p_ip_hash: keyedIpHash(ip) });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`business_page_public failed: ${error.code}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return publicBusinessPageFrom(data) ?? "not-found";
}

const MESSAGES = {
  notFound: "הדף לא נמצא או שאינו פעיל.",
  notConfigured: "הדף אינו זמין כרגע.",
  badRequest: "לא הצלחנו לקרוא את הפרטים שנשלחו.",
  tooLarge: "הפרטים שנשלחו ארוכים מדי.",
  missing: "יש לכתוב שם ומספר טלפון או אימייל.",
  email: "כתובת האימייל אינה תקינה.",
  rateLimited: RATE_LIMITED_TEXT,
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;

export type BusinessPageReply = { ok: true } | { ok: false; message: string };

const json = (status: number, reply: BusinessPageReply) => Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

/** POST /api/forms/biz/<token>: the contact form, as JSON (the page's own script posts it). */
export async function handleBusinessPageSubmit(request: Request, token: string): Promise<Response> {
  if (!TOKEN.test(token)) return json(404, { ok: false, message: MESSAGES.notFound });
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
  const isSpam = text(body[HONEYPOT_FIELD], 200) !== null || (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < MIN_FILL_MS);
  // only what the page's form asks; anything else is dropped here and again in the database
  const payload = {
    full_name: text(body.full_name, 200),
    phone: text(body.phone, 40),
    email: text(body.email, 254),
    message: text(body.message, 2000),
    attribution: parseAttribution(body),
  };
  if (!payload.full_name || (!payload.phone && !payload.email)) return json(400, { ok: false, message: MESSAGES.missing });

  const { error } = await service.rpc("business_page_submit", {
    p_token: token,
    p_payload: payload as unknown as Json,
    p_ip_hash: keyedIpHash(clientIp(request.headers)),
    p_user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    p_is_spam: isSpam,
  });
  if (error) {
    if (error.code === "P0002") return json(404, { ok: false, message: MESSAGES.notFound });
    if (error.hint === "rate_limited") return rateLimitedJson({ ok: false, message: MESSAGES.rateLimited });
    if (error.code === "22023") return json(400, { ok: false, message: /email/i.test(error.message) ? MESSAGES.email : MESSAGES.missing });
    // intake_submit's own refusal of the business (e.g. org:read_only when it stops taking leads between the page's check and
    // the submit): the same neutral answer as a page that is not available, never a 500
    if (error.code === "P0001") return json(503, { ok: false, message: MESSAGES.notConfigured });
    await serverLog("error", "business_page.submit_failed", { code: error.code, error: error.message });
    return json(500, { ok: false, message: MESSAGES.error });
  }
  // spam is answered like the rest
  return json(200, { ok: true });
}
