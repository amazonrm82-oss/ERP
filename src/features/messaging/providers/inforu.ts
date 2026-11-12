import { createHash, timingSafeEqual } from "node:crypto";

import { smsSenderFor, smsAccountReady, type SmsStubSpec } from "./sms-stub";
import type { MessagingProvider, ProviderResult } from "./types";

type Env = Record<string, string | undefined>;

/**
 * SMS-05 (owner's answer (318) א, 12 November 2026): InforU, the SMS provider of one Mexuz platform account (answer (207) א).
 * The platform account's keys, set by the owner in Vercel; THIS FILE IS THE ONLY READER of them (eslint, unit test):
 *   INFORU_USERNAME     the account's user name
 *   INFORU_API_TOKEN    the account's API token (InforU's panel: "API Token")
 *   INFORU_SENDER       the platform's default sender (a number or a name InforU approved for the account)
 *   INFORU_WEBHOOK_SECRET  the long random secret in the path of our two callback routes (delivery status, replies)
 * Without the user name and the token there is no adapter (null), so the SMS channel has no provider and its jobs wait in
 * the queue unclaimed; nothing changes on a deployment without the keys.
 *
 * Sending (InforU's public API documentation, https://apidoc.inforu.co.il/, "Send SMS using json"):
 *   POST https://capi.inforu.co.il/api/v2/SMS/SendSms, Content-Type application/json; charset=utf-8,
 *   Authorization: Basic base64(username:token),
 *   {"Data": {"Message": text, "Recipients": [{"Phone": "05XXXXXXXX", "CustomerMessageID": job id}],
 *             "Settings": {"Sender": sender, "CustomerMessageID": job id, "DeliveryNotificationUrl": our route,
 *                          "AllowDuplicates": false, "IgnoreUnsubscribeCheck": true}}}
 *   IgnoreUnsubscribeCheck true (owner (325) ב): InforU's own unsubscribe list is not used; the business's blocklist and
 *   consents (app.consent_suppressed / app.consent_service_blocked, judged in job_message_may_send and the composer) are.
 *   answer {"StatusId": 1 = success, else a negative code (-2 bad credentials, -18 no valid recipients, -21/-90/-94/-291
 *   sender refused, -96 too long, -13/-14/-15 quota, -429 / -524 too many), "StatusDescription", "RequestId", "Data"}.
 *   Retried only for -429 / -524 and a failure before any connection; a timeout, a 5xx or an unreadable answer ends the
 *   job "unknown" (it may have been sent: never a second send, review (2)).
 *   The answer carries no per-message id: the delivery report names our CustomerMessageID, so the job id is the message's
 *   provider id (public.messages: provider 'inforu', provider_message_id = the job id).
 * The text is ONLY what public.sms_job_compose answered (the database fills and judges it); the phone and the text are never
 * logged, kept or returned, and the token never leaves the Authorization header. One call per message, within 10 seconds.
 */
export const INFORU: SmsStubSpec = { name: "inforu", keys: ["INFORU_USERNAME", "INFORU_API_TOKEN"], defaultSenderKey: "INFORU_SENDER" };

export const INFORU_SEND_URL = "https://capi.inforu.co.il/api/v2/SMS/SendSms";
export const INFORU_TIMEOUT_MS = 10_000;

/** Our callback paths (src/app/api/sms/inforu/...); the secret is the last segment. */
export const INFORU_STATUS_PATH = "/api/sms/inforu/status/";
export const INFORU_INBOUND_PATH = "/api/sms/inforu/inbound/";

// SMS-05 review (2): never a second send. Only InforU's explicit throttle answers and a failure before the request left
// (no connection made) are tried again; once the request may have reached InforU (a timeout, a broken connection, a 5xx,
// an answer we cannot read) the job ends as "unknown", never retried. Every other explicit InforU refusal is final, and
// not sent (owner (326) ב: its count goes back).
const RETRY_STATUS = new Set([-429, -524]);
// errors that mean no connection was made, so nothing was sent (Node's fetch: error.cause.code)
const PRE_CONNECT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

