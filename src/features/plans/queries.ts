import "server-only";

import type { PlanRow } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type PlanCard = PlanRow & { current: boolean; waiting: boolean };

/**
 * The plans a business sees on its plan page: available and coming soon, plus its
 * own plan whatever its state; with the person's own "עדכנו אותי" requests.
 */
export async function listPlanCards(orgId: string, currentPlanKey: string | null): Promise<PlanCard[]> {
  const supabase = await createClient();
  const plans = must(await supabase.from("plans").select("*").order("position"), "plans");
  const waiting = must(await supabase.from("plan_waitlist").select("plan_key").eq("organization_id", orgId), "plan_waitlist");
  const asked = new Set(waiting.map((row) => row.plan_key));
  return plans
    .filter((plan) => plan.availability !== "hidden" || plan.key === currentPlanKey)
    .map((plan) => ({ ...plan, current: plan.key === currentPlanKey, waiting: asked.has(plan.key) }));
}
