import "server-only";

import type { Json } from "@/lib/database.types";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { markNotFound } from "@/lib/public-not-found";
import { RATE_LIMITED_PAGE_TEXT, RATE_LIMITED_TEXT, rateLimitedJson } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { PREFILL_LINK_TOKEN, prefillWrongField, publicPrefillFrom, type PublicPrefill } from "./public";

// BIZ-05 (approved pattern for public secret-link pages, owner 11 November 2026, answer (271) ב; CLAUDE.md hard rule 5): the
// customer's page of a form that fills an existing record reads only through public.prefill_public() and sends only through
// public.prefill_public_submit() (security definer, service_role only), which check the token, limit per link and per sender,
// and answer only the business's display fields and the template's fields with the record's current values; the submit writes
// only those fields, once. No table is reached directly; no cookies, no visitor id. The sender's IP reaches the database only
// as the keyed hash of FXS-11 (scope "prefill").

export type PublicPrefillState = PublicPrefill | "not-found" | "rate-limited" | "not-configured";

/** The form behind a customer's link (a call: 120 per link and 60 per sender in 10 minutes). */
export async function getPublicPrefill(token: string, ip: string | null): Promise<PublicPrefillState> {
  if (!PREFILL_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("prefill_public", { p_token: token, p_ip_hash: keyedIpHash(ip, "prefill") });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`prefill_public failed: ${error.code}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  // OPS-02 review: a malformed answer is an error, never "not found" (which would count as a miss of the shared sender limit)
  const shaped = publicPrefillFrom(data);
  if (!shaped) throw new Error("prefill_public answered an unexpected shape");
  return shaped;
}

export const PREFILL_MESSAGES = {
  "not-found": "הקישור אינו זמין. ייתכן שהוא בוטל או שפג תוקפו. לקבלת קישור חדש פנו לעסק ששלח אותו.",
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "הדף אינו זמין כרגע.",
} as const;

const MESSAGES = {
  notFound: PREFILL_MESSAGES["not-found"],
  notConfigured: PREFILL_MESSAGES["not-configured"],
  badRequest: "לא הצלחנו לקרוא את הפרטים שנשלחו.",
  tooLarge: "הפרטים שנשלחו ארוכים מדי.",
  invalid: "אחד הפרטים אינו תקין. בדקו ונסו שוב.",
  unique: "אחד הערכים כבר רשום אצל העסק. בדקו ונסו שוב.",
  rateLimited: RATE_LIMITED_TEXT,
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;

export type PrefillReply =
  | { ok: true; status: "saved" | "done"; skipped: string[] }
  | { ok: false; message: string; field?: string };

const MAX_BODY_BYTES = 32 * 1024;

const json = (status: number, reply: PrefillReply) =>
  Response.json(reply, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

/** Only what may be an answer: strings, numbers, booleans and lists of strings, under keys of the database's shape. */
function answers(body: unknown): Record<string, Json> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const values = (body as { values?: unknown }).values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const out: Record<string, Json> = {};
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length > 40) return null;
  for (const [key, value] of entries) {
    if (!/^(cf:[a-z][a-z0-9_]{0,39}|[a-z_]{1,20})$/.test(key)) return null;
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 5000);
    else if (Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === "string")) out[key] = value as string[];
    else return null;
  }
  return out;
}

/** POST /api/forms/fill/<token>: the answers, as JSON {values: {key: value}} (the page's own script posts it). */
export async function handlePrefillSubmit(request: Request, token: string): Promise<Response> {
  if (!PREFILL_LINK_TOKEN.test(token)) return markNotFound(json(404, { ok: false, message: MESSAGES.notFound }));
  const service = createServiceClient();
  if (!service) return json(503, { ok: false, message: MESSAGES.notConfigured });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json(413, { ok: false, message: MESSAGES.tooLarge });
  let values: Record<string, Json> | null;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, message: MESSAGES.tooLarge });
    values = answers(JSON.parse(raw));
  } catch {
    values = null;
  }
  if (!values) return json(400, { ok: false, message: MESSAGES.badRequest });

  const { data, error } = await service.rpc("prefill_public_submit", {
    p_token: token,
    p_ip_hash: keyedIpHash(clientIp(request.headers), "prefill"),
    p_values: values,
  });
  if (error) {
    if (error.code === "P0002") return markNotFound(json(404, { ok: false, message: MESSAGES.notFound }));
    await serverLog("error", "prefill.submit_failed", { code: error.code });
    return json(500, { ok: false, message: MESSAGES.error });
  }
  const answer = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as {
    status?: unknown;
    rate_limited?: unknown;
    skipped?: unknown;
    error?: unknown;
    reason?: unknown;
  };
  if (answer.rate_limited === true) return rateLimitedJson({ ok: false, message: MESSAGES.rateLimited });
  if (answer.status === "saved" || answer.status === "done") {
    const skipped = Array.isArray(answer.skipped) ? answer.skipped.filter((s): s is string => typeof s === "string") : [];
    return json(200, { ok: true, status: answer.status, skipped });
  }
  if (answer.status === "invalid") {
    if (answer.reason === "unique") return json(400, { ok: false, message: MESSAGES.unique });
    const field = typeof answer.error === "string" ? prefillWrongField(answer.error) : undefined;
    return json(400, { ok: false, message: MESSAGES.invalid, field });
  }
  if (answer.status === "error") {
    // the write was refused by the database (a constraint or a trigger); nothing personal is logged
    await serverLog("error", "prefill.submit_refused", {});
    return json(500, { ok: false, message: MESSAGES.error });
  }
  await serverLog("error", "prefill.submit_shape", {});
  return json(500, { ok: false, message: MESSAGES.error });
}
