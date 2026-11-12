import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { AuthError, AuthResponse, AuthTokenResponsePassword, SignInWithPasswordCredentials, SignUpWithPasswordCredentials } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { isIP } from "node:net";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv, MissingConfigError } from "@/lib/env";
import { clientIp } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { SESSION_COOKIE } from "@/lib/supabase/proxy";
import { createClient, sessionCookieMethods } from "@/lib/supabase/server";

// FXS-12 (owner, 12 November 2026, answer (281) א): sign-in, sign-up and the password-reset email run on our server, so
// Supabase Auth would see Vercel's address and rate-limit everyone together. With "IP Address Forwarding" on in the
// Supabase dashboard, a request made with the project's SECRET key (sb_secret_…) may name the user's address in the
// header sb-forwarded-for, and Auth limits per user again. This file is the ONLY reader of SUPABASE_SECRET_KEY (set by
// the owner in Vercel; lint refuses the name anywhere else) and only src/features/auth/actions.ts imports it. The key is
// used for exactly these three Auth calls and nothing else: the client below is never handed out (no .from, .rpc,
// .storage, no other auth call), and only the call's own answer goes back, the same answer the user's own client gave.
// The session cookies are written exactly as before: the client uses the same cookie methods and options as
// src/lib/supabase/server.ts (the PKCE code verifier of sign-up and reset is written there at once by @supabase/ssr), and
// after a sign-in the session is also handed to the request's own client with setSession, so the code that runs next in
// the same request (the two-step check) reads it from that client as it did before. If that hand-over fails, the
// request's client signs out locally, so no half signed-in cookies are left.
// The browser's User-Agent is NOT forwarded: Supabase refuses a secret key sent with a browser User-Agent (HTTP 401), so
// the forwarding client sends a fixed server value, FORWARDING_USER_AGENT (Supabase's sessions therefore show that value
// for sessions started here, and the user's real address).
// Never locked out: without the key (or with a key that is not a secret key, or no valid address) the calls go through the
// user's own client unchanged; and when the forwarding call is refused because of the key (401/403 from the gateway: a
// revoked, rotated or blocked key; never Auth's own answer such as 400 invalid_credentials), the same call is made once
// more through the user's own client. One redacted line per reason and process is logged; never the key or the address.
// CAPTCHA (owner (275): Cloudflare Turnstile): with the secret key, Supabase Auth treats these calls as admin calls and
// skips its own CAPTCHA check. So a CAPTCHA for sign-in, sign-up and reset must be verified by OUR server (the Turnstile
// siteverify call) before any of these functions is called, never through Supabase's built-in CAPTCHA setting.

const SECRET_KEY = /^sb_secret_[A-Za-z0-9_-]{10,200}$/;

/** The User-Agent of the forwarding client: a fixed non-browser value, because Supabase refuses a secret key with a browser one. */
export const FORWARDING_USER_AGENT = "mexuz-server";

type FallbackReason = "secret_key_not_set" | "secret_key_invalid" | "client_ip_invalid" | "secret_key_refused";

const loggedReasons = new Set<FallbackReason>();

/** The project's secret key, or why it cannot be used. Never logged or returned anywhere else. */
export function secretKeyState(raw: string | undefined): { key: string } | { reason: FallbackReason } {
  const key = raw?.trim();
  if (!key) return { reason: "secret_key_not_set" };
  if (!SECRET_KEY.test(key)) return { reason: "secret_key_invalid" };
  return { key };
}

/** The user's address from the proxy's headers (the rule of the keyed IP hash), or null unless it is a plain IPv4/IPv6 address. */
export function forwardableIp(requestHeaders: Headers): string | null {
  const ip = clientIp(requestHeaders)?.trim();
  if (!ip || ip.length > 45) return null;
  return isIP(ip) === 0 ? null : ip;
}

/** The headers the forwarding client sends: the user's address for Auth's rate limit and a fixed server User-Agent. */
export function forwardingHeaders(ip: string): Record<string, string> {
  return { "sb-forwarded-for": ip, "User-Agent": FORWARDING_USER_AGENT };
}

