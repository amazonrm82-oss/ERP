"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { addedNotice, newSegmentSchema, readSegmentFilter, SEGMENT_ADD_MAX, SEGMENT_OBJECTS, segmentNameSchema, type SegmentObject } from "./model";
import { segmentPath, segmentsPath } from "./paths";

const idsArg = z.array(z.guid()).min(1).max(SEGMENT_ADD_MAX);
const objectArg = z.enum(SEGMENT_OBJECTS);

/**
 * A new segment (SEG-01). A dynamic one keeps the list filter it was saved from (`filter`, checked like the list's
 * own `f=`); a static one starts empty. Owners, admins and managers of a business that takes changes write segments;
 * the database decides, and refuses past the plan's quota.
 */
export async function createSegmentAction(orgId: string, _prev: FormState<{ id: string }>, formData: FormData): Promise<FormState<{ id: string }>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = newSegmentSchema.safeParse(pick(formData, ["name", "object_type", "kind"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const filter = parsed.data.kind === "dynamic" ? readSegmentFilter(formData.get("filter")) : null;
  if (parsed.data.kind === "dynamic" && !filter) {
    return fail("סגמנט לפי סינון נשמר מתוך רשימה מסוננת. סננו את הרשימה ושמרו משם.", { values: formValues(formData) });
  }
  const { data, error } = await context.supabase
    .from("segments")
    .insert({ organization_id: orgId, object_type: parsed.data.object_type, kind: parsed.data.kind, name: parsed.data.name, filter })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הסגמנט. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(segmentsPath(orgId));
  return ok({ id: data.id }, "הסגמנט נשמר.");
}

export async function renameSegmentAction(orgId: string, segmentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, segmentId);
  if (!context.ok) return context;
  const parsed = segmentNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("segments")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", segmentId)
    .select("id");
  if (error) return fail(dbErrorMessage(error), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(segmentsPath(orgId));
  revalidatePath(segmentPath(orgId, segmentId));
  return { ok: true, message: "השם נשמר." };
}

/** Removes a segment; its member rows go with it. The records themselves are not touched. */
export async function deleteSegmentAction(orgId: string, segmentId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, segmentId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("segments").delete().eq("organization_id", orgId).eq("id", segmentId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(segmentsPath(orgId));
  return ok();
}

/**
 * Adds picked records to a static segment, with the user's session. Records already in it, records the user does not
 * read and records in the recycle bin are skipped and counted.
 */
export async function addToSegmentAction(
  orgId: string,
  objectType: SegmentObject,
  segmentId: string,
  ids: string[],
): Promise<ActionResult<{ added: number; skipped: number; message: string }>> {
  if (!validArg(objectArg, objectType) || !validArg(idsArg, ids)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, segmentId);
  if (!context.ok) return context;
  const { supabase } = context;
  const unique = [...new Set(ids)];

  const segment = await supabase.from("segments").select("id, name, kind, object_type").eq("organization_id", orgId).eq("id", segmentId).maybeSingle();
  if (segment.error) return fail(dbErrorMessage(segment.error));
  if (!segment.data || segment.data.kind !== "static" || segment.data.object_type !== objectType) return fail(NOT_FOUND_OR_FORBIDDEN);

  const column = objectType === "lead" ? "lead_id" : "contact_id";
  const [readable, existing] = await Promise.all([
    supabase.from(objectType === "lead" ? "leads" : "contacts").select("id").eq("organization_id", orgId).is("deleted_at", null).in("id", unique),
    supabase.from("segment_members").select("lead_id, contact_id").eq("organization_id", orgId).eq("segment_id", segmentId).in(column, unique),
  ]);
  if (readable.error) return fail(dbErrorMessage(readable.error));
  if (existing.error) return fail(dbErrorMessage(existing.error));
  const already = new Set(existing.data.map((row) => (column === "lead_id" ? row.lead_id : row.contact_id)));
  const toAdd = readable.data.map((row) => row.id).filter((id) => !already.has(id));

  if (toAdd.length > 0) {
    const { error } = await supabase
      .from("segment_members")
      .insert(toAdd.map((id) => (objectType === "lead" ? { organization_id: orgId, segment_id: segmentId, lead_id: id } : { organization_id: orgId, segment_id: segmentId, contact_id: id })));
    if (error) {
      // someone added the same record a moment ago: nothing was added, so the user tries again
      return fail(error.code === "23505" ? "חלק מהרשומות נוספו לסגמנט ממש עכשיו. נסו שוב." : dbErrorMessage(error));
    }
  }
  revalidatePath(segmentPath(orgId, segmentId));
  const skipped = unique.length - toAdd.length;
  return ok({ added: toAdd.length, skipped, message: addedNotice(toAdd.length, skipped, segment.data.name) });
}

/** Takes one record out of a static segment (the record itself stays). */
export async function removeFromSegmentAction(orgId: string, segmentId: string, memberId: string): Promise<ActionResult> {
  if (!isUuid(memberId)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, segmentId, memberId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("segment_members")
    .delete()
    .eq("organization_id", orgId)
    .eq("segment_id", segmentId)
    .eq("id", memberId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(segmentPath(orgId, segmentId));
  return ok();
}
