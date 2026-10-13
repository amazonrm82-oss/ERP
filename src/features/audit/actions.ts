"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { ERASURE_PAUSED, ERASURE_PAUSED_MESSAGE } from "./erasure";

const TYPES = ["leads", "contacts", "companies", "deals"] as const;

/**
 * A privacy request: erases a permanently deleted record's details from the audit
 * log (and the copies kept by a merge or a lead form). Owners and admins; the
 * database checks it and refuses a record that still exists.
 */
export async function eraseFromAuditAction(orgId: string, entityType: string, entityId: string, personRequest: boolean): Promise<ActionResult> {
  if (!(TYPES as readonly string[]).includes(entityType)) {
    return fail(NOT_FOUND);
  }
  if (!validArg(booleanArg, personRequest)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, entityId);
  if (!context.ok) {
    return context;
  }
  // the person's own request records "do not contact" for their phone and email (owner, 13 October 2026)
  const { data, error } = await context.supabase.rpc("audit_erase_request", {
    p_org: orgId,
    p_type: entityType,
    p_id: entityId,
    p_person_request: personRequest,
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק את הפרטים. נסו שוב."));
  }
  revalidatePath(paths.settingsAudit(orgId));
  if (data === ERASURE_PAUSED) {
    // shown next to the button (ActionButton shows the message of a result that is not ok)
    return fail(ERASURE_PAUSED_MESSAGE);
  }
  return ok();
}
