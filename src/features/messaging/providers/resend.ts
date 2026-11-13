import type { MessagingProvider, ProviderResult } from "./types";

type Env = Record<string, string | undefined>;

/**
 * EML-01 (owner's answer (268) א): Resend, the email provider of one Mexuz platform account. The account's settings, set by
 * the owner in Vercel; THIS FILE IS THE ONLY READER of them (eslint, unit test):
 *   RESEND_API_KEY   the account's API key (Resend's dashboard: API Keys, "Sending access")
 *   RESEND_FROM      the platform address every email goes out from (an address of a domain verified in Resend, e.g.
 *                    noreply@mexuzsystem.com); the business's display name is put in front of it
 * Without both (a key and a plain address) there is no adapter (null), so the email channel has no provider and its jobs wait
 * in the queue unclaimed; nothing changes on a deployment without them.
 *
 * Sending (Resend's API reference, "Send Email"):
 *   POST https://api.resend.com/emails, Authorization: Bearer <key>, Content-Type: application/json,
 *   Idempotency-Key: the job id (Resend answers a repeated key with the first answer, never a second email),
 *   {from: "<business> <RESEND_FROM>", to: [address], subject, text, html, reply_to?, headers?: List-Unsubscribe,
 *    attachments?: [{filename, content (base64), content_type}]}
 *   answer 200 {id}; 429 = throttled; 4xx = refused (nothing sent); 5xx = unknown.
 *   Retried only for a 429 (and 401/403, our key refused: nothing was sent) and a failure before any connection; a timeout,
 *   a 5xx, a 409 (the idempotency key already used) or an unreadable answer ends the job "unknown" (it may have been sent:
 *   never a second send).
 * Everything sent is ONLY what public.email_job_compose answered (the database fills and judges it) and the files read at
 * the paths it named; the address, the text and the key are never logged, kept or returned. One call per message, within
 * 10 seconds plus 2 per started megabyte of the request, at most 40 (resendTimeoutMs).
 */
export const RESEND_SEND_URL = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 10_000;

// errors that mean no connection was made, so nothing was sent (Node's fetch: error.cause.code)
const PRE_CONNECT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
// MSG-03: the provider's id is kept only in this shape
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
// a plain address (the same shape as app.email_address_ok)
const ADDRESS = /^[^@\s,;<>"'\\()]+@[^@\s,;<>"'\\()]+\.[^@\s,;<>"'\\().]+$/;

