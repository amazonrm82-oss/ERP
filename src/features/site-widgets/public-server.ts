import "server-only";

import { brandPalette, DEFAULT_PICKER_COLOR } from "@/features/branding/color";
import { parseAttribution } from "@/features/intake/attribution";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import type { Json } from "@/lib/database.types";
import { clientIp, keyedIpHash as keyedHash } from "@/lib/keyed-ip-hash";
import { createServiceClient } from "@/lib/supabase/service";

import { isWidgetToken, widgetFormPath } from "./paths";
import { publicWidgetFrom, type PublicWidget } from "./public";
import { widgetScript } from "./script";

// SPD-07: the site widget, in the approved pattern for public secret-link pages (owner, 13 October 2026; hard rule 5):
// the server reads only through public.site_widget_public() and sends the form only through public.site_widget_submit()
// (security definer, service_role only), which check the token and answer only the display settings; the form goes on
// to the existing intake_submit. No table is reached directly; no cookies, no visitor id.

// a human needs more than this to fill in the details
const MIN_FILL_MS = 2000;
const MAX_BODY_BYTES = 8 * 1024;
// the script is the same for every visitor: browsers and the CDN keep it a few minutes, so a busy site does not reach
// the database on every page view, and a widget switched off stops within that time
const SCRIPT_CACHE = "public, max-age=300, s-maxage=300";

export type PublicWidgetState = PublicWidget | "not-found" | "rate-limited" | "not-configured";

// FXS-11: the sender's IP as a keyed hash (src/lib/keyed-ip-hash.ts, scope "widget", the value this page always used);
// the database scopes it further per widget (app.site_widget_sender), so one visitor is a different sender on every widget
const keyedIpHash = (ip: string | null) => keyedHash(ip, "widget");

/** The widget behind a token; with an address the view counts (60 per sender in 10 minutes). */
export async function getPublicWidget(token: string, ip: string | null): Promise<PublicWidgetState> {
  if (!isWidgetToken(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("site_widget_public", { p_token: token, p_ip_hash: keyedIpHash(ip) });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`site_widget_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return publicWidgetFrom(data) ?? "not-found";
}

const js = (status: number, body: string, cache: string) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" },
  });

/** GET /f/w/<token>.js: the widget's script, with its display settings in it. Not counted per visitor (cached). */
export async function handleWidgetScript(token: string): Promise<Response> {
  const widget = await getPublicWidget(token, null);
  if (widget === "not-configured") return js(503, "/* widget unavailable */\n", "no-store");
  if (typeof widget === "string") return js(404, "/* widget not found */\n", "public, max-age=60, s-maxage=60");
  const palette = brandPalette(widget.brand.color ?? DEFAULT_PICKER_COLOR);
  const body = widgetScript({
    label: widget.label,
    position: widget.position,
    whatsapp: widget.whatsapp,
    call: widget.call,
    formPath: widget.form ? widgetFormPath(token) : null,
    accent: palette.accent,
    onAccent: palette.onAccent,
  });
  return js(200, body, SCRIPT_CACHE);
}

const MESSAGES = {
  notFound: "הטופס לא נמצא או שאינו פעיל.",
  notConfigured: "הטופס אינו זמין כרגע.",
  badRequest: "לא הצלחנו לקרוא את הפרטים שנשלחו.",
  tooLarge: "הפרטים שנשלחו ארוכים מדי.",
  missing: "יש לכתוב שם ומספר טלפון או אימייל.",
  email: "כתובת האימייל אינה תקינה.",
  rateLimited: "נשלחו יותר מדי פניות בזמן קצר. נסו שוב בעוד כמה דקות.",
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;

export type WidgetReply = { ok: true } | { ok: false; message: string };

const json = (status: number, reply: WidgetReply) => Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

/** POST /api/forms/widget/<token>: the widget's short form, as JSON (the form page's own script posts it). */
export async function handleWidgetSubmit(request: Request, token: string): Promise<Response> {
  if (!isWidgetToken(token)) return json(404, { ok: false, message: MESSAGES.notFound });
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
  // only what the widget's form asks, plus the page and campaign keys; anything else is dropped here and in the database
  const payload = {
    full_name: text(body.full_name, 200),
    phone: text(body.phone, 40),
    email: text(body.email, 254),
    message: text(body.message, 2000),
    attribution: parseAttribution(body),
  };
  if (!payload.full_name || (!payload.phone && !payload.email)) return json(400, { ok: false, message: MESSAGES.missing });

  const { error } = await service.rpc("site_widget_submit", {
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
    console.error("site_widget_submit failed", error.code, error.message);
    return json(500, { ok: false, message: MESSAGES.error });
  }
  // spam is answered like the rest
  return json(200, { ok: true });
}
