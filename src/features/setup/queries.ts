import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isSetupStep, type SetupStep } from "./steps";

/** The next step of the organization's setup wizard, or null when it is finished (or the row is not visible). */
export async function getSetupStep(orgId: string): Promise<SetupStep | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("organizations").select("setup_step").eq("id", orgId).maybeSingle(),
    "organizations.setup_step",
  );
  const step = row?.setup_step ?? null;
  return isSetupStep(step) ? step : null;
}
