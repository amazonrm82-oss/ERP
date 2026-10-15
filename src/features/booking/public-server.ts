import "server-only";

import { createHmac } from "node:crypto";

import { parseAttribution } from "@/features/intake/attribution";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import type { Json } from "@/lib/database.types";
import { createServiceClient } from "@/lib/supabase/service";

import { confirmationFrom, publicBookingFrom, type PublicBooking } from "./public";
import { BOOKING_ANSWER_MAX } from "./schema";

// CAL-10: the public booking page, in the approved pattern for secret-link pages (owner, 8 October 2026; hard rule 5):
// the server reads and books only through public.booking_page_public() / public.booking_submit() (security definer,
// service_role only), which check the token and answer only what the page shows. No table is reached directly.

const TOKEN = /^[0-9a-f]{32}$/;
// a human needs more than this to pick a time and fill in the details
const MIN_FILL_MS = 2000;
export const MAX_BODY_BYTES = 16 * 1024;

export type PublicBookingState = PublicBooking | "not-found" | "unavailable" | "rate-limited" | "not-configured";

/**
 * The page and the free times of the week from `from` (or the first week), by its token. `ip` is the visitor's
 * address, kept only as a keyed hash for the view limit (60 per sender in 10 minutes; views never close a page).
 */
export async function getPublicBooking(token: string, from: string | null, ip: string | null): Promise<PublicBookingState> {
  if (!TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("booking_page_public", { p_token: token, p_from: from, p_ip_hash: keyedIpHash(token, ip) });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`booking_page_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if ((data as { unavailable?: unknown }).unavailable === true) return "unavailable";
    if ((data as { rate_limited?: unknown }).rate_limited === true) return "rate-limited";
  }
  return publicBookingFrom(data) ?? "not-found";
}

/** The sender's address from the proxy's headers (Vercel sets x-forwarded-for). */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || headers.get("x-real-ip") || null;
}

/**
 * FXS-11 (owner, 13 October 2026): the sender's IP is kept only as a keyed hash, with the server's secret
 * INTAKE_IP_HASH_SECRET, and only for the rate-limit window (the database clears it). Without the secret no hash is
 * kept and the error is logged; there is no fallback to a plain hash.
 */
function keyedIpHash(token: string, ip: string | null): string | null {
  if (!ip) return null;
  const secret = process.env.INTAKE_IP_HASH_SECRET;
  if (!secret) {
    console.error("[CAL-10 booking] INTAKE_IP_HASH_SECRET is not set: no IP hash kept, only the per-page rate limit applies");
    return null;
  }
  return createHmac("sha256", secret).update(`booking:${token}:${ip}`).digest("hex");
}

const MESSAGES = {
  notFound: "הדף לא נמצא או שאינו פעיל.",
  notConfigured: "קביעת התורים עוד לא הוגדרה במערכת.",
  unavailable: "אי אפשר לקבוע תור כרגע.",
  badRequest: "לא הצלחנו לקרוא את הפרטים שנשלחו.",
  tooLarge: "הפרטים שנשלחו ארוכים מדי.",
  slotTaken: "הזמן הזה כבר לא פנוי. בחרו זמן אחר.",
  rateLimited: "נשלחו יותר מדי בקשות בזמן קצר. נסו שוב בעוד כמה דקות.",
  closed: "קביעת התורים בדף הזה סגורה זמנית. נסו שוב בעוד שעה.",
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;

const FIELD_ERRORS: Record<string, { field: string; message: string }> = {
  "booking:full_name": { field: "full_name", message: "יש לכתוב שם." },
  "booking:phone": { field: "phone", message: "יש לכתוב מספר טלפון תקין." },
  "booking:email": { field: "email", message: "כתובת האימייל אינה תקינה." },
  "booking:answer": { field: "answers", message: "יש לענות על השאלות שמסומנות כחובה." },
};

export type BookingReply =
  | { ok: true; confirmation: ReturnType<typeof confirmationFrom> }
  | { ok: false; message: string; field?: string; slotTaken?: boolean };

const json = (status: number, reply: BookingReply) => Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

/** POST /api/forms/booking/<token>: one booking, as JSON (the page's own script posts it). */
export async function handleBooking(request: Request, token: string): Promise<Response> {
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

  const startsAt = text(body.starts_at, 40);
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) return json(400, { ok: false, message: MESSAGES.slotTaken, slotTaken: true });
  const startedAt = Number(body[STARTED_AT_FIELD]);
  const isSpam = text(body[HONEYPOT_FIELD], 200) !== null || (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < MIN_FILL_MS);
  const answersIn = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? (body.answers as Record<string, unknown>) : {};
  const answers = Object.fromEntries(
    Object.entries(answersIn)
      .slice(0, 20)
      .map(([key, value]) => [key.slice(0, 40), text(value, BOOKING_ANSWER_MAX)])
      .filter((entry): entry is [string, string] => entry[1] !== null),
  );
  const payload = {
    full_name: text(body.full_name, 200),
    phone: text(body.phone, 40),
    email: text(body.email, 254),
    answers,
    // CAP-02: the visit's campaign keys; the database keeps them on a new lead only
    attribution: parseAttribution(body),
  };

  const { data, error } = await service.rpc("booking_submit", {
    p_token: token,
    p_starts_at: new Date(startsAt).toISOString(),
    p_payload: payload as unknown as Json,
    p_ip_hash: keyedIpHash(token, clientIp(request.headers)),
    p_user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    p_is_spam: isSpam,
  });
  if (error) {
    if (error.code === "P0002") return json(404, { ok: false, message: MESSAGES.notFound });
    if (error.hint === "rate_limited") return json(429, { ok: false, message: MESSAGES.rateLimited });
    // 200 failed attempts within an hour close the page for an hour (owner, 15 October 2026)
    if (error.hint === "booking:closed") return json(429, { ok: false, message: MESSAGES.closed });
    if (error.hint === "booking:unavailable") return json(403, { ok: false, message: MESSAGES.unavailable });
    const fieldError = error.hint ? FIELD_ERRORS[error.hint] : undefined;
    if (fieldError) return json(400, { ok: false, message: fieldError.message, field: fieldError.field });
    console.error("booking_submit failed", error.code, error.message);
    return json(500, { ok: false, message: MESSAGES.error });
  }
  // a time taken meanwhile, or one the page never offered, is answered (not raised) so the attempt stays counted
  const status = data && typeof data === "object" && !Array.isArray(data) ? (data as { status?: unknown }).status : null;
  if (status === "slot_taken" || status === "invalid_time") {
    return json(409, { ok: false, message: MESSAGES.slotTaken, slotTaken: true });
  }
  // spam is answered like a booking, with nothing in it
  return json(200, { ok: true, confirmation: confirmationFrom(data) });
}
