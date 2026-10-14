"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { askedField, missingAfterChange, requiredFieldsMerge } from "@/features/custom-fields/required-server";
import { missingFieldsMessage, type MissingResult } from "@/features/custom-fields/conditions";
import { lossReasonIdByName } from "@/features/deal-loss-reasons/server";
import { setLeadStatus } from "@/features/leads/status";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import type { Database } from "@/lib/database.types";
import { isUuid } from "@/lib/paths";
import { isRecordType, RECORD_TYPES, recordPage } from "@/lib/record-types";

// What can be edited in a list's cell (LST-06), per list. The database decides
// who may: the update runs with the user's session, and 0 rows means "not allowed".
export type InlineObject = "lead" | "contact" | "company" | "deal" | "task";
// a task's "name" is its title, and its owner is the person it is assigned to
export type InlineField = "name" | "status" | "owner" | "stage";
export type InlineValue = { text?: string; first?: string; last?: string; id?: string | null; reason?: string };

const ALLOWED: Record<InlineObject, InlineField[]> = {
  lead: ["name", "status", "owner"],
  contact: ["name", "owner"],
  company: ["name", "owner"],
  deal: ["name", "stage", "owner"],
  task: ["name", "owner"],
};
// tasks have no page of their own

const text = (max: number) => z.string().trim().max(max, { error: "הטקסט ארוך מדי." });

// the shape of InlineValue, checked at runtime (FXC-08)
const valueSchema = z.object({
  text: z.string().max(1000).optional(),
  first: z.string().max(1000).optional(),
  last: z.string().max(1000).optional(),
  id: z.string().nullable().optional(),
  reason: z.string().max(2000).optional(),
});

/**
 * FLD-09: a lead status or deal stage chosen in a cell that would leave conditionally required fields
 * empty is not saved: the answer names them (missing), and the cell's window asks for them.
 */
export async function inlineEditAction(orgId: string, object: InlineObject, id: string, field: InlineField, value: InlineValue): Promise<ActionResult | MissingResult> {
  if (!validArg(valueSchema, value) || typeof object !== "string" || typeof field !== "string") {
    return fail(INVALID_ARGS);
  }
  if (!isRecordType(object) || !ALLOWED[object].includes(field)) {
    return fail("אי אפשר לערוך את השדה הזה מהרשימה.");
  }
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }

  // the columns differ per table, so the patch is typed loosely and the table name picks the shape
  if ((field === "status" && object === "lead") || (field === "stage" && object === "deal")) {
    if (isUuid(value.id ?? "")) {
      const kind = object === "lead" ? "lead" : "deal";
      const found = await missingAfterChange(orgId, kind, [id], { [kind === "lead" ? "builtin:status" : "builtin:stage"]: value.id! });
      if (!found.ok) return fail(dbErrorMessage(found.error));
      const fields = found.missing.get(id);
      if (fields) return { ok: false, message: missingFieldsMessage(fields), missing: fields.map(askedField) };
    }
  }

  let patch: { owner_id?: string | null; first_name?: string | null; last_name?: string | null; name?: string; full_name?: string | null; title?: string; stage_id?: string; lost_reason_id?: string };
  if (field === "status") {
    if (!isUuid(value.id ?? "")) return fail("יש לבחור סטטוס.");
    const result = await setLeadStatus(context.supabase, orgId, id, value.id!, value.reason?.trim().slice(0, 500) || null);
    if (!result.ok) return fail(result.message);
    revalidatePath(RECORD_TYPES[object].list(orgId));
    revalidatePath(recordPage(object, orgId, id));
    return ok();
  } else if (field === "stage") {
    // a stage of another pipeline (or organization) is refused by the (pipeline_id, stage_id) foreign key
    if (!isUuid(value.id ?? "")) return fail("יש לבחור שלב.");
    patch = { stage_id: value.id! };
    // DEAL-03: a lost stage may come with a reason, by name; the database drops it on any other stage
    const reason = await lossReasonIdByName(context.supabase, orgId, value.reason);
    if (!reason.ok) return fail(reason.message);
    if (reason.id) patch.lost_reason_id = reason.id;
  } else if (field === "owner") {
    const owner = value.id ?? null;
    if (owner !== null && !isUuid(owner)) return fail("יש לבחור אחראי.");
    patch = { owner_id: owner };
  } else if (object === "contact") {
    const first = text(100).safeParse(value.first ?? "");
    const last = text(100).safeParse(value.last ?? "");
    if (!first.success || !last.success) return fail("הטקסט ארוך מדי.");
    if (!first.data && !last.data) return fail("יש לכתוב שם פרטי או שם משפחה.");
    patch = { first_name: first.data || null, last_name: last.data || null };
  } else {
    const name = text(object === "task" ? 300 : 200).safeParse(value.text ?? "");
    if (!name.success) return fail(name.error.issues[0]?.message ?? "השם אינו תקין.");
    if (object === "company" && !name.data) return fail("יש לכתוב שם לחברה.");
    if (object === "deal" && !name.data) return fail("יש לכתוב שם לעסקה.");
    if (object === "task" && !name.data) return fail("יש לכתוב כותרת למשימה.");
    // a lead may have no name when it has a phone or an email (the database checks)
    patch =
      object === "company" || object === "deal" ? { name: name.data } : object === "task" ? { title: name.data } : { full_name: name.data || null };
  }

  const { data, error } = await context.supabase
    .from(RECORD_TYPES[object].table as "contacts")
    .update(patch as Database["public"]["Tables"]["contacts"]["Update"])
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    if (error.code === "23514") return fail("צריך להשאיר לליד שם, טלפון או אימייל.");
    if (error.code === "23503" && field === "stage") return fail("השלב שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.");
    // the new owner is outside what the user may manage (a manager hands a record out of their teams)
    if (error.code === "42501" && field === "owner") return fail("אין לכם הרשאה להעביר את הרשומה לאחראי הזה.");
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(RECORD_TYPES[object].list(orgId));
  revalidatePath(recordPage(object, orgId, id));
  return ok();
}

