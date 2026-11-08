import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { DEFAULT_WINDOW_FROM, DEFAULT_WINDOW_UNTIL, shortTime, type SendingHours } from "./hours";

/** MSG-06: the business's sending hours; members read them, no row = 08:00-20:00 with rest days off. */
export const getSendingHours = cache(async (orgId: string): Promise<SendingHours> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_message_settings").select("window_from, window_until, skip_rest_days").eq("organization_id", orgId).maybeSingle(),
    "message settings",
  );
  return {
    from: shortTime(row?.window_from, DEFAULT_WINDOW_FROM),
    until: shortTime(row?.window_until, DEFAULT_WINDOW_UNTIL),
    skipRestDays: row?.skip_rest_days ?? true,
  };
});
