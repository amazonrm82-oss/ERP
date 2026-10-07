"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { setTrashed, type TrashableTable } from "@/lib/record-trash";

const TABLES: readonly TrashableTable[] = ["leads", "contacts", "companies", "deals"];

const LIST_PATH = {
  leads: paths.leads,
  contacts: paths.contacts,
  companies: paths.companies,
  deals: paths.deals,
} as const satisfies Record<TrashableTable, (orgId: string) => string>;

/** Takes a record out of the recycle bin. Admins and managers of the record's team; the database enforces it. */
export async function restoreRecordAction(orgId: string, table: TrashableTable, id: string): Promise<ActionResult> {
  if (!TABLES.includes(table)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }
  const result = await setTrashed(context.supabase, table, orgId, id, false);
  if (result.ok) {
    revalidatePath(paths.settingsTrash(orgId));
    revalidatePath(LIST_PATH[table](orgId), "layout");
    revalidatePath(paths.org(orgId));
  }
  return result;
}

/**
 * Deletes a record from the recycle bin for good. Admins only, and only what is
 * already in the bin (the delete policy); its own activities and tasks go with it.
 */
export async function purgeRecordAction(orgId: string, table: TrashableTable, id: string): Promise<ActionResult> {
  if (!TABLES.includes(table)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from(table)
    .delete()
    .eq("organization_id", orgId)
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsTrash(orgId));
  return ok();
}
