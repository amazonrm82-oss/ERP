import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { contentSecurityPolicy, makeNonce } from "@/lib/csp";
import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";
import { safeNextPath } from "@/lib/paths";

const AUTH_PAGES = ["/login", "/signup", "/forgot-password"];

// the session cookies are sent only over HTTPS in production (FXS-05)
export const SESSION_COOKIE = { secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };

// Reached without a session: sign-in pages, auth callbacks, the lead intake
// (public forms and webhooks), the push dispatcher (called by the database with
// a secret), the file cleanup (same), the service worker, the offline page, the app manifest, the help
// center and the legal documents.
const PUBLIC_PREFIXES = [
  "/auth/",
  "/f/",
  "/api/forms/",
  "/api/in/",
  "/api/push/dispatch",
  "/api/files/cleanup",
  "/sw.js",
  "/offline.html",
  "/manifest.webmanifest",
  "/help",
  "/legal/",
];

function isPublicPath(pathname: string): boolean {
  return AUTH_PAGES.includes(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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
    publicForm: request.nextUrl.pathname.startsWith("/f/"),
  });
  // the request as the page sees it: the current cookies, plus the policy
  const next = () => {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", csp);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", csp);
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
        response = next();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // no-store headers: a refreshed session must never be cached by a CDN
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Two-step verification is not checked here: the database refuses organization
  // data to a session that owes the code (app.membership_role), and the pages
  // send such a user to /login/mfa (getOrgContext, the root page, reset-password).
  let isSignedIn = false;
  try {
    // Asks the auth server, so a session that was signed out elsewhere ("sign out
    // the other devices", or turning on two-step verification) ends on the next page
    // load instead of when its token expires. Refreshes an expired token too, and must
    // run before any response is produced so refreshed cookies can still be written.
    const { data, error } = await supabase.auth.getUser();
    isSignedIn = !error && Boolean(data.user?.id);
  } catch {
    isSignedIn = false;
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

  if (isSignedIn && AUTH_PAGES.includes(pathname)) {
    const target = safeNextPath(request.nextUrl.searchParams.get("next"));
    return redirectKeepingCookies(new URL(target, request.url), response);
  }

  return response;
}

function redirectKeepingCookies(url: URL, from: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);
  for (const cookie of from.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}
