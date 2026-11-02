import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { NOT_PAUSED, pauseFromRow, type SendingPause } from "./pause";

const COLUMNS = "paused, reason, paused_at, paused_by, resumed_at, resumed_by";

/** HEB-09: the business's pause, read with the user's session (members read it). A failed read throws (the settings page). */
export async function getSendingPause(orgId: string): Promise<SendingPause> {
  const supabase = await createClient();
  const row = must(await supabase.from("org_sending_pauses").select(COLUMNS).eq("organization_id", orgId).maybeSingle(), "sending pause");
  return pauseFromRow(row);
}

/**
 * The banner's read: once per request, and a failed read shows no banner (the business shell never breaks over it;
 * the pause itself is enforced in the database, not by the banner).
 */
export const getSendingPauseQuiet = cache(async (orgId: string): Promise<SendingPause> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("org_sending_pauses").select(COLUMNS).eq("organization_id", orgId).maybeSingle();
    return error ? NOT_PAUSED : pauseFromRow(data);
  } catch {
    return NOT_PAUSED;
  }
});