// Auth's own answers about the user or the request that may come as 401/403; anything else at 401/403 is the gateway
// refusing the key (it answers without an Auth error code, e.g. "Invalid API key" or the browser block).
const AUTH_OWN_CODES = new Set([
  "invalid_credentials",
  "email_not_confirmed",
  "phone_not_confirmed",
  "user_banned",
  "signup_disabled",
  "email_provider_disabled",
  "phone_provider_disabled",
  "provider_disabled",
  "captcha_failed",
  "over_request_rate_limit",
  "over_email_send_rate_limit",
  "user_already_exists",
  "email_exists",
  "weak_password",
  "validation_failed",
]);

/** True when an error is the gateway refusing the secret key (401/403 without one of Auth's own codes). */
export function keyRefused(error: { status?: number; code?: string } | null | undefined): boolean {
  if (!error || (error.status !== 401 && error.status !== 403)) return false;
  return !(error.code && AUTH_OWN_CODES.has(error.code));
}

async function note(reason: FallbackReason) {
  if (!loggedReasons.has(reason)) {
    loggedReasons.add(reason);
    await serverLog("warn", "auth.ip_forwarding_off", { reason });
  }
}

type Auth = Awaited<ReturnType<typeof createClient>>["auth"];

/** The forwarding Auth client of this request, or null (and why it is not used is logged). */
async function forwardingAuth(): Promise<Auth | null> {
  const state = secretKeyState(process.env.SUPABASE_SECRET_KEY);
  if ("reason" in state) {
    await note(state.reason);
    return null;
  }
  // read cookies first, as server.ts does: it marks the call as request-time
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const env = getSupabaseEnv();
  if (!env) throw new MissingConfigError();
  const ip = forwardableIp(requestHeaders);
  if (!ip) {
    await note("client_ip_invalid");
    return null;
  }
  const client = createServerClient<Database>(env.url, state.key, {
    global: { headers: forwardingHeaders(ip) },
    cookieOptions: SESSION_COOKIE,
    cookies: sessionCookieMethods(cookieStore),
  });
  return client.auth;
}

/**
 * Runs one Auth call through the forwarding client, else through the user's own client; a refusal of the key is retried
 * once through the user's own client. `forwarded` says which client's answer this is.
 */
async function run<R extends { error: { status?: number; code?: string } | null }>(call: (auth: Auth) => Promise<R>): Promise<{ result: R; forwarded: boolean }> {
  const forwarding = await forwardingAuth();
  if (forwarding) {
    const result = await call(forwarding);
    if (!keyRefused(result.error)) return { result, forwarded: true };
    await note("secret_key_refused");
  }
  return { result: await call((await createClient()).auth), forwarded: false };
}

/** signInWithPassword with the user's address forwarded; the session is then also the request's own client's. */
export async function forwardedSignIn(credentials: SignInWithPasswordCredentials): Promise<AuthTokenResponsePassword | { data: { user: null; session: null }; error: AuthError }> {
  const { result, forwarded } = await run((auth) => auth.signInWithPassword(credentials));
  if (!forwarded || result.error || !result.data.session) return result;
  const own = await createClient();
  const { error } = await own.auth.setSession({
    access_token: result.data.session.access_token,
    refresh_token: result.data.session.refresh_token,
  });
  if (error) {
    // the forwarding client already wrote the session cookies: end that session here, so nobody is left half signed in
    await own.auth.signOut({ scope: "local" });
    return { data: { user: null, session: null }, error };
  }
  return result;
}

/** signUp with the user's address forwarded (the code verifier and, without email confirmation, the session cookies as before). */
export async function forwardedSignUp(credentials: SignUpWithPasswordCredentials): Promise<AuthResponse> {
  return (await run((auth) => auth.signUp(credentials))).result;
}

/** resetPasswordForEmail with the user's address forwarded. */
export async function forwardedResetPassword(email: string, options: { redirectTo: string }) {
  return (await run((auth) => auth.resetPasswordForEmail(email, options))).result;
}
