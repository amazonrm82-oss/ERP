import "server-only";

import { choiceFromProfile, type ThemeChoice } from "@/features/theme/theme";
import { hasUnreadWhatsNew } from "@/features/whats-new/entries";
import { createClient } from "@/lib/supabase/server";

type FrameRow = { theme: string | null; whats_new_seen_on: string | null; guide_tour_seen_at: string | null };

export type FrameProfile = {
  // USR-07: the theme for a device with no theme cookie yet (null = the device already has one)
  syncTheme: ThemeChoice | null;
  // USR-12: the dot on "what's new"
  whatsNewUnread: boolean;
  // UX-05: when the person finished or skipped the first-visit tour (null = never)
  tourSeenAt: string | null;
};

/**
 * What the business frame reads from the person's own profile, in one read. Every part is cosmetic, so a failed read never
 * takes the frame down and each part falls back to its safe side: the theme by the device, no "what's new" dot, and the
 * tour counted as seen (it never pops up by mistake).
 */
export function frameProfileFrom(row: FrameRow | null, hasThemeCookie: boolean): FrameProfile {
  if (!row) return { syncTheme: hasThemeCookie ? null : "system", whatsNewUnread: false, tourSeenAt: "unknown" };
  return {
    syncTheme: hasThemeCookie ? null : choiceFromProfile(row.theme),
    whatsNewUnread: hasUnreadWhatsNew(row.whats_new_seen_on),
    tourSeenAt: row.guide_tour_seen_at,
  };
}

export async function getFrameProfile(userId: string, hasThemeCookie: boolean): Promise<FrameProfile> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("profiles").select("theme, whats_new_seen_on, guide_tour_seen_at").eq("id", userId).maybeSingle();
    return frameProfileFrom(error ? null : data, hasThemeCookie);
  } catch {
    return frameProfileFrom(null, hasThemeCookie);
  }
}
