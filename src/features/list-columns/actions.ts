"use server";

import { revalidatePath } from "next/cache";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isRecordType, RECORD_TYPES } from "@/lib/record-types";

import { catalogFor, columnChoicesSchema, type ColumnChoice, type ListObject } from "./columns";


/** Saves the user's columns for a list (only columns the list really has). */
export async function saveListColumnsAction(orgId: string, object: ListObject, columns: ColumnChoice[]): Promise<ActionResult> {
  if (!isRecordType(object)) {
    return fail("הרשימה לא נמצאה.");
  }
  const parsed = columnChoicesSchema.safeParse(columns);
  if (!parsed.success) {
    return fail("לא הצלחנו לקרוא את העמודות. רעננו את הדף ונסו שוב.");
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const known = new Set(catalogFor(object, object === "task" ? [] : await listFieldDefinitions(orgId, object)).map((column) => column.key));
  if (parsed.data.some((choice) => !known.has(choice.key))) {
    return fail("אחת העמודות כבר לא קיימת. רעננו את הדף ונסו שוב.");
  }

  // update the user's row, or create it the first time (RLS: own rows only)
  const { data, error } = await context.supabase
    .from("list_preferences")
    .update({ columns: parsed.data })
    .eq("organization_id", orgId)
    .eq("object_type", object)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את העמודות. נסו שוב."));
  }
  if (data.length === 0) {
    const { error: insertError } = await context.supabase.from("list_preferences").insert({ organization_id: orgId, object_type: object, columns: parsed.data });
    if (insertError) {
      return fail(dbErrorMessage(insertError, "לא הצלחנו לשמור את העמודות. נסו שוב."));
    }
  }
  revalidatePath(RECORD_TYPES[object].list(orgId));
  return ok();
}

/** Back to the list's default columns. */
export async function resetListColumnsAction(orgId: string, object: ListObject): Promise<ActionResult> {
  if (!isRecordType(object)) {
    return fail("הרשימה לא נמצאה.");
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { error } = await context.supabase.from("list_preferences").delete().eq("organization_id", orgId).eq("object_type", object);
  if (error) {
    return fail(dbErrorMessage(error));
  }
  revalidatePath(RECORD_TYPES[object].list(orgId));
  return ok();
}
