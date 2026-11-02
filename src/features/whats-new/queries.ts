import "server-only";

import { createClient } from "@/lib/supabase/server";

import { hasUnreadWhatsNew } from "./entries";

/**
 * USR-12: does the person have "what's new" entries they have not opened? Cosmetic: a failed read shows no dot and
 * never takes the business shell down.
 */
export async function getWhatsNewUnread(userId: string): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("profiles").select("whats_new_seen_on").eq("id", userId).maybeSingle();
    if (error || !data) return false;
    return hasUnreadWhatsNew(data.whats_new_seen_on);
  } catch {
    return false;
  }
}
