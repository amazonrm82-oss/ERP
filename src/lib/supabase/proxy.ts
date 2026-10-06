import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";
import { safeNextPath } from "@/lib/paths";

const AUTH_PAGES = ["/login", "/signup"];

function isPublicPath(pathname: string): boolean {
  return AUTH_PAGES.includes(pathname) || pathname.startsWith("/auth/");
}

// Runs on every matched request: refreshes the Supabase session cookies and
// applies the optimistic auth redirects. This is a convenience, not the
// security boundary: pages and Server Actions re-check the user, and RLS
// enforces access in the database.
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const env = getSupabaseEnv();
  if (!env) {
    // Not configured: let the request through, the root layout explains.
    return response;
  }

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
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

  let isSignedIn = false;
  try {
    // Validates the JWT (and refreshes it when expired). Must run before any
    // response is produced so refreshed cookies can still be written.
    const { data } = await supabase.auth.getClaims();
    isSignedIn = Boolean(data?.claims?.sub);
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
