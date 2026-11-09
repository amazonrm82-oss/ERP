import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { meetingOrderDraftModeOf, parseDraftStates, type MeetingOrderDraftMode, type MeetingOrderDraftState } from "./rules";

/** CAL-13: whether a held meeting's draft order is made by the button (default) or by itself. */
export async function getMeetingOrderDraftMode(orgId: string): Promise<MeetingOrderDraftMode> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select("meeting_order_draft").eq("organization_id", orgId).maybeSingle(),
    "meeting order draft mode",
  );
  return meetingOrderDraftModeOf(row?.meeting_order_draft);
}

// public.meeting_order_draft_states takes at most 200 ids a call
const STATES_CHUNK = 200;

/**
 * CAL-13: per meeting the user may see that is held or has a draft, the draft order made from it (an id the user reads)
 * or why none can be made. Meetings that are neither get no entry. Asked in chunks of 200, never cut.
 */
export async function listMeetingOrderDraftStates(orgId: string, meetingIds: string[]): Promise<Map<string, MeetingOrderDraftState>> {
  const ids = [...new Set(meetingIds)];
  const out = new Map<string, MeetingOrderDraftState>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  for (let start = 0; start < ids.length; start += STATES_CHUNK) {
    const chunk = ids.slice(start, start + STATES_CHUNK);
    const value = must(await supabase.rpc("meeting_order_draft_states", { p_org: orgId, p_meetings: chunk }), "meeting order draft states");
    for (const [id, state] of parseDraftStates(value)) out.set(id, state);
  }
  return out;
}
