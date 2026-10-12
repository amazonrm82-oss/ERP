"use server";

import { revalidatePath } from "next/cache";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { TIME_ZONE } from "@/lib/app";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zonedIso } from "@/lib/format";
import { paths } from "@/lib/paths";
import { recordPage } from "@/lib/record-types";

import { calendarPath, movedEnd } from "./range";
import { moveTargetSchema, type MoveTarget } from "./schema";

type Linked = { lead_id: string | null; contact_id: string | null; company_id: string | null; deal_id: string | null };

function revalidateMoved(orgId: string, row: Linked) {
  revalidatePath(calendarPath(orgId));
  if (row.lead_id) revalidatePath(recordPage("lead", orgId, row.lead_id));
  if (row.contact_id) revalidatePath(recordPage("contact", orgId, row.contact_id));
  if (row.company_id) revalidatePath(recordPage("company", orgId, row.company_id));
  if (row.deal_id) revalidatePath(recordPage("deal", orgId, row.deal_id));
}

/**
 * Move a meeting or a task on the calendar (CAL-02), by dragging or with the
 * "move" form: a meeting starts at the new day and time and keeps its length;
 * a task is due then, and its reminder keeps the same lead time. The time is
 * read in the organization's zone. Everything runs with the user's session:
 * RLS decides who may move what (0 rows back = not permitted or gone).
 */
export async function moveCalendarItemAction(orgId: string, itemId: string, target: MoveTarget): Promise<ActionResult> {
  if (!validArg(moveTargetSchema, target)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, itemId);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;

  const { data: org, error: orgError } = await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (orgError) {
    return fail(dbErrorMessage(orgError));
  }
  if (!org) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const start = zonedIso(target.date, `${target.time}:00`, org.timezone || TIME_ZONE);

  if (target.kind === "meeting") {
    const { data: meeting, error: readError } = await supabase
      .from("meetings")
      .select("starts_at, ends_at, lead_id, contact_id, company_id, deal_id")
      .eq("organization_id", orgId)
      .eq("id", itemId)
      .maybeSingle();
    if (readError) {
      return fail(dbErrorMessage(readError));
    }
    if (!meeting) {
      return fail(NOT_FOUND_OR_FORBIDDEN);
    }
    const { data, error } = await supabase
      .from("meetings")
      .update({ starts_at: start, ends_at: movedEnd(meeting.starts_at, meeting.ends_at, start) })
      .eq("organization_id", orgId)
      .eq("id", itemId)
      .select("id");
    if (error) {
      return fail(dbErrorMessage(error, "לא הצלחנו להעביר את הפגישה. נסו שוב."));
    }
    if (data.length === 0) {
      return fail(NOT_FOUND_OR_FORBIDDEN);
    }
    revalidateMoved(orgId, meeting);
    return ok();
  }

  const { data: task, error: readError } = await supabase
    .from("tasks")
    .select("due_at, remind_at, lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  if (!task) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  // the reminder keeps the same time before the due time (as when a task is put off)
  const remind = task.due_at && task.remind_at ? movedEnd(task.due_at, task.remind_at, start) : null;
  const { data, error } = await supabase
    .from("tasks")
    .update({ due_at: start, remind_at: remind })
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להעביר את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateMoved(orgId, task);
  revalidatePath(paths.tasks(orgId));
  revalidatePath(paths.org(orgId));
  return ok();
}
