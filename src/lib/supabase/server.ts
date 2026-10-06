import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv, MissingConfigError } from "@/lib/env";

// Server client for Server Components, Server Actions and Route Handlers.
// It carries the user's session (anon key + cookies), never a service-role key,
// so every query runs under Row Level Security as that user.
// Memoized per request so one render shares one client and one session read.
export const createClient = cache(async (): Promise<SupabaseClient<Database>> => {
  // Read cookies first: it marks the caller as request-time (dynamic), so a
  // build without the environment variables never tries to prerender it.
  const cookieStore = await cookies();
  const env = getSupabaseEnv();
  if (!env) {
    throw new MissingConfigError();
  }

  return createServerClient<Database>(env.url, env.anonKey, {
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
