import "server-only";

import { decisionBodySchema, type DecisionBody, type DecisionStatus, isDecisionStatus } from "@/features/quotes/decision";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { createServiceClient } from "@/lib/supabase/service";

import { ORDER_ACCEPT_WORDING_VERSION, ORDER_LINK_TOKEN, publicOrderFrom, statusOrderFrom, type PublicOrder, type StatusPublicOrder } from "./public";

// ORD-05 (owner, 20 October 2026): the customer's page of a numbered order, in the approved pattern for secret-link pages
// (CLAUDE.md hard rule 5): the server reads only through public.order_public() and decides only through
// public.order_public_decide() (security definer, service_role only), which check the token and answer only what the page
// needs. No table is reached directly; no cookies, no visitor id. The sender's IP reaches the database only as the keyed
// hash of FXS-11 (scope "order"), for the view limit; a decision keeps the full IP and browser as evidence (as QUO-09).

export type PublicOrderState = PublicOrder | StatusPublicOrder | "not-found" | "rate-limited" | "not-configured";

/** The order behind a customer's link (a view: 120 per link and 60 per sender in 10 minutes). */
export async function getPublicOrder(token: string, ip: string | null): Promise<PublicOrderState> {
  if (!ORDER_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("order_public", { p_token: token, p_ip_hash: keyedIpHash(ip, "order") });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`order_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return statusOrderFrom(data) ?? publicOrderFrom(data) ?? "not-found";
}

const MAX_DECISION_BYTES = 350_000;

/** The Hebrew answer the page shows for each outcome of an order's decision. */
export const ORDER_DECISION_MESSAGES: Record<DecisionStatus, string> = {
  accepted: "תודה! ההזמנה אושרה ונחתמה.",
  rejected: "התשובה נשמרה. תודה שעדכנת.",
  already_decided: "כבר התקבלה תשובה על ההזמנה הזאת.",
  closed: "ההזמנה כבר לא מחכה לתשובה. רעננו את הדף.",
  changed: "פרטי ההזמנה התעדכנו בזמן שהדף היה פתוח. בדקו את הפרטים העדכניים ונסו שוב.",
  invalid: "חלק מהפרטים לא תקינים. בדקו את השם, תעודת הזהות והחתימה.",
  rate_limited: "היו יותר מדי ניסיונות בזמן קצר. נסו שוב בעוד כמה דקות.",
};

type DecisionReply = { ok: true; status: DecisionStatus; message: string } | { ok: false; status?: DecisionStatus; message: string };
const reply = (status: number, body: DecisionReply) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const NOT_FOUND = "ההזמנה לא נמצאה, או שהקישור כבר לא בתוקף.";

/** POST /api/forms/order/<token>/decide: the page's own script posts the decision as JSON. */
export async function handleOrderDecision(request: Request, token: string): Promise<Response> {
  if (!ORDER_LINK_TOKEN.test(token)) return reply(404, { ok: false, message: NOT_FOUND });
  const service = createServiceClient();
  if (!service) return reply(503, { ok: false, message: "ההזמנה אינה זמינה כרגע." });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_DECISION_BYTES) return reply(413, { ok: false, message: ORDER_DECISION_MESSAGES.invalid });
  let parsed: DecisionBody;
  try {
    const raw = await request.text();
    if (raw.length > MAX_DECISION_BYTES) return reply(413, { ok: false, message: ORDER_DECISION_MESSAGES.invalid });
    const body = decisionBodySchema.safeParse(JSON.parse(raw));
    if (!body.success) return reply(400, { ok: false, status: "invalid", message: ORDER_DECISION_MESSAGES.invalid });
    parsed = body.data;
  } catch {
    return reply(400, { ok: false, status: "invalid", message: ORDER_DECISION_MESSAGES.invalid });
  }

  const accepted = parsed.decision === "accepted" ? parsed : null;
  const { data, error } = await service.rpc("order_public_decide", {
    p_token: token,
    p_decision: parsed.decision,
    p_fingerprint: parsed.fingerprint,
    p_signer_name: accepted?.signerName ?? null,
    p_id_number: accepted?.idNumber || null,
    p_signature_kind: accepted?.signatureKind ?? null,
    p_signature_image: accepted?.signatureKind === "drawn" ? accepted.signatureImage : null,
    p_wording_version: accepted ? ORDER_ACCEPT_WORDING_VERSION : null,
    p_agreed: accepted?.agreed ?? false,
    p_decline_reason: parsed.decision === "rejected" ? parsed.reason || null : null,
    p_ip: clientIp(request.headers)?.slice(0, 64) ?? null,
    p_user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  });
  if (error) {
    if (error.code === "P0002") return reply(404, { ok: false, message: NOT_FOUND });
    console.error("order_public_decide failed", error.code, error.message);
    return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  }
  const status = (data as { status?: unknown } | null)?.status;
  if (!isDecisionStatus(status)) return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  const done = status === "accepted" || status === "rejected";
  return reply(done ? 200 : status === "rate_limited" ? 429 : 409, { ok: done, status, message: ORDER_DECISION_MESSAGES[status] });
}
