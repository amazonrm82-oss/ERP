"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";
import { z } from "zod";

import { MANUAL_ENTITIES, manualRunResult } from "./manual";

/** AUT-03: runs one manual rule on one record from its card. */
export async function runManualAutomationAction(
  orgId: string,
  automationId: string,
  entity: string,
  recordId: string,
): Promise<ActionResult> {
  if (!validArg(z.enum(MANUAL_ENTITIES), entity)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, automationId, recordId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.rpc("run_manual_automation", { p_org: orgId, p_automation: automationId, p_record: recordId });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להפעיל את האוטומציה. נסו שוב."));
  }
  const result = manualRunResult(data);
  if (!result.ok) {
    return fail(result.message);
  }
  revalidatePath(recordPage(entity, orgId, recordId));
  return { ok: true, message: result.message };
}
