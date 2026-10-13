"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, type ActionResult } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { takeMessage } from "./take";
import { takeLead } from "./take-server";

/** "לקחתי" from the short screen or the waiting list (SPD-01). The message says what happened either way. */
export async function takeLeadAction(orgId: string, leadId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, leadId);
  if (!context.ok) return context;
  const answer = await takeLead(context.supabase, orgId, leadId);
  if (!answer.ok) return fail(answer.message);
  revalidatePath(paths.leadsWaiting(orgId));
  revalidatePath(paths.lead(orgId, leadId));
  revalidatePath(paths.leadRespond(orgId, leadId));
  return answer.outcome.ok ? { ok: true, message: takeMessage(answer.outcome) } : fail(takeMessage(answer.outcome));
}
