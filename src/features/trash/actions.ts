"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, type ActionResult } from "@/lib/action-result";
import { NOT_FOUND } from "@/lib/errors";
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
