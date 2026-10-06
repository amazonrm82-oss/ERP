import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv, MissingConfigError } from "@/lib/env";

// Browser client: anon key + the signed-in user's session from cookies.
// createBrowserClient keeps a singleton, so calling this repeatedly is cheap.
export function createClient(): SupabaseClient<Database> {
  const env = getSupabaseEnv();
  if (!env) {
    throw new MissingConfigError();
  }
  return createBrowserClient<Database>(env.url, env.anonKey);
}