function causeCode(error: unknown): string | null {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** +9725XXXXXXXX -> 05XXXXXXXX (InforU's examples use the local form); a number of another country is not sent. */
export function inforuPhone(e164: string): string | null {
  return /^\+972[2-9][0-9]{7,8}$/.test(e164) ? `0${e164.slice(4)}` : null;
}

/** The webhook secret: 32 characters at least, else none (the routes then answer 503). */
export function inforuWebhookSecret(env: Env = process.env): string | null {
  const secret = env.INFORU_WEBHOOK_SECRET?.trim() ?? "";
  return secret.length >= 32 ? secret : null;
}

/** Whether a path segment is the webhook secret, compared in constant time (both sides hashed first). */
export function inforuSecretMatches(given: string | null | undefined, env: Env = process.env): boolean {
  const secret = inforuWebhookSecret(env);
  if (!secret || typeof given !== "string" || given === "") return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b);
}

function deliveryUrl(env: Env): string | null {
  const site = env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ?? "";
  const secret = inforuWebhookSecret(env);
  return secret && /^https:\/\//.test(site) ? `${site}${INFORU_STATUS_PATH}${encodeURIComponent(secret)}` : null;
}

const fail = (code: string, final: boolean): ProviderResult => ({ ok: false, error: `inforu ${code}`, code, final });
// owner (326) ב: not sent (checked before the request, no connection made, or refused by InforU), so the count goes back
const notSent = (code: string, final: boolean): ProviderResult => ({ ok: false, error: `inforu ${code}`, code, final, notSent: true });

/** Whether the platform's InforU account keys are set (the adapter's own condition, below). Answers a boolean only: the landing
 * page's "בקרוב" marks read it (owner (339) ב), never a key's value. */
export function inforuAccountReady(env: Env = process.env): boolean {
  return smsAccountReady(INFORU, env);
}

export function createInforuProvider(env: Env = process.env, deps: { fetch?: Fetch } = {}): MessagingProvider | null {
  if (!inforuAccountReady(env)) return null;
  // the credentials as the adapter always read them; the header is built by inforu-send.ts, loaded only when a message goes out
  const username = `${env.INFORU_USERNAME?.trim()}`;
  const token = `${env.INFORU_API_TOKEN?.trim()}`;
  const platformSender = env.INFORU_SENDER;
  const callback = deliveryUrl(env);
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  return {
    name: "inforu",
    channel: "sms",
    composes: true,
    async send(message) {
      const content = message.content;
      if (!content) return notSent("no_content", false);
      const phone = inforuPhone(content.to);
      if (!phone) return notSent("foreign_number", true);
      const sender = smsSenderFor(content.sender, platformSender);
      if (!sender) return notSent("no_sender", false);
      // owner (325) ב: InforU's own unsubscribe list is off (one platform account for every business, so an opt-out kept
      // there would block the number for all of them); our blocklist and consents, judged by the database, are the only list
      const settings: Record<string, unknown> = { Sender: sender, CustomerMessageID: message.jobId, AllowDuplicates: false, IgnoreUnsubscribeCheck: true };
      if (callback) settings.DeliveryNotificationUrl = callback;
      let auth: string;
      try {
        const { inforuBasicAuth } = await import("./inforu-send");
        auth = inforuBasicAuth(username, token);
      } catch {
        // nothing reached InforU: not sent, so the count is given back and the job may be tried again
        return notSent("network", false);
      }
      let response: Response;
      try {
        response = await doFetch(INFORU_SEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Authorization: auth },
          body: JSON.stringify({ Data: { Message: content.text, Recipients: [{ Phone: phone, CustomerMessageID: message.jobId }], Settings: settings } }),
          signal: AbortSignal.timeout(INFORU_TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (error) {
        if (PRE_CONNECT.has(causeCode(error) ?? "")) return notSent("network", false);
        // the request may have reached InforU: final, so it is never sent twice
        return fail(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "unknown_timeout" : "unknown_network", true);
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const status = body && typeof body === "object" ? (body as Record<string, unknown>).StatusId : undefined;
      if (status === 1) return { ok: true, providerId: message.jobId };
      if (typeof status === "number" && Number.isInteger(status)) {
        const code = `status_${status < 0 ? "m" : ""}${Math.abs(status)}`;
        // InforU's throttle: tried again, still counted. Any other explicit refusal: final, and not sent, so the count
        // goes back (owner (326) ב, the lead's reading)
        return RETRY_STATUS.has(status) ? fail(code, false) : notSent(code, true);
      }
      if (response.status === 429) return fail("http_429", false);
      if (response.ok || response.status >= 500) return fail(response.ok ? "unknown_answer" : `unknown_http_${response.status}`, true);
      // a 4xx other than 429: InforU refused the request, nothing was sent
      return notSent(`http_${response.status}`, true);
    },
  };
}
