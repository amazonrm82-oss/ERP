import "server-only";

import type { TimelineSubject } from "@/features/activities/schema";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { MentionCandidate } from "./token";

export type { MentionCandidate };

/**
 * REC-02: the people a note on this record may mention: active members of the organization who
 * may see the record, without the caller (public.mention_candidates). The database checks every
 * mention again when the note is saved.
 */
export async function getMentionCandidates(orgId: string, subject: TimelineSubject): Promise<MentionCandidate[]> {
  const supabase = await createClient();
  const rows = must(await supabase.rpc("mention_candidates", { p_org: orgId, p_kind: subject.kind, p_id: subject.id }), "mention candidates");
  return (rows ?? []).map((row) => ({ id: row.user_id, name: row.name }));
}
