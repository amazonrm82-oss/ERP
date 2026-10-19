import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

import {
  ACCEPT_WORDING_VERSION,
  DECISION_MESSAGES,
  decisionBodySchema,
  isDecisionStatus,
  publicVersionFingerprint,
  type DecisionBody,
  type DecisionStatus,
} from "./decision";
import {
  publicQuoteFrom,
  QUOTE_LINK_TOKEN,
  statusQuoteFrom,
  type PublicQuote,
  type StatusPublicQuote,
} from "./public";

// QUO-08: the customer's page of a sent quote, in the approved pattern for secret-link pages (owner, 8 October 2026;
// CLAUDE.md hard rule 5): the server reads only through public.quote_public() (security definer, service_role only),
// which checks the token and answers only what the page shows. No table is reached directly. No IP is used for viewing: the
// views are limited per link in the database. A decision (QUO-09, below) goes through public.quote_public_version() and public.quote_public_decide().

export type PublicQuoteState = PublicQuote | StatusPublicQuote | "not-found" | "rate-limited" | "not-configured";

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
  return statusQuoteFrom(data) ?? publicQuoteFrom(data) ?? "not-found";
}

// QUO-09 ---------------------------------------------------------------------
// The customer accepts and signs, or declines. Same pattern: the route calls only public.quote_public_decide() (security
// definer, service_role only), which checks the token, limits tries per link, decides once on the version the page shows
// and answers {status}. The full IP and browser go with the decision (owner, 18 October 2026: a signature is evidence).

const MAX_DECISION_BYTES = 350_000;

/**
 * The fingerprint of the version the page shows, read right after public.quote_public() through
 * public.quote_public_version() (service_role only; it does not count a view). Null when the page should offer no decision:
 * the quote is answered or closed, or the number differs from the one the page drew (a new version arrived in between).
 */
export async function getPublicQuoteFingerprint(token: string, shownNumber: string | null): Promise<string | null> {
  if (!QUOTE_LINK_TOKEN.test(token)) return null;
  const service = createServiceClient();
  if (!service) return null;
  const { data, error } = await service.rpc("quote_public_version", { p_token: token });
  if (error) {
    if (error.code !== "P0002") console.error("quote_public_version failed", error.code, error.message);
    return null;
  }
  return publicVersionFingerprint(data, shownNumber);
}

/** The sender's address from the proxy's headers (Vercel sets x-forwarded-for). */
function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0]?.trim() || headers.get("x-real-ip") || "").slice(0, 64) || null;
}

type DecisionReply = { ok: true; status: DecisionStatus; message: string } | { ok: false; status?: DecisionStatus; message: string };
const reply = (status: number, body: DecisionReply) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const NOT_FOUND = "ההצעה לא נמצאה, או שהקישור כבר לא בתוקף.";

/** POST /api/forms/quote/<token>/decide: the page's own script posts the decision as JSON. */
export async function handleQuoteDecision(request: Request, token: string): Promise<Response> {
  if (!QUOTE_LINK_TOKEN.test(token)) return reply(404, { ok: false, message: NOT_FOUND });
  const service = createServiceClient();
  if (!service) return reply(503, { ok: false, message: "ההצעה אינה זמינה כרגע." });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_DECISION_BYTES) return reply(413, { ok: false, message: DECISION_MESSAGES.invalid });
  let parsed: DecisionBody;
  try {
    const raw = await request.text();
    if (raw.length > MAX_DECISION_BYTES) return reply(413, { ok: false, message: DECISION_MESSAGES.invalid });
    const body = decisionBodySchema.safeParse(JSON.parse(raw));
    if (!body.success) return reply(400, { ok: false, status: "invalid", message: DECISION_MESSAGES.invalid });
    parsed = body.data;
  } catch {
    return reply(400, { ok: false, status: "invalid", message: DECISION_MESSAGES.invalid });
  }

  const accepted = parsed.decision === "accepted" ? parsed : null;
  const { data, error } = await service.rpc("quote_public_decide", {
    p_token: token,
    p_decision: parsed.decision,
    p_fingerprint: parsed.fingerprint,
    p_signer_name: accepted?.signerName ?? null,
    p_id_number: accepted?.idNumber || null,
    p_signature_kind: accepted?.signatureKind ?? null,
    p_signature_image: accepted?.signatureKind === "drawn" ? accepted.signatureImage : null,
    p_wording_version: accepted ? ACCEPT_WORDING_VERSION : null,
    p_agreed: accepted?.agreed ?? false,
    p_decline_reason: parsed.decision === "rejected" ? parsed.reason || null : null,
    p_ip: clientIp(request.headers),
    p_user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  });
  if (error) {
    if (error.code === "P0002") return reply(404, { ok: false, message: NOT_FOUND });
    console.error("quote_public_decide failed", error.code, error.message);
    return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  }
  const status = (data as { status?: unknown } | null)?.status;
  if (!isDecisionStatus(status)) return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  const done = status === "accepted" || status === "rejected";
  return reply(done ? 200 : status === "rate_limited" ? 429 : 409, { ok: done, status, message: DECISION_MESSAGES[status] });
}
