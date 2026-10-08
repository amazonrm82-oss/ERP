import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv, MissingConfigError } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/supabase/proxy";

// Server client for Server Components, Server Actions and Route Handlers.
// It carries the user's session (anon key + cookies), never a service-role key,
// so every query runs under Row Level Security as that user.
// Memoized per request so one render shares one client and one session read.
export const createClient = cache(async (): Promise<SupabaseClient<Database>> => {
  // Read cookies first: it marks the caller as request-time (dynamic), so a
  // build without the environment variables never tries to prerender it.
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const env = getSupabaseEnv();
  if (!env) {
    throw new MissingConfigError();
  }

  // Sign-in and sign-up happen here, on the server: pass on the browser's user agent and
  // address so Supabase Auth records the user's device (devices list, login log) and
  // rate-limits per user rather than per server. Vercel sets x-forwarded-for itself.
  const forwarded: Record<string, string> = {};
  const userAgent = requestHeaders.get("user-agent");
  const clientIp = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip");
  if (userAgent) forwarded["User-Agent"] = userAgent.slice(0, 400);
  if (clientIp) forwarded["X-Forwarded-For"] = clientIp;

  return createServerClient<Database>(env.url, env.anonKey, {
    global: { headers: forwarded },
    cookieOptions: SESSION_COOKIE,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. The proxy refreshes the
          // session on every request, so it is safe to skip the write here.
        }
      },
    },
  });
});
