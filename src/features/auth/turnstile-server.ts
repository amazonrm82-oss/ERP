import "server-only";

import { headers } from "next/headers";
import { isIP } from "node:net";

import { clientIp } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";

import { CAPTCHA_FAILED, CAPTCHA_UNAVAILABLE, TURNSTILE_FIELD, type TurnstileAction } from "./turnstile";

// Cloudflare Turnstile, server side (owner (275) א; FXS-12). This file is the ONLY reader of TURNSTILE_SECRET_KEY (set by the
// owner in Vercel; lint refuses the name anywhere else in src; never NEXT_PUBLIC_). With the project's secret key Supabase Auth
// treats sign-in, sign-up and the reset email as admin calls and skips its own CAPTCHA, so the three auth actions call
// verifyTurnstile() BEFORE any Supabase call; Supabase's own CAPTCHA protection stays off.
// The check: POST to siteverify with the secret, the widget's token and the user's address, within 3 seconds (owner (319)); accepted only
// with success true, a hostname on the closed list (mexuzsystem.com, erp-3yft.vercel.app, the host of NEXT_PUBLIC_SITE_URL)
// and the action of the same form. Never logged: the token, the secret, the address. One redacted line per refusal reason and
// form per minute.
// Off: without BOTH keys there is no widget and no check (the forms work exactly as before; one line per process says so).
// Cloudflare unreachable (timeout, network error, 5xx, an answer that is not JSON, internal-error, or our secret refused):
// the sign-in and the landing contact form (owner (340) ב) pass (never locked out, as FXS-12's fallback; an attacker cannot
// make our server's call fail), sign-up and the
// reset email are refused with "try again in a minute" (owner (319) א). That case logs event `turnstile.unavailable`.
// The address is only sent to Cloudflare (remoteip); it is never stored, logged or kept in memory past the request.

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 3_000;
export const TURNSTILE_FIXED_HOSTS = ["mexuzsystem.com", "erp-3yft.vercel.app"] as const;

// a token is at most 2,048 characters (Cloudflare); printable ASCII, no spaces
const TOKEN = /^[\x21-\x7e]{1,2048}$/;
const SITE_KEY = /^[A-Za-z0-9_-]{8,100}$/;

type OffReason = "keys_not_set" | "site_key_missing" | "secret_key_missing" | "site_key_invalid";

/** The two keys, or why the check is off. */
export function turnstileKeys(env: { siteKey?: string; secret?: string }): { siteKey: string; secret: string } | { off: OffReason } {
  const siteKey = env.siteKey?.trim() ?? "";
  const secret = env.secret?.trim() ?? "";
  if (!siteKey && !secret) return { off: "keys_not_set" };
  if (!siteKey) return { off: "site_key_missing" };
  if (!secret) return { off: "secret_key_missing" };
  if (!SITE_KEY.test(siteKey)) return { off: "site_key_invalid" };
  return { siteKey, secret };
}

let offLogged = false;

function currentKeys() {
  // NEXT_PUBLIC_ is inlined at build time; the secret is read at run time
  const keys = turnstileKeys({ siteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, secret: process.env.TURNSTILE_SECRET_KEY });
  if ("off" in keys && !offLogged) {
    offLogged = true;
    void serverLog(keys.off === "keys_not_set" ? "info" : "warn", "auth.turnstile_off", { reason: keys.off });
  }
  return keys;
}

/** The site key for the three forms' widget while both keys are set, else null (no widget). */
export function turnstileSiteKey(): string | null {
  const keys = currentKeys();
  return "off" in keys ? null : keys.siteKey;
}

/** The hostnames a token may come from: the two fixed ones and the host of NEXT_PUBLIC_SITE_URL. */
export function allowedHostnames(siteUrl: string | undefined): string[] {
  const hosts = new Set<string>(TURNSTILE_FIXED_HOSTS);
  try {
    if (siteUrl?.trim()) hosts.add(new URL(siteUrl.trim()).hostname.toLowerCase());
  } catch {
    // a malformed site URL adds nothing
  }
  return [...hosts];
}

export type TurnstileOutcome =
  | { result: "pass" }
  | { result: "refused"; reason: "missing_token" | "bad_token" | "not_success" | "wrong_hostname" | "wrong_action"; code?: string }
  | { result: "unavailable"; reason: "timeout" | "network" | "http_error" | "bad_answer" | "internal_error" | "secret_rejected"; code?: string };

