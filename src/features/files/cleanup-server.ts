import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createServiceClient } from "@/lib/supabase/service";

import { FILES_BUCKET } from "./types";

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Called by the database (app.cleanup_files, through pg_net) at night. Not a user
 * request: it carries the shared secret of the push dispatcher, and uses the
 * service role only to claim paths of deleted file rows and remove those objects.
 */
export async function cleanupFiles(request: Request): Promise<Response> {
  const secret = process.env.PUSH_DISPATCH_SECRET?.trim();
  const supabase = createServiceClient();
  if (!secret || !supabase) return json(503, { error: "cleanup is not configured" });
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), secret)) return json(401, { error: "unauthorized" });

  let removed = 0;
  for (let round = 0; round < 10; round++) {
    const { data, error } = await supabase.rpc("claim_orphan_files", { p_limit: 500 });
    if (error) return json(500, { error: "claim failed", removed });
    const paths = Array.isArray(data) ? data.filter((p): p is string => typeof p === "string") : [];
    if (paths.length === 0) break;
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      // an object that is already gone counts as done
      const { error: removeError } = await supabase.storage.from(FILES_BUCKET).remove(chunk);
      if (removeError) continue; // claimed again in an hour
      await supabase.rpc("finish_orphan_files", { p_paths: chunk });
      removed += chunk.length;
    }
  }
  return json(200, { removed });
}