/**
 * FLD-09: the cell's window answer: the lead status or deal stage chosen in the cell, with the values
 * it makes required, in one update ({"$merge": …}). Field errors while a value is missing or invalid.
 */
export async function inlineMoveWithFieldsAction(
  orgId: string,
  object: InlineObject,
  id: string,
  field: InlineField,
  value: InlineValue,
  formData: FormData,
): Promise<ActionResult> {
  if (!validArg(valueSchema, value) || typeof object !== "string" || typeof field !== "string") {
    return fail(INVALID_ARGS);
  }
  const lead = object === "lead" && field === "status";
  const deal = object === "deal" && field === "stage";
  if (!lead && !deal) return fail("אי אפשר לערוך את השדה הזה מהרשימה.");
  if (!isUuid(value.id ?? "")) return fail(lead ? "יש לבחור סטטוס." : "יש לבחור שלב.");
  const context = await actionContext(orgId, id);
  if (!context.ok) return context;
  const target = value.id!;
  const merge = await requiredFieldsMerge(orgId, lead ? "lead" : "deal", id, { [lead ? "builtin:status" : "builtin:stage"]: target }, formData);
  if (!merge.ok) return fail(merge.message, { fieldErrors: merge.fieldErrors, values: formValues(formData) });
  if (lead) {
    const result = await setLeadStatus(context.supabase, orgId, id, target, value.reason?.trim().slice(0, 500) || null, merge.merge);
    if (!result.ok) return fail(result.message, { values: formValues(formData) });
  } else {
    const reason = await lossReasonIdByName(context.supabase, orgId, value.reason);
    if (!reason.ok) return fail(reason.message);
    const { data, error } = await context.supabase
      .from("deals")
      .update({ stage_id: target, ...(reason.id ? { lost_reason_id: reason.id } : {}), ...(merge.merge === undefined ? {} : { custom_fields: merge.merge }) })
      .eq("organization_id", orgId)
      .eq("id", id)
      .is("deleted_at", null)
      .select("id");
    if (error) {
      return fail(error.code === "23503" ? "השלב שנבחר כבר לא קיים. רעננו את הדף ונסו שוב." : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
    }
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(RECORD_TYPES[object].list(orgId));
  revalidatePath(recordPage(object, orgId, id));
  return ok();
}
