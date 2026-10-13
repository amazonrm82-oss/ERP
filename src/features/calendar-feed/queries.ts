import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type CalendarFeedStatus = { active: boolean; createdAt: string | null; lastUsedAt: string | null };

/** CAL-07: whether the user has a personal calendar link in this business (the link itself is never stored). */
export async function getCalendarFeedStatus(orgId: string): Promise<CalendarFeedStatus> {
  const supabase = await createClient();
  const raw = must(await supabase.rpc("calendar_feed_status", { p_org: orgId }), "calendar feed status") as {
    active?: boolean;
    created_at?: string | null;
    last_used_at?: string | null;
  } | null;
  return { active: raw?.active === true, createdAt: raw?.created_at ?? null, lastUsedAt: raw?.last_used_at ?? null };
}
