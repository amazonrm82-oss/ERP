import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";

// OPS-05 (owner's answer (72) ב, 3 November 2026): GET /api/health for an external uptime monitor. It tells only that
// the site answers and that the database answers: one call of public.health_check() (answers true, reads nothing) with
// the anon key and no session, cookie or service key. Never an error text, a number or anything about a business.
// Cron runs and queue sizes belong to the platform screen, not here.

export const HEALTH_TIMEOUT_MS = 3000;

/** The one call the route makes; a stub replaces it in tests. */
export type HealthCall = (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>;

/** A plain anon client: no cookies, no stored session, no refresh; null when the site is not configured. */
export function anonHealthCall(): HealthCall | null {
  const env = getSupabaseEnv();
  if (!env) return null;
  const client = createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return (signal) => client.rpc("health_check").abortSignal(signal);
}

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } as const;

/** 200 {ok:true} only when the database answered true within the timeout; else 503 {ok:false}. */
export async function healthResponse(call: HealthCall | null, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Response> {
  const ok = call ? await answersTrue(call, timeoutMs) : false;
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 503, headers: HEADERS });
}

async function answersTrue(call: HealthCall, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  try {
    const answer = Promise.resolve(call(controller.signal)).then(
      ({ data, error }) => !error && data === true,
      () => false,
    );
    return await Promise.race([answer, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
