import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { anomalySettingsFromRow, type AnomalyAlertSettings } from "./settings";

/** MNY-04 (285) ג: the business's switches and numbers; members read them, no row = the defaults. */
export const getAnomalyAlertSettings = cache(async (orgId: string): Promise<AnomalyAlertSettings> => {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("anomaly_alert_settings")
      .select("lead_drop_on, lead_drop_percent, idle_rep_on, idle_rep_days, quiet_form_on, quiet_form_min_inquiries, campaign_jump_on, campaign_jump_percent")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "anomaly alert settings",
  );
  return anomalySettingsFromRow(row);
});
