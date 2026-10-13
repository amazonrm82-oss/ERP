"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { keptSampleMessage } from "./checklist";

const sampleRemoveResult = z.object({ removed: z.number().int().min(0), kept: z.number().int().min(0) });

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/** Every page may show sample records, and the home page shows the checklist. */
function refreshOrg(orgId: string) {
  revalidatePath(paths.org(orgId), "layout");
}

/** Closes the setup checklist on the home page (hidden = true), or shows it again. Owners and admins (RLS). */
export async function setChecklistHiddenAction(orgId: string, hidden: boolean): Promise<ActionResult> {
  if (!validArg(z.boolean(), hidden)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("organizations")
    .update({ setup_checklist_hidden_at: hidden ? new Date().toISOString() : null })
    .eq("id", orgId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, SAVE_FAILED));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  refreshOrg(orgId);
  return ok();
}

/** Adds the sample data (one call; owners and admins of a writable business, checked by the function). */
export async function addSampleDataAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { error } = await context.supabase.rpc("sample_data_add", { p_org: orgId });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף נתוני דוגמה. נסו שוב."));
  }
  refreshOrg(orgId);
  return ok(undefined, "נתוני הדוגמה נוספו. אפשר למחוק אותם בכל רגע.");
}

/**
 * Removes the sample data in one click: one database call that locks the
 * sample records, checks each one again and deletes only those nobody changed,
 * merged into or linked to (public.sample_data_remove; owners and admins of a
 * writable business). Real records are never touched.
 */
export async function removeSampleDataAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.rpc("sample_data_remove", { p_org: orgId });
  refreshOrg(orgId);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק את נתוני הדוגמה. נסו שוב."));
  }
  const result = sampleRemoveResult.safeParse(data);
  const kept = result.success ? result.data.kept : 0;
  const removed = result.success ? result.data.removed : 0;
  if (removed === 0 && kept === 0) {
    return ok(undefined, "אין נתוני דוגמה למחיקה.");
  }
  if (removed === 0) {
    return ok(undefined, keptSampleMessage(kept));
  }
  return ok(undefined, kept > 0 ? `נתוני הדוגמה נמחקו. ${keptSampleMessage(kept)}` : "נתוני הדוגמה נמחקו.");
}
