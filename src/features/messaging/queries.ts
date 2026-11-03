import "server-only";

import type { TimelineItem } from "@/features/activities/queries";
import type { TimelineFilterKey, TimelineSubject } from "@/features/activities/schema";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { MESSAGE_TIMELINE_TYPE, messageEntryLabel, messageEntryText } from "./timeline-entry";

export { mergeTimeline } from "./timeline-entry";

export const MESSAGES_ON_TIMELINE = 50;

/**
 * MSG-03: the messages of a lead or contact as read-only timeline entries (newest 50), read with the user's session: the
 * messages_select policy shows them to whoever reads the record. Shown under "הכול" and "הודעות" only.
 */
export async function messageTimelineItems(orgId: string, subject: TimelineSubject, filter: TimelineFilterKey): Promise<TimelineItem[]> {
  if ((subject.kind !== "lead" && subject.kind !== "contact") || (filter !== "all" && filter !== "message")) return [];
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("messages")
      .select("id, channel, direction, status, provider, provider_error_code, occurred_at, created_at")
      .eq("organization_id", orgId)
      .eq(subject.kind === "lead" ? "lead_id" : "contact_id", subject.id)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MESSAGES_ON_TIMELINE),
    "timeline messages",
  );
  return rows.map((row) => ({
    id: `message-${row.id}`,
    type: MESSAGE_TIMELINE_TYPE,
    label: messageEntryLabel(row),
    icon: null,
    text: messageEntryText(row),
    isUserContent: false,
    body: "",
    occurredAt: row.occurred_at,
    authorName: null,
    createdBy: null,
    createdAt: row.created_at,
    pinned: false,
    isPrivate: false,
    chatImport: false,
    shareNote: false,
  }));
}
