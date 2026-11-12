import "server-only";

import { verifyTurnstileToken } from "@/features/auth/turnstile-server";
import { TURNSTILE_ACTIONS, TURNSTILE_FIELD } from "@/features/auth/turnstile";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import { handleIntake } from "@/features/intake/server";
import { SUPPORT } from "@/lib/support";

import { honeypotFilled } from "./waitlist";
import { contactBusinessTypeField, CONTACT_BUSINESS_TYPES, CONTACT_CONSENT_VERSION, CONTACT_TEXTS, contactFormToken, contactMessage } from "./contact";

/**
 * POST /api/forms/contact (LND-20 v2 (8)). No new database function and no new use of the service key: Turnstile is checked
 * by our verifier (action `contact`), then the inquiry is handed to the ordinary public intake of MEXUZ Systems' "צור קשר
 * באתר" form (handleIntake, the same code and limits as POST /api/forms/<token>: FXS-11 per sender, the honeypot, the fill
 * time, intake_submit's own checks). Turnstile passes while Cloudflare cannot be asked (owner (340) ב, as the sign-in). The
 * consent (with its wording version) travels in the inquiry's message, which the form keeps; the business type goes into the
 * form's select field named by CONTACT_BUSINESS_TYPE_FIELD (owner (343) ב), else into the message too.
 */
const MAX_BODY = 8 * 1024;

export async function handleContact(request: Request): Promise<Response> {
  const respond = (status: number, body: { ok: boolean; message: string; field?: string }) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const token = contactFormToken(SUPPORT.formUrl);
  if (!token) return respond(503, { ok: false, message: CONTACT_TEXTS.unavailable });
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return respond(413, { ok: false, message: CONTACT_TEXTS.unavailable });
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return respond(400, { ok: false, message: CONTACT_TEXTS.unavailable });
    body = parsed as Record<string, unknown>;
  } catch {
    return respond(400, { ok: false, message: CONTACT_TEXTS.unavailable });
  }
  const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const type = str(body.business_type, 60);
  if (type && !(CONTACT_BUSINESS_TYPES as readonly string[]).includes(type)) return respond(400, { ok: false, message: CONTACT_TEXTS.type, field: "business_type" });
  if (body.consent !== true) return respond(400, { ok: false, message: CONTACT_TEXTS.consent, field: "consent" });

  const check = await verifyTurnstileToken(body[TURNSTILE_FIELD], TURNSTILE_ACTIONS.contact);
  if (!check.ok) return respond(400, { ok: false, message: check.message, field: TURNSTILE_FIELD });

  // owner (343) ב: into its own select field when the server names it, else into the message
  const typeField = contactBusinessTypeField(process.env.CONTACT_BUSINESS_TYPE_FIELD);
  const intakeBody: Record<string, string> = {
    full_name: str(body.full_name, 200),
    phone: str(body.phone, 40),
    message: contactMessage(typeField ? null : type || null, CONTACT_CONSENT_VERSION),
    ...(typeField && type ? { [`cf_${typeField}`]: type } : {}),
    // any non-empty honeypot value of any type reaches the intake as a filled one (stored as spam with nothing in it)
    [HONEYPOT_FIELD]: honeypotFilled(body[HONEYPOT_FIELD]) ? (str(body[HONEYPOT_FIELD], 200) || "1") : "",
    [STARTED_AT_FIELD]: typeof body[STARTED_AT_FIELD] === "number" ? String(body[STARTED_AT_FIELD]) : "",
  };
  // the same request the browser would post to /api/forms/<token>: its address and user agent travel along for FXS-11
  const forwarded = new Headers({ "content-type": "application/json" });
  for (const name of ["x-forwarded-for", "x-real-ip", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  return handleIntake(new Request(request.url, { method: "POST", headers: forwarded, body: JSON.stringify(intakeBody) }), token, "form");
}
