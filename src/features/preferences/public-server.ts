import "server-only";

import type { Json } from "@/lib/database.types";
import { publicSenderAddress } from "@/lib/ip-prefix";
import { serverLog } from "@/lib/log-server";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { markNotFound } from "@/lib/public-not-found";
import { RATE_LIMITED_TEXT, rateLimitedJson, rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import {
  PREFERENCES_MESSAGES,
  PREFERENCES_TOKEN,
  preferenceChoicesFrom,
  preferenceResultsFrom,
  preferencesPageFrom,
  type PreferenceChannel,
  type PreferenceResult,
  type PreferencesPage,
} from "./model";

// CNS-09 / CNS-10 (owner's answer (225) א, a new use of the service key in the approved pattern of CLAUDE.md hard rule 5):
// the customer's preferences page and unsubscribe confirmation read only through public.consent_preferences_public(), and
// their routes write only through public.consent_preferences_submit() (both security definer, service_role only), which
// check the token, count the call (120 per link and 60 per sender in 10 minutes, after the lookup) and answer only the
// channels and the choice: never a name, phone or email. No table is reached directly; no cookies, no visitor id. The
// sender's IP reaches the database only as the keyed hash of FXS-11 (scope "preferences", an IPv6 visitor by its /64).

const senderHash = (ip: string | null) => keyedIpHash(publicSenderAddress(ip), "preferences");
const MAX_BODY_BYTES = 4 * 1024;

export type PreferencesPageState = PreferencesPage | "not-found" | "rate-limited" | "not-configured";

/** The page behind a token (one counted call). */
export async function getPreferencesPage(token: string, ip: string | null): Promise<PreferencesPageState> {
  if (!PREFERENCES_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("consent_preferences_public", { p_token: token, p_ip_hash: senderHash(ip) });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`consent_preferences_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  // OPS-02: a malformed answer is an error, never "not found" (which would count as a miss of the shared sender limit)
  const shaped = preferencesPageFrom(data);
  if (!shaped) throw new Error("consent_preferences_public answered an unexpected shape");
  return shaped;
}

export type PreferencesReply =
  | { ok: true; results?: { channel: PreferenceChannel; result: PreferenceResult }[] }
  | { ok: false; status?: "rate_limited" | "not_found"; message: string };

const json = (status: number, reply: PreferencesReply) =>
  Response.json(reply, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

const REPLY_TEXTS = {
  badRequest: "לא הצלחנו לקרוא את הבחירה שנשלחה.",
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;

async function readBody(request: Request): Promise<{ raw: string } | { error: Response }> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return { error: json(413, { ok: false, message: REPLY_TEXTS.badRequest }) };
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return { error: json(413, { ok: false, message: REPLY_TEXTS.badRequest }) };
  return { raw };
}

async function callSubmit(token: string, mode: "unsubscribe" | "unsubscribe_all" | "preferences", choices: Json | null, ip: string | null) {
  const service = createServiceClient();
  if (!service) return { kind: "not-configured" as const };
  const { data, error } = await service.rpc("consent_preferences_submit", {
    p_token: token,
    p_mode: mode,
    p_choices: choices,
    p_ip_hash: senderHash(ip),
  });
  if (error) {
    if (error.code === "P0002") return { kind: "not-found" as const };
    if (error.code === "22023") return { kind: "bad" as const };
    await serverLog("error", "consent_preferences.submit_failed", { code: error.code });
    return { kind: "error" as const };
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return { kind: "rate-limited" as const };
  }
  return { kind: "ok" as const, data };
}

/**
 * POST /api/forms/prefs/<token>: the page's choice, as JSON {choices: [{channel, on}]}, or {all: true} for "הסרה מכל
 * הערוצים" (the page's own script posts it).
 */
export async function handlePreferencesSubmit(request: Request, token: string): Promise<Response> {
  if (!PREFERENCES_TOKEN.test(token)) return markNotFound(json(404, { ok: false, status: "not_found", message: PREFERENCES_MESSAGES["not-found"] }));
  const body = await readBody(request);
  if ("error" in body) return body.error;
  let choices: ReturnType<typeof preferenceChoicesFrom> = null;
  let all = false;
  try {
    const parsed: unknown = JSON.parse(body.raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      all = (parsed as { all?: unknown }).all === true;
      choices = all ? null : preferenceChoicesFrom((parsed as { choices?: unknown }).choices);
    }
  } catch {
    choices = null;
  }
  if (!all && !choices) return json(400, { ok: false, message: REPLY_TEXTS.badRequest });
  const answer = await callSubmit(token, all ? "unsubscribe_all" : "preferences", all ? null : (choices as unknown as Json), clientIp(request.headers));
  if (answer.kind === "not-found") return markNotFound(json(404, { ok: false, status: "not_found", message: PREFERENCES_MESSAGES["not-found"] }));
  if (answer.kind === "rate-limited") return rateLimitedJson({ ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT });
  if (answer.kind === "not-configured") return json(503, { ok: false, message: PREFERENCES_MESSAGES["not-configured"] });
  if (answer.kind === "bad") return json(400, { ok: false, message: REPLY_TEXTS.badRequest });
  if (answer.kind === "error") return json(500, { ok: false, message: REPLY_TEXTS.error });
  if (all) return json(200, { ok: true });
  const results = preferenceResultsFrom(answer.data);
  if (!results) return json(500, { ok: false, message: REPLY_TEXTS.error });
  return json(200, { ok: true, results });
}

/**
 * POST /api/forms/unsub/<token>: the unsubscribe itself. The confirmation page posts JSON; a mail program's one-click
 * unsubscribe (RFC 8058) posts the form body "List-Unsubscribe=One-Click" and gets plain text. A GET never reaches here (the
 * address in a message is the confirmation page), so a link scanner that only opens links never unsubscribes anyone.
 */
export async function handleUnsubscribe(request: Request, token: string): Promise<Response> {
  const oneClick = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  const text = (status: number, message: string) =>
    new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const notFound = () =>
    markNotFound(oneClick ? text(404, PREFERENCES_MESSAGES["not-found"]) : json(404, { ok: false, status: "not_found", message: PREFERENCES_MESSAGES["not-found"] }));
  if (!PREFERENCES_TOKEN.test(token)) return notFound();
  const body = await readBody(request);
  if ("error" in body) return body.error;
  if (oneClick && !new URLSearchParams(body.raw).has("List-Unsubscribe")) return text(400, REPLY_TEXTS.badRequest);
  const answer = await callSubmit(token, "unsubscribe", null, clientIp(request.headers));
  if (answer.kind === "not-found") return notFound();
  if (answer.kind === "rate-limited") {
    return oneClick ? rateLimitedText(RATE_LIMITED_TEXT) : rateLimitedJson({ ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT });
  }
  if (answer.kind === "not-configured") return oneClick ? text(503, PREFERENCES_MESSAGES["not-configured"]) : json(503, { ok: false, message: PREFERENCES_MESSAGES["not-configured"] });
  if (answer.kind !== "ok") return oneClick ? text(500, REPLY_TEXTS.error) : json(500, { ok: false, message: REPLY_TEXTS.error });
  return oneClick ? text(200, "הוסרתם מרשימת התפוצה.") : json(200, { ok: true });
}
