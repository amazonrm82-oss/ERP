import "server-only";

import { after } from "next/server";

import { clientIp as senderIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { rateLimitedJson } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import {
  ACCEPT_WORDING_VERSION,
  DECISION_MESSAGES,
  decisionBodySchema,
  isDecisionStatus,
  isQuestionStatus,
  publicVersionFingerprint,
  publicVersionPdfAsSent,
  QUESTION_MESSAGES,
  questionBodySchema,
  type DecisionBody,
  type DecisionStatus,
  type QuestionStatus,
} from "./decision";
import {
  publicQuoteFrom,
  QUOTE_LINK_TOKEN,
  statusQuoteFrom,
  type PublicQuote,
  type StatusPublicQuote,
} from "./public";
import { signaturePng } from "./signed-pdf";
import { storeSignedQuotePdfForCustomer } from "./signed-pdf-server";

// QUO-08: the customer's page of a sent quote, in the approved pattern for secret-link pages (owner, 8 October 2026;
// CLAUDE.md hard rule 5): the server reads only through public.quote_public() (security definer, service_role only),
// which checks the token and answers only what the page shows. No table is reached directly. Views are limited per link and,
// since OPS-02 (owner (41) ב), per sender (the keyed IP hash in the x-crm-sender header) in the database. A decision (QUO-09, below) goes through public.quote_public_version() and public.quote_public_decide().

export type PublicQuoteState = PublicQuote | StatusPublicQuote | "not-found" | "rate-limited" | "not-configured";

/** The header that hands the sender's keyed IP hash to public.quote_public (app.public_sender_header, OPS-02). */
const SENDER_HEADER = "x-crm-sender";

/**
 * The quote behind a customer's link. `ip` is the visitor's address: the view counts against the sender's limit of 60 in 10
 * minutes (OPS-02, owner's answer (41) ב), as the keyed IP hash with FXS-11 scope "quote" in the x-crm-sender header (the
 * database scopes it to the quote); without an address or the secret no hash is sent and only the link's limit applies.
 */
export async function getPublicQuote(token: string, ip: string | null = null): Promise<PublicQuoteState> {
  if (!QUOTE_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const sender = keyedIpHash(ip, "quote");
  const call = service.rpc("quote_public", { p_token: token });
  const { data, error } = await (sender ? call.setHeader(SENDER_HEADER, sender) : call);
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
// The customer accepts and signs, or declines. Same pattern: the route calls only public.quote_public_answer() (QUO-08: the
// answer of public.quote_public_decide() with the customer's choice of optional lines; security
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

/**
 * QUO-08 (interim): whether the stored PDF of the accepted quote on screen is the quote as sent, not as accepted (the
 * customer's choice of optional lines changed it). Read through public.quote_public_version, which counts no view.
 */
export async function getPublicQuotePdfAsSent(token: string, shownNumber: string | null): Promise<boolean> {
  if (!QUOTE_LINK_TOKEN.test(token)) return false;
  const service = createServiceClient();
  if (!service) return false;
  const { data, error } = await service.rpc("quote_public_version", { p_token: token });
  if (error) {
    if (error.code !== "P0002") console.error("quote_public_version failed", error.code, error.message);
    return false;
  }
  return publicVersionPdfAsSent(data, shownNumber);
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
  // QUO-09 review (medium): a drawn signature must be a PNG whose header declares a signature's size (no "PNG bomb"); checked
  // here, before the database, because the signed PDF is rendered from it
  if (accepted?.signatureKind === "drawn" && (!accepted.signatureImage || signaturePng(accepted.signatureImage) === null)) {
    return reply(400, { ok: false, status: "invalid", message: DECISION_MESSAGES.invalid });
  }
  const { data, error } = await service.rpc("quote_public_answer", {
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
    // QUO-08: the ticked optional lines and the total shown, both or neither (the database checks every key and the total)
    // (the schema refuses one without the other)
    p_optional_keys: accepted?.optionalKeys ?? null,
    p_accepted_total_agorot: accepted?.acceptedTotalAgorot ?? null,
  });
  if (error) {
    if (error.code === "P0002") return reply(404, { ok: false, message: NOT_FOUND });
    console.error("quote_public_answer failed", error.code, error.message);
    return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  }
  const status = (data as { status?: unknown } | null)?.status;
  if (!isDecisionStatus(status)) return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  const done = status === "accepted" || status === "rejected";
  // QUO-09 signed PDF (owner (3) א, (33) ב): after the acceptance committed, the server keeps the signed PDF; a failure never
  // touches the acceptance (staff make it later from the quote's screen)
  if (status === "accepted") after(() => storeSignedQuotePdfForCustomer(token));
  // OPS-02: the shared 429 (Retry-After, never cached)
  if (status === "rate_limited") return rateLimitedJson({ ok: false, status, message: DECISION_MESSAGES[status] });
  return reply(done ? 200 : 409, { ok: done, status, message: DECISION_MESSAGES[status] });
}

// QUO-08 (owner, 1 November 2026, answer (28) א) ------------------------------------------------------------------------
// A question to the rep. Same pattern: the route calls only public.quote_public_question() (security definer, service_role only),
// which checks the token like quote_public, limits per link and per sender (the keyed IP hash, scope "quote"; no secret = no
// hash, the link's own limits still hold), writes one system entry on the quote's deal and contact and tells the quote's
// recipients. It answers {status} only.

const MAX_QUESTION_BYTES = 8_000;

type QuestionReply = { ok: boolean; status?: QuestionStatus; message: string };
const questionReply = (status: number, body: QuestionReply) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** POST /api/forms/quote/<token>/question: the page's own script posts {text} as JSON. */
export async function handleQuoteQuestion(request: Request, token: string): Promise<Response> {
  if (!QUOTE_LINK_TOKEN.test(token)) return questionReply(404, { ok: false, message: NOT_FOUND });
  const service = createServiceClient();
  if (!service) return questionReply(503, { ok: false, message: "ההצעה אינה זמינה כרגע." });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_QUESTION_BYTES) {
    return questionReply(413, { ok: false, status: "invalid", message: QUESTION_MESSAGES.invalid });
  }
  let text: string;
  try {
    const raw = await request.text();
    if (raw.length > MAX_QUESTION_BYTES) return questionReply(413, { ok: false, status: "invalid", message: QUESTION_MESSAGES.invalid });
    const body = questionBodySchema.safeParse(JSON.parse(raw));
    if (!body.success) return questionReply(400, { ok: false, status: "invalid", message: QUESTION_MESSAGES.invalid });
    text = body.data.text;
  } catch {
    return questionReply(400, { ok: false, status: "invalid", message: QUESTION_MESSAGES.invalid });
  }
  const { data, error } = await service.rpc("quote_public_question", {
    p_token: token,
    p_ip_hash: keyedIpHash(senderIp(request.headers), "quote"),
    p_text: text,
  });
  if (error) {
    if (error.code === "P0002") return questionReply(404, { ok: false, message: NOT_FOUND });
    console.error("quote_public_question failed", error.code, error.message);
    return questionReply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  }
  const status = (data as { status?: unknown } | null)?.status;
  if (!isQuestionStatus(status)) return questionReply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  const sent = status === "sent";
  if (status === "rate_limited") return rateLimitedJson({ ok: false, status, message: QUESTION_MESSAGES[status] });
  return questionReply(sent ? 200 : status === "closed" ? 409 : 400, {
    ok: sent,
    status,
    message: QUESTION_MESSAGES[status],
  });
}
