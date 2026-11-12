import "server-only";

import { createClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";

import { PUBLIC_READ_BACKOFF_MS, withBackoff } from "@/features/platform/subprocessors";
import { PLANS_PUBLIC_CACHE_TAG, publicPlansOrThrow, type PublicPlan } from "@/features/plans/public-plans";
import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";
import { logEvent } from "@/lib/log";

/**
 * LND-13 / WEB-01 (owner, 11 November 2026): the landing page's price list reads public.plans_public() with a plain anon
 * client (no session, no cookie, never the service key): the public fields of available and coming-soon plans only. No
 * visitor input reaches it. The answer is cached for an hour (tag plans-public, expired by the platform's plan actions); a
 * failed read (error, missing configuration, another shape) throws inside the cache, so it is never cached, and holds
 * further reads for a minute in this server instance; the page then shows the section without prices.
 */
const readCached = unstable_cache(
  async (): Promise<PublicPlan[]> => {
    const env = getSupabaseEnv();
    if (!env) throw new Error("plans_public: site not configured");
    const client = createClient<Database>(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.rpc("plans_public");
    if (error) throw new Error(`plans_public failed: ${error.code ?? ""}`);
    return publicPlansOrThrow(data);
  },
  ["plans-public"],
  { revalidate: 3600, tags: [PLANS_PUBLIC_CACHE_TAG] },
);

/** One log line for a failed read: our own short reason only (codes, never a key, a URL or a body). */
function failureLine(error: unknown): string {
  const reason = error instanceof Error ? error.message.replace(/[^\w :.-]/g, "").slice(0, 120) : "unknown";
  return `plans public read failed, showing the price list without prices: ${reason}`;
}

/** The plans to show, or null when they cannot be read. */
export const readPublicPlans = withBackoff(readCached, PUBLIC_READ_BACKOFF_MS, Date.now, (error) => {
  // logEvent, not serverLog: outside a request (prerendering) the request headers cannot be read
  logEvent("error", "plans_public.read_failed", { details: failureLine(error) });
});
