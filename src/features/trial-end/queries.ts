import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseTrialEndNotice, type TrialEndNotice } from "./notice";

/** The business's trial-end phase for a member, or null. Memoized per request (layout + page). */
export const getTrialEndNotice = cache(async (orgId: string): Promise<TrialEndNotice | null> => {
  const supabase = await createClient();
  return parseTrialEndNotice(must(await supabase.rpc("trial_end_notice", { p_org: orgId }), "trial_end_notice"));
});
