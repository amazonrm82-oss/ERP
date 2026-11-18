import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isTransientAuthError, logSessionCheckThrow } from "@/lib/auth-transient";
import { REQUEST_ID_HEADER, requestIdFor } from "@/lib/request-id";
import { PATH_HEADER } from "@/features/theme/theme";
import { contentSecurityPolicy, isEmbeddablePublicPath, makeNonce } from "@/lib/csp";
import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";
import { safeNextPath } from "@/lib/paths";
import { MONITORING_USER_HEADER, monitoringUserHeaderValue } from "@/lib/monitoring/request-identity";
import { isCustomerPagePath, sentryConfigured, sentryIngestOrigin } from "@/lib/monitoring/sentry-rules";

const AUTH_PAGES = ["/login", "/signup", "/forgot-password"];

// the session cookies are sent only over HTTPS in production (FXS-05)
export const SESSION_COOKIE = { secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };

// Reached without a session: sign-in pages, auth callbacks, the lead intake
// (public forms and webhooks), the push dispatcher (called by the database with
// a secret), the file cleanup and the job worker (same), the Meta Lead Ads webhook (CAP-11), the uptime check, the service worker, the offline page, the app manifest, the help
// center, the legal documents, and robots.txt / sitemap.xml for search engines (LND-11).
// Reached without a session at exactly these paths (no prefix match: /api/healthz or /api/health/x stay private).
// OPS-05: the uptime check (external monitor, no session); answers only ok or not ok.
// LND-20 v2: the public list of everything the system does (the landing page links to it).
// VRT-02: the marketing page of each industry kit.
// LND-14: the landing page's sign-up link, which counts the press and sends the visitor to /signup.
const PUBLIC_EXACT = ["/api/health", "/go/signup", "/features", "/industries/clinic", "/industries/studio"];

const PUBLIC_PREFIXES = [
  "/auth/",
  "/f/",
  "/api/forms/",
  "/api/in/",
  "/api/push/dispatch",
  "/api/files/cleanup",
  // OPS-04: the background job worker, woken by the database with the same secret
  "/api/jobs/run",
  // CAP-11: the Meta Lead Ads webhook (its own signature check) and its sweep (the shared secret)
  "/api/meta/leads",
  // SMS-05: InforU's delivery reports and replies (the secret is the last path segment, checked first)
  "/api/sms/inforu/",
  // LNK-04: the payment provider's webhook (its own signature check, before the database)
  "/api/payments/",
  // CAL-07: calendar apps fetch the personal feed with no session; the route checks its own secret token
  "/api/calendar-feed/",
  "/sw.js",
  "/offline.html",
  "/manifest.webmanifest",
  "/robots.txt",
  "/sitemap.xml",
  "/help",
  "/legal/",
];

/** Whether a page's policy allows Cloudflare Turnstile: the site key is set and the page is not a customer page under /f/. */
export function turnstileAllowed(pathname: string, siteKey: string | undefined): boolean {
  return Boolean(siteKey?.trim()) && !pathname.startsWith("/f/") && pathname !== "/f";
}

