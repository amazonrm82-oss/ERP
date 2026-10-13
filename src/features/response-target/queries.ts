import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { responseSettingsFrom, type ResponseSettings } from "./settings";

/** The business's response target and breach action (CAP-10); members read it, no row = the defaults. */
export const getResponseSettings = cache(async (orgId: string): Promise<ResponseSettings> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("lead_response_settings").select("target_minutes, breach_action, max_passes").eq("organization_id", orgId).maybeSingle(),
    "lead response settings",
  );
  return responseSettingsFrom(row);
});
