import "server-only";

import { SUBJECT_COLUMN, type TimelineSubject } from "@/features/activities/schema";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type FollowState = { following: boolean; count: number };

/**
 * REC-03: whether the user follows the record, and how many people follow it. RLS shows the
 * followers of a record the caller may read (and the caller's own rows).
 */
export async function getFollowState(orgId: string, subject: TimelineSubject, userId: string): Promise<FollowState> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("record_followers")
      .select("user_id")
      .eq("organization_id", orgId)
      .eq(SUBJECT_COLUMN[subject.kind], subject.id),
    "record followers",
  );
  return { following: rows.some((row) => row.user_id === userId), count: rows.length };
}