export function isPublicPath(pathname: string): boolean {
  // "/" is the public landing page (LND-01)
  return (
    pathname === "/" ||
    AUTH_PAGES.includes(pathname) ||
    PUBLIC_EXACT.includes(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

// Runs on every matched request: refreshes the Supabase session cookies and
// applies the optimistic auth redirects. This is a convenience, not the
// security boundary: pages and Server Actions re-check the user, and RLS
// enforces access in the database.
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const env = getSupabaseEnv();
  // A fresh nonce for every page view (FXS-05): Next.js reads it from the request's
  // Content-Security-Policy header and puts it on the scripts it renders.
  const csp = contentSecurityPolicy({
    nonce: makeNonce(),
    supabaseUrl: env?.url ?? null,
    isDev: process.env.NODE_ENV === "development",
    publicForm: isEmbeddablePublicPath(request.nextUrl.pathname),
    // owner (275) א: Turnstile's script and frame, only while its site key is set, on every page of the app but the customer
    // pages under /f/. Not only the three forms that render it: the policy is the one of the document first loaded, and the
    // forms are often reached by a client-side navigation (a link from the landing page, the redirect after signing out), which
    // keeps that document's policy; a policy on the three pages alone would block the widget there.
    turnstile: turnstileAllowed(request.nextUrl.pathname, process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
    // OPS-05: the browser may send error events to Sentry's ingest host of the DSN, only where Sentry may load at all
    sentryOrigin: sentryConnectOrigin(request.nextUrl.pathname),
  });
  // OPS-06: one id per request for the server log lines (Vercel's x-vercel-id when valid, else a new one); always set
  // here, so a visitor's own x-crm-request-id never counts
  const requestId = requestIdFor(request.headers);
  // OPS-05: the signed-in user's id for a server error's monitoring event (set after Auth answered; a visitor's own header
  // never counts, so it is always removed first)
  let monitoringUser: string | null = null;
  // the session cookies and no-store headers Auth asked for, kept so the response can be built again with the user header
  let sessionCookies: { name: string; value: string; options: Parameters<NextResponse["cookies"]["set"]>[2] }[] = [];
  let sessionHeaders: Record<string, string> = {};
  // the request as the page sees it: the current cookies, plus the policy
  const next = () => {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", csp);
    headers.set(REQUEST_ID_HEADER, requestId);
    headers.delete(MONITORING_USER_HEADER);
    if (monitoringUser) headers.set(MONITORING_USER_HEADER, monitoringUser);
    // USR-07: the root layout keeps customer-facing pages light; set here, so a visitor's own header never counts
    headers.set(PATH_HEADER, request.nextUrl.pathname);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };
  // the response with the session cookies and headers Auth set
  const withSession = () => {
    const res = next();
    for (const { name, value, options } of sessionCookies) {
      res.cookies.set(name, value, options);
    }
    // no-store headers: a refreshed session must never be cached by a CDN
    for (const [key, value] of Object.entries(sessionHeaders)) {
      res.headers.set(key, value);
    }
    return res;
  };
  let response = next();

  if (!env) {
    // Not configured: let the request through, the root layout explains.
    return response;
  }

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookieOptions: SESSION_COOKIE,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        sessionCookies = cookiesToSet;
        sessionHeaders = headers;
        response = withSession();
      },
    },
  });

  // Two-step verification is not checked here: the database refuses organization
  // data to a session that owes the code (app.membership_role), and the pages
  // send such a user to /login/mfa (getOrgContext, the root page, reset-password).
  let isSignedIn = false;
  // FXC-10: the auth server did not answer (network, 5xx, rate limit). That says nothing about the session, so
  // nobody is sent to the login page for it: the request goes on as it is, the pages check the session themselves
  // (and show "communication problem" if they cannot either), and the database still checks every token.
  let authUnavailable = false;
  try {
    // Asks the auth server, so a session that was signed out elsewhere ("sign out
    // the other devices", or turning on two-step verification) ends on the next page
    // load instead of when its token expires. Refreshes an expired token too, and must
    // run before any response is produced so refreshed cookies can still be written.
    const { data, error } = await supabase.auth.getUser();
    isSignedIn = !error && Boolean(data.user?.id);
    // OPS-05: only while Sentry is set up on the server, and never on a public page
    if (isSignedIn && sentryConfigured(process.env.SENTRY_DSN, process.env.VERCEL_ENV)) {
      monitoringUser = monitoringUserHeaderValue(data.user?.id, isPublicPath(request.nextUrl.pathname));
      if (monitoringUser) response = withSession();
    }
    authUnavailable = error !== null && isTransientAuthError(error);
  } catch (error) {
    isSignedIn = false;
    authUnavailable = isTransientAuthError(error);
    logSessionCheckThrow("proxy", error, requestId);
  }

  if (authUnavailable) {
    return response;
  }

  const { pathname, search } = request.nextUrl;

  if (!isSignedIn && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname !== "/") {
      url.searchParams.set("next", pathname + search);
    }
    return redirectKeepingCookies(url, response);
  }

  // a signed-in visitor of the landing page goes straight into the app (LND-06);
  // decided here, so the landing page itself stays the same for everyone
  if (isSignedIn && pathname === "/") {
    return redirectKeepingCookies(new URL("/app", request.url), response);
  }

  if (isSignedIn && AUTH_PAGES.includes(pathname)) {
    const target = safeNextPath(request.nextUrl.searchParams.get("next"));
    return redirectKeepingCookies(new URL(target, request.url), response);
  }

  return response;
}

/** The Sentry ingest origin the CSP allows: production with a browser DSN, and never on a public customer page. */
export function sentryConnectOrigin(pathname: string): string | null {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!sentryConfigured(dsn, process.env.VERCEL_ENV) || isCustomerPagePath(pathname)) return null;
  return sentryIngestOrigin(dsn);
}

function redirectKeepingCookies(url: URL, from: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);
  for (const cookie of from.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}