type CheckInput = {
  secret: string;
  token: unknown;
  ip: string | null;
  action: TurnstileAction;
  hostnames: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const SECRET_CODES = new Set(["missing-input-secret", "invalid-input-secret"]);

/** One siteverify call and its judgement. Never throws; never returns the token or the secret. */
export async function checkTurnstileToken({ secret, token, ip, action, hostnames, fetchImpl = fetch, timeoutMs = TURNSTILE_TIMEOUT_MS }: CheckInput): Promise<TurnstileOutcome> {
  if (typeof token !== "string" || token.length === 0) return { result: "refused", reason: "missing_token" };
  if (!TOKEN.test(token)) return { result: "refused", reason: "bad_token" };
  const body = new URLSearchParams({ secret, response: token });
  if (ip && isIP(ip) !== 0) body.set("remoteip", ip);
  let response: Response;
  try {
    response = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { result: "unavailable", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
  if (response.status >= 500) return { result: "unavailable", reason: "http_error", code: String(response.status) };
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    return { result: "unavailable", reason: "bad_answer" };
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return { result: "unavailable", reason: "bad_answer" };
  const a = answer as Record<string, unknown>;
  const codes = Array.isArray(a["error-codes"]) ? a["error-codes"].filter((c): c is string => typeof c === "string") : [];
  const firstCode = codes.find((c) => /^[a-z0-9-]{1,40}$/.test(c));
  if (a.success !== true) {
    if (codes.some((c) => SECRET_CODES.has(c))) return { result: "unavailable", reason: "secret_rejected", code: firstCode };
    if (codes.includes("internal-error")) return { result: "unavailable", reason: "internal_error" };
    if (!response.ok && codes.length === 0) return { result: "unavailable", reason: "http_error", code: String(response.status) };
    return { result: "refused", reason: "not_success", code: firstCode };
  }
  const hostname = typeof a.hostname === "string" ? a.hostname.toLowerCase() : "";
  if (!hostnames.includes(hostname)) return { result: "refused", reason: "wrong_hostname" };
  if (a.action !== action) return { result: "refused", reason: "wrong_action" };
  return { result: "pass" };
}

/** The forms that pass while Cloudflare cannot be asked: the sign-in (never locked out) and the landing page's contact form
 * (owner (340) ב; its honeypot and intake_submit's limits still apply); sign-up, its "send again" and the reset email do not
 * (owner (319) א). Either way the case logs `turnstile.unavailable`. */
export function passesWhenUnavailable(action: TurnstileAction): boolean {
  return action === "login" || action === "contact";
}

// one line per reason and form a minute, so an attack does not flood the log
const lastLogged = new Map<string, number>();
const LOG_EVERY_MS = 60_000;

async function noteOutcome(outcome: Exclude<TurnstileOutcome, { result: "pass" }>, action: TurnstileAction) {
  const key = `${outcome.result}:${outcome.reason}:${action}`;
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_EVERY_MS) return;
  lastLogged.set(key, now);
  // our secret refused by Cloudflare means a wrong key in Vercel: an error, even while the sign-in passes
  const level = outcome.reason === "secret_rejected" ? "error" : outcome.result === "unavailable" || outcome.reason === "wrong_hostname" ? "warn" : "info";
  await serverLog(level, outcome.result === "unavailable" ? "turnstile.unavailable" : "auth.turnstile_refused", {
    reason: outcome.reason,
    what: action,
    code: outcome.code,
  });
}

/**
 * The check the three auth actions run before Supabase: ok while the check is off or passed, else the Hebrew refusal. Reads
 * the token from the form's `cf-turnstile-response` field and the address from the request (clientIp()).
 */
export async function verifyTurnstile(formData: FormData, action: TurnstileAction, fetchImpl?: typeof fetch): Promise<{ ok: true } | { ok: false; message: string }> {
  return verifyTurnstileToken(formData.get(TURNSTILE_FIELD), action, fetchImpl);
}

/** verifyTurnstile for an action that takes the token as an argument (sign-up's "send again"). */
export async function verifyTurnstileToken(token: unknown, action: TurnstileAction, fetchImpl?: typeof fetch): Promise<{ ok: true } | { ok: false; message: string }> {
  const keys = currentKeys();
  if ("off" in keys) return { ok: true };
  const ip = clientIp(await headers())?.trim() ?? null;
  const outcome = await checkTurnstileToken({
    secret: keys.secret,
    token,
    ip,
    action,
    hostnames: allowedHostnames(process.env.NEXT_PUBLIC_SITE_URL),
    fetchImpl,
  });
  if (outcome.result === "pass") return { ok: true };
  if (outcome.result === "unavailable") {
    const passes = passesWhenUnavailable(action);
    await noteOutcome(outcome, action);
    return passes ? { ok: true } : { ok: false, message: CAPTCHA_UNAVAILABLE };
  }
  await noteOutcome(outcome, action);
  return { ok: false, message: CAPTCHA_FAILED };
}
