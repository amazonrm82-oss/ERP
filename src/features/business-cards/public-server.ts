import "server-only";

import { parseAttribution } from "@/features/intake/attribution";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import type { Json } from "@/lib/database.types";
import { clientIp, keyedIpHash as keyedHash } from "@/lib/keyed-ip-hash";
import { createServiceClient } from "@/lib/supabase/service";
import { buildVCard, vcardDisposition } from "@/lib/vcard";

import { publicCardFrom, type PublicCard } from "./public";

// BIZ-02: the public business card, in the approved pattern for secret-link pages (owner, 13 October 2026; hard
// rule 5): the server reads only through public.business_card_public() and sends the form only through
// public.business_card_submit() (security definer, service_role only), which check the token and answer only what the
// card shows; the form goes on to the existing intake_submit. No table is reached directly; no cookies, no visitor id.

const TOKEN = /^[0-9a-f]{32}$/;

// FXS-11: the sender's IP as a keyed hash (src/lib/keyed-ip-hash.ts); the database scopes it further per card
const keyedIpHash = (ip: string | null) => keyedHash(ip, "card");
// a human needs more than this to fill in the details
const MIN_FILL_MS = 2000;
const MAX_BODY_BYTES = 8 * 1024;

export type PublicCardState = PublicCard | "not-found" | "rate-limited" | "not-configured";

/** The card behind a token (a view: 60 per sender in 10 minutes). */
export async function getPublicCard(token: string, ip: string | null): Promise<PublicCardState> {
  if (!TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("business_card_public", { p_token: token, p_ip_hash: keyedIpHash(ip) });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`business_card_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return publicCardFrom(data) ?? "not-found";
}

const MESSAGES = {
  notFound: "הכרטיס לא נמצא או שאינו פעיל.",
  notConfigured: "הכרטיס אינו זמין כרגע.",
  badRequest: "לא הצלחנו לקרוא את הפרטים שנשלחו.",
  tooLarge: "הפרטים שנשלחו ארוכים מדי.",
  missing: "יש לכתוב שם ומספר טלפון או אימייל.",
  email: "כתובת האימייל אינה תקינה.",
  rateLimited: "נשלחו יותר מדי פניות בזמן קצר. נסו שוב בעוד כמה דקות.",
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;

export type CardReply = { ok: true } | { ok: false; message: string };

const json = (status: number, reply: CardReply) => Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

/** POST /api/forms/card/<token>: the "leave details" form, as JSON (the page's own script posts it). */
export async function handleCardSubmit(request: Request, token: string): Promise<Response> {
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
  // only what the card's form asks; anything else is dropped here and again in the database
  const payload = {
    full_name: text(body.full_name, 200),
    phone: text(body.phone, 40),
    email: text(body.email, 254),
    message: text(body.message, 2000),
    attribution: parseAttribution(body),
  };
  if (!payload.full_name || (!payload.phone && !payload.email)) return json(400, { ok: false, message: MESSAGES.missing });

  const { error } = await service.rpc("business_card_submit", {
    p_token: token,
    p_payload: payload as unknown as Json,
    p_ip_hash: keyedIpHash(clientIp(request.headers)),
    p_user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    p_is_spam: isSpam,
  });
  if (error) {
    if (error.code === "P0002") return json(404, { ok: false, message: MESSAGES.notFound });
    if (error.hint === "rate_limited") return json(429, { ok: false, message: MESSAGES.rateLimited });
    if (error.code === "22023") return json(400, { ok: false, message: /email/i.test(error.message) ? MESSAGES.email : MESSAGES.missing });
    console.error("business_card_submit failed", error.code, error.message);
    return json(500, { ok: false, message: MESSAGES.error });
  }
  // spam is answered like the rest
  return json(200, { ok: true });
}

/** GET /api/forms/card/<token>/vcard: the card as a contact file, with the shown fields only (a view of the card). */
export async function handleCardVCard(request: Request, token: string): Promise<Response> {
  const card = await getPublicCard(token, clientIp(request.headers));
  if (card === "rate-limited") return new Response(MESSAGES.rateLimited, { status: 429, headers: { "Cache-Control": "no-store" } });
  if (typeof card === "string") return new Response(MESSAGES.notFound, { status: 404, headers: { "Cache-Control": "no-store" } });
  const vcard = buildVCard({
    name: card.name,
    phone: card.phone,
    email: card.email,
    company: card.business,
    jobTitle: card.jobTitle,
    url: card.website,
  });
  return new Response(vcard, {
    status: 200,
    headers: { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": vcardDisposition(card.name), "Cache-Control": "no-store" },
  });
}
