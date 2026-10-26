import "server-only";

import { unstable_cache } from "next/cache";

import {
  PUBLIC_READ_BACKOFF_MS,
  publicListOrThrow,
  publicReadFailureLine,
  SUBPROCESSORS_CACHE_TAG,
  withBackoff,
  type Subprocessor,
} from "@/features/platform/subprocessors";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * ADM-01 (owner, 26 October 2026, answer (ב)): the public subprocessors page reads the live list with the service key,
 * through public.subprocessors_public_page() only (service_role only, no arguments, public fields of live entries).
 * No input from the visitor reaches it. Rate limits: the result is cached for an hour (and dropped when the platform
 * owner changes the list); the database function itself answers at most 60 reads a minute in total; and a failed read
 * (error, refusal, missing key) is not cached and holds further reads for a minute in this server instance.
 */
const readCached = unstable_cache(
  async (): Promise<{ entries: Subprocessor[]; updatedOn: string | null }> => {
    const service = createServiceClient();
    if (!service) throw new Error("subprocessors: service key not configured");
    const { data, error } = await service.rpc("subprocessors_public_page");
    if (error) throw new Error(`subprocessors_public_page failed: ${error.code ?? ""}`);
    return publicListOrThrow(data);
  },
  ["subprocessors-public-page"],
  { revalidate: 3600, tags: [SUBPROCESSORS_CACHE_TAG] },
);

/** The live list, or null when it cannot be read (the page then shows the static list of the legal version). */
// a failure is logged once per back-off window (a missing service key shows up in the logs), never with a secret or a body
export const readPublicSubprocessors = withBackoff(readCached, PUBLIC_READ_BACKOFF_MS, Date.now, (error) => {
  console.error(publicReadFailureLine(error));
});