function causeCode(error: unknown): string | null {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Whether a text is a plain email address (no display name, nothing that changes a header). */
export function plainEmailAddress(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The platform address the emails go out from, or null when it is not a plain address. */
function fromAddress(env: Env): string | null {
  const address = env.RESEND_FROM?.trim() ?? "";
  return plainEmailAddress(address) ? address : null;
}

/** Whether the platform's Resend account is set (a key and a plain sender address). Answers a boolean only. */
export function resendAccountReady(env: Env = process.env): boolean {
  return (env.RESEND_API_KEY?.trim() ?? "") !== "" && fromAddress(env) !== null;
}

// review of EML-01 (findings 3, 8): characters that never go into a header or a file name: C0 and C1 controls, the line and
// paragraph separators, and every format character (Cf: bidi marks and overrides, zero-width characters)
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu;

/**
 * The display name in front of the platform address: no control, separator or format character, quote, angle bracket,
 * backslash or "@", 70 characters at most.
 */
export function senderDisplayName(name: string | null | undefined): string {
  const clean = (name ?? "").replace(UNSAFE, " ").replace(/["<>\\@]/g, " ").replace(/\s+/g, " ").trim();
  return [...clean].slice(0, 70).join("").trim();
}

/**
 * An attachment's file name as it goes out: no control, separator or format character and no path separator, at most 100
 * characters before the extension; the extension (letters and digits, up to 10) is kept. Never empty.
 */
export function attachmentFilename(name: string | null | undefined): string {
  const clean = (name ?? "").replace(UNSAFE, "").replace(/[\/\\]/g, "_").replace(/\s+/g, " ").trim();
  const dot = clean.lastIndexOf(".");
  const ext = dot >= 0 && /^[A-Za-z0-9]{1,10}$/.test(clean.slice(dot + 1)) ? clean.slice(dot + 1) : "";
  const base = [...(ext ? clean.slice(0, dot) : clean)].slice(0, 100).join("").replace(/^[.\s]+|[.\s]+$/g, "");
  return `${base || "file"}${ext ? `.${ext}` : ""}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// a link stands alone: nothing that could continue a URL right before or after it
const LINK_BEFORE = /[\s(<"'\u00a0]/;
const LINK_AFTER = /[\s.,;:!?)\]>"'\u00a0]/;

/**
 * The HTML part of an email from its text: every character escaped, a line break per line, right to left. Only the exact
 * https URLs the composer put in the text itself (`links`: the minted links and the stored review link) are made clickable,
 * where they stand alone; any other address in the text (a name or a field a customer typed) stays plain text. Never http.
 */
export function emailHtml(text: string, links: readonly string[] = []): string {
  const urls = [...new Set(links.filter((url) => /^https:\/\/[^\s<>"']+$/.test(url)))].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let last = 0;
  let at = 0;
  while (urls.length > 0 && at < text.length) {
    let found: { index: number; url: string } | null = null;
    for (const url of urls) {
      let index = text.indexOf(url, at);
      while (index !== -1) {
        const before = index === 0 ? "" : text[index - 1];
        const after = index + url.length >= text.length ? "" : text[index + url.length];
        if ((before === "" || LINK_BEFORE.test(before)) && (after === "" || LINK_AFTER.test(after))) break;
        index = text.indexOf(url, index + 1);
      }
      if (index !== -1 && (found === null || index < found.index)) found = { index, url };
    }
    if (!found) break;
    out.push(escapeHtml(text.slice(last, found.index)));
    out.push(`<a href="${escapeHtml(found.url)}">${escapeHtml(found.url)}</a>`);
    last = found.index + found.url.length;
    at = last;
  }
  out.push(escapeHtml(text.slice(last)));
  const body = out.join("").replace(/\r?\n/g, "<br>\n");
  return `<!doctype html><html lang="he" dir="rtl"><body><div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;text-align:right">${body}</div></body></html>`;
}

/**
 * Review of EML-01 (finding 2): the request's time limit grows with its size (10 s, plus 2 s for every started megabyte),
 * at most RESEND_MAX_TIMEOUT_MS, so a large attachment is not cut off while it uploads.
 */
export const RESEND_MAX_TIMEOUT_MS = 40_000;
export function resendTimeoutMs(bodyBytes: number): number {
  return Math.min(RESEND_TIMEOUT_MS + 2_000 * Math.ceil(Math.max(bodyBytes, 0) / 1_048_576), RESEND_MAX_TIMEOUT_MS);
}

const fail = (code: string, final: boolean): ProviderResult => ({ ok: false, error: `resend ${code}`, code, final });
// not sent (checked before the request, no connection made, or refused by Resend), so the count goes back
const notSent = (code: string, final: boolean): ProviderResult => ({ ok: false, error: `resend ${code}`, code, final, notSent: true });

export function createResendProvider(env: Env = process.env, deps: { fetch?: Fetch } = {}): MessagingProvider | null {
  if (!resendAccountReady(env)) return null;
  const key = `${env.RESEND_API_KEY?.trim()}`;
  const from = fromAddress(env) as string;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  return {
    name: "resend",
    channel: "email",
    composes: true,
    async send(message) {
      const content = message.emailContent;
      if (!content) return notSent("no_content", false);
      if (!plainEmailAddress(content.to)) return notSent("bad_address", true);
      const name = senderDisplayName(content.fromName);
      const body: Record<string, unknown> = {
        from: name ? `"${name}" <${from}>` : from,
        to: [content.to],
        subject: content.subject,
        text: content.text,
        html: emailHtml(content.text, content.links),
      };
      if (content.replyTo && plainEmailAddress(content.replyTo)) body.reply_to = content.replyTo;
      if (content.listUnsubscribe && /^https:\/\/[^\s<>]+$/.test(content.listUnsubscribe)) {
        // RFC 8058: one click from the mail program posts to our unsubscribe route
        body.headers = { "List-Unsubscribe": `<${content.listUnsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
      }
      if (content.attachments.length > 0) {
        body.attachments = content.attachments.map((file) => ({ filename: attachmentFilename(file.name), content: file.content, content_type: file.type }));
      }
      const payload = JSON.stringify(body);
      let response: Response;
      try {
        response = await doFetch(RESEND_SEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Idempotency-Key": message.jobId },
          body: payload,
          signal: AbortSignal.timeout(resendTimeoutMs(Buffer.byteLength(payload, "utf8"))),
          cache: "no-store",
        });
      } catch (error) {
        if (PRE_CONNECT.has(causeCode(error) ?? "")) return notSent("network", false);
        // the request may have reached Resend: final, so it is never sent twice
        return fail(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "unknown_timeout" : "unknown_network", true);
      }
      let answer: unknown = null;
      try {
        answer = await response.json();
      } catch {
        answer = null;
      }
      if (response.ok) {
        const id = answer && typeof answer === "object" ? (answer as Record<string, unknown>).id : undefined;
        if (typeof id === "string" && PROVIDER_ID.test(id)) return { ok: true, providerId: id };
        // accepted, but no id we can keep: the job id stands for it
        return response.status === 200 ? { ok: true, providerId: message.jobId } : fail("unknown_answer", true);
      }
      // throttled: tried again, still counted
      if (response.status === 429) return fail("http_429", false);
      // our key refused (a setting to fix): nothing was sent, tried again
      if (response.status === 401 || response.status === 403) return notSent(`http_${response.status}`, false);
      // the idempotency key was used already (or is in flight): it may have been sent
      if (response.status === 409 || response.status >= 500) return fail(`unknown_http_${response.status}`, true);
      // any other 4xx: Resend refused the request, nothing was sent
      return notSent(`http_${response.status}`, true);
    },
  };
}
