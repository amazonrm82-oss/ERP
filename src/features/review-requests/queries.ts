import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { REVIEW_REQUEST_DEFAULTS, type ReviewRequestSettings } from "./review-url";

/** RET-02: the business's review request settings, read with the user's session (members read); no row = the defaults. */
export const getReviewRequestSettings = cache(async (orgId: string): Promise<ReviewRequestSettings> => {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("review_request_settings")
      .select("enabled, review_url, on_deal_won, on_meeting_held, delay_days")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "review request settings",
  );
  if (!row) return REVIEW_REQUEST_DEFAULTS;
  return {
    enabled: row.enabled,
    reviewUrl: row.review_url,
    onDealWon: row.on_deal_won,
    onMeetingHeld: row.on_meeting_held,
    delayDays: row.delay_days,
  };
});

/** RET-02 review (8): whether the business has an active review request template (the system's own, marked) to send from. */
export const hasActiveReviewTemplate = cache(async (orgId: string): Promise<boolean> => {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("message_templates")
      .select("id")
      .eq("organization_id", orgId)
      .eq("notice_kind", "review_request")
      .eq("is_active", true)
      .limit(1),
    "review request templates",
  );
  return rows.length > 0;
});
