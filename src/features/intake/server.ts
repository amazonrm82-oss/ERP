import "server-only";

import { createHash } from "node:crypto";

import type { Json } from "@/lib/database.types";
import { createServiceClient } from "@/lib/supabase/service";

import { HONEYPOT_FIELD, STARTED_AT_FIELD, type IntakeField } from "./fields";
import { wrongField } from "./public-validate";

export type IntakeKind = "form" | "webhook";

// What other systems call the fields: Zapier, Make, WordPress plugins, etc.
const ALIASES: Record<IntakeField, string[]> = {
  full_name: ["full_name", "fullName", "name", "שם", "first_name"],
  phone: ["phone", "phone_number", "tel", "mobile", "טלפון"],
  email: ["email", "email_address", "mail", "אימייל"],
  company_name: ["company_name", "company", "business", "חברה"],
  message: ["message", "notes", "comments", "text", "הודעה"],
};

// A human needs more than this to fill in a form.
const MIN_FILL_MS = 2000;

// FXS-02: a form post is a few fields. Bigger bodies are refused before the
// database, and each field is cut to the length the lead keeps.
export const MAX_BODY_BYTES = 32 * 1024;
const MAX_LENGTH: Record<IntakeField, number> = { full_name: 200, phone: 40, email: 254, company_name: 200, message: 5000 };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** The body as an object; "too_large" past MAX_BODY_BYTES (read in pieces, so a huge body is never held whole). */
async function readBody(request: Request): Promise<Record<string, unknown> | null | "too_large"> {
  const type = request.headers.get("content-type") ?? "";
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return "too_large";
  }
  const bytes = await readLimited(request);
  if (bytes === "too_large") {
    return bytes;
  }
  try {
    if (type.includes("application/json")) {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    }
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const form = await new Response(bytes as unknown as BodyInit, { headers: { "content-type": type } }).formData();
      const out: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    }
  } catch {
    return null;
  }
  return null;
}

async function readLimited(request: Request): Promise<Uint8Array | "too_large"> {
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The known lead fields from a body, whatever the sender called them. */
export function normalize(body: Record<string, unknown>): Record<IntakeField, string | null> {
  const out = {} as Record<IntakeField, string | null>;
  for (const [field, names] of Object.entries(ALIASES) as Array<[IntakeField, string[]]>) {
    out[field] = names.map((name) => text(body[name])).find((value) => value !== null) ?? null;
  }
  // "first_name" + "last_name" senders
  const last = text(body.last_name);
  if (out.full_name && last && text(body.first_name) === out.full_name) {
    out.full_name = `${out.full_name} ${last}`;
  }
  for (const field of Object.keys(out) as IntakeField[]) {
    out[field] = out[field]?.slice(0, MAX_LENGTH[field]) ?? null;
  }
  return out;
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

// field: which form field was wrong, so the hosted form can mark it (FXA-02)
type Reply = { ok: boolean; message: string; redirectUrl?: string | null; field?: string };

const MESSAGES = {
  notConfigured: "קליטת הלידים עוד לא הוגדרה במערכת.",
  badRequest: "לא הצלחנו לקרוא את הפרטים שנשלחו.",
  tooLarge: "הפרטים שנשלחו ארוכים מדי.",
  notFound: "הטופס לא נמצא או שאינו פעיל.",
  invalid: "חלק מהפרטים חסרים או לא תקינים. יש למלא שם, טלפון או אימייל, ואת כל שדות החובה.",
  rateLimited: "נשלחו יותר מדי פניות בזמן קצר. נסו שוב בעוד כמה דקות.",
  unavailable: "לא ניתן לשלוח את הטופס כרגע.",
  error: "משהו השתבש. נסו שוב בעוד רגע.",
  thanks: "תודה! קיבלנו את הפרטים ונחזור אליך בהקדם.",
};

/**
 * One submission from a public form (kind 'form') or a webhook (kind 'webhook').
 * Answers JSON, or a redirect for a classic HTML form post from another site.
 */
export async function handleIntake(request: Request, token: string, kind: IntakeKind): Promise<Response> {
  const wantsRedirect = kind === "form" && (request.headers.get("accept") ?? "").includes("text/html");
  const respond = (status: number, reply: Reply) => {
    if (wantsRedirect && reply.ok && reply.redirectUrl) {
      return Response.redirect(reply.redirectUrl, 303);
    }
    return Response.json(reply, { status, headers: kind === "form" ? CORS_HEADERS : undefined });
  };

  if (!/^[0-9a-f]{32}$/.test(token)) {
    return respond(404, { ok: false, message: MESSAGES.notFound });
  }
  const service = createServiceClient();
  if (!service) {
    return respond(503, { ok: false, message: MESSAGES.notConfigured });
  }
  const body = await readBody(request);
  const ip = clientIp(request);
  // salted per form: the stored value cannot be matched across forms or reversed cheaply
  const ipHash = ip ? createHash("sha256").update(`${token}:${ip}`).digest("hex") : null;
  if (body === "too_large") {
    // still counted against the sender's rate limit: logged as spam with nothing in it
    await service.rpc("intake_submit", { p_token: token, p_kind: kind, p_payload: {}, p_ip_hash: ipHash, p_user_agent: null, p_is_spam: true });
    return respond(413, { ok: false, message: MESSAGES.tooLarge });
  }
  if (!body) {
    return respond(400, { ok: false, message: MESSAGES.badRequest });
  }

  // Spam checks of the hosted form: a hidden field a person never fills, and
  // a fill time no person manages. Spam is logged and answered like success.
  let isSpam = false;
  if (kind === "form") {
    const startedAt = Number(body[STARTED_AT_FIELD]);
    isSpam = text(body[HONEYPOT_FIELD]) !== null || (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < MIN_FILL_MS);
  }

  const { data, error } = await service.rpc("intake_submit", {
    p_token: token,
    p_kind: kind,
    p_payload: normalize(body) as unknown as Json,
    p_ip_hash: ipHash,
    p_user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    p_is_spam: isSpam,
  });

  if (error) {
    if (error.code === "P0002") return respond(404, { ok: false, message: MESSAGES.notFound });
    if (error.code === "22023" || error.code === "23514") return respond(400, { ok: false, message: MESSAGES.invalid, field: wrongField(error.message) });
    if (error.code === "P0001" && error.hint === "rate_limited") return respond(429, { ok: false, message: MESSAGES.rateLimited });
    if (error.code === "P0001") return respond(403, { ok: false, message: MESSAGES.unavailable });
    console.error("intake_submit failed", error.code, error.message);
    return respond(500, { ok: false, message: MESSAGES.error });
  }

  const result = (data ?? {}) as { success_message?: string | null; redirect_url?: string | null };
  return respond(200, { ok: true, message: result.success_message || MESSAGES.thanks, redirectUrl: result.redirect_url ?? null });
}
