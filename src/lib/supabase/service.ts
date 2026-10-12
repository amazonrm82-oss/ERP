import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Supabase client with the service-role key: bypasses Row Level Security.
 * Allowed in exactly three places, none of which serves a signed-in user:
 * - the lead intake (src/features/intake), where a stranger's form submission
 *   arrives with no session. It only calls public.intake_submit() and reads a
 *   form's public settings by token;
 * - the push dispatcher (src/features/notifications/push-server.ts), woken by
 *   the database with a shared secret. It calls public.claim_push_notifications()
 *   and reads and prunes push_subscriptions;
 * - the file cleanup (src/features/files/cleanup-server.ts), woken by the
 *   database at night with the same secret. It calls public.claim_orphan_objects()
 *   and public.finish_orphan_files(), and removes those objects from the
 *   'record-files' bucket (files of deleted rows) or the 'avatars' bucket (photos
 *   of deleted accounts and replaced photos), and from no other bucket.
 * Never import this from code that serves a signed-in user.
 * Returns null when the key is not configured.
 */
export function createServiceClient(): SupabaseClient<Database> | null {
  const env = getSupabaseEnv();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!env || !key) {
    return null;
  }
  return createClient<Database>(env.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
