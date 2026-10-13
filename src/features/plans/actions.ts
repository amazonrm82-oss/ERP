"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

const planKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/** "עדכנו אותי כשזה זמין": the person asks to hear when a coming-soon plan opens. */
export async function joinPlanWaitlistAction(orgId: string, key: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  if (!validArg(planKey, key)) return fail(INVALID_ARGS);
  const { error } = await context.supabase.from("plan_waitlist").insert({ organization_id: orgId, plan_key: key });
  // asked before: already on the list
  if (error && error.code !== "23505") {
    return fail(error.code === "42501" ? "אפשר להירשם רק לחבילה שתיפתח בקרוב." : dbErrorMessage(error));
  }
  revalidatePath(paths.settingsPlan(orgId));
  return { ok: true };
}
