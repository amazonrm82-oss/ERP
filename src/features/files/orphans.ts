import { LOGOS_BUCKET } from "@/features/branding/logo";
import { AVATARS_BUCKET } from "@/features/profile/avatar";

import { FILES_BUCKET } from "./types";

/**
 * The only buckets the nightly cleanup removes objects from: record files, profile photos (USR-01) and business logos
 * that are no longer in use (FLD-04, owner 14 October 2026). A bucket name that arrives from the database is checked
 * against this list, never used as given.
 */
export const CLEANUP_BUCKETS = [FILES_BUCKET, AVATARS_BUCKET, LOGOS_BUCKET] as const;
export type CleanupBucket = (typeof CLEANUP_BUCKETS)[number];

export function isCleanupBucket(value: unknown): value is CleanupBucket {
  return typeof value === "string" && (CLEANUP_BUCKETS as readonly string[]).includes(value);
}

/**
 * Groups the answer of public.claim_orphan_objects() ([{bucket, path}]) by bucket.
 * Entries with a bucket outside the allow-list, or that are not well formed, are
 * left out: they are not removed and not reported done, so they stay visible in
 * the queue.
 */
export function groupOrphans(data: unknown): Map<CleanupBucket, string[]> {
  const groups = new Map<CleanupBucket, string[]>();
  if (!Array.isArray(data)) return groups;
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const { bucket, path } = entry as { bucket?: unknown; path?: unknown };
    if (!isCleanupBucket(bucket) || typeof path !== "string" || path === "") continue;
    const list = groups.get(bucket) ?? [];
    list.push(path);
    groups.set(bucket, list);
  }
  return groups;
}
