"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { paths } from "@/lib/paths";

const TYPES = ["leads", "contacts", "companies", "deals"] as const;

/**
 * A privacy request: erases a permanently deleted record's details from the audit
 * log (and the copies kept by a merge or a lead form). Owners and admins; the
 * database checks it and refuses a record that still exists.
 */
export async function eraseFromAuditAction(orgId: string, entityType: string, entityId: string): Promise<ActionResult> {
  if (!(TYPES as readonly string[]).includes(entityType)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, entityId);
  if (!context.ok) {
    return context;
  }
  const { error } = await context.supabase.rpc("audit_erase_record", { p_org: orgId, p_type: entityType, p_id: entityId });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק את הפרטים. נסו שוב."));
  }
  revalidatePath(paths.settingsAudit(orgId));
  return ok();
}
