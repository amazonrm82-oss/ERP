"use server";

import { revalidatePath } from "next/cache";

import { calendarPath } from "@/features/calendar/range";
import { actionContext } from "@/lib/action-context";
import { directionArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { MeetingTypeInsert } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { meetingTypesPath } from "./paths";
import { MEETING_TYPE_FIELD_NAMES, meetingTypeSchema } from "./schema";

// CAL-08: owners and admins manage the list; RLS refuses everyone else (0 rows / 42501).

const DUPLICATE_NAME = "כבר יש סוג פגישה בשם הזה.";

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

function refresh(orgId: string) {
  revalidatePath(meetingTypesPath(orgId));
  // the calendar shows the types' colours
  revalidatePath(calendarPath(orgId));
}

/** The form's fields as a row; the linked service only when the form had the field (the plan holds products). */
function parseType(formData: FormData) {
  const parsed = meetingTypeSchema.safeParse(pick(formData, MEETING_TYPE_FIELD_NAMES));
  if (!parsed.success) {
    return { ok: false as const, state: invalid(parsed.error, formData) };
  }
  const { product_id, ...rest } = parsed.data;
  const row: Omit<MeetingTypeInsert, "organization_id"> = { ...rest };
  if (formData.has("product_id")) row.product_id = product_id;
  return { ok: true as const, row };
}

async function ordered(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("meeting_types")
    .select("id, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return { data: data ?? [], error };
}

function saveError(error: { code?: string; message?: string; hint?: string | null }, fallback: string): string {
  return error.code === "23505" ? DUPLICATE_NAME : dbErrorMessage(error, fallback);
}

export async function addMeetingTypeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseType(formData);
  if (!parsed.ok) {
    return parsed.state;
  }
  const existing = await ordered(context, orgId);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const position = existing.data.reduce((max, row) => Math.max(max, row.position + 1), 0);
  const { error } = await context.supabase.from("meeting_types").insert({ organization_id: orgId, ...parsed.row, position });
  if (error) {
    return fail(saveError(error, "לא הצלחנו להוסיף את סוג הפגישה. נסו שוב."), { values: formValues(formData) });
  }
  refresh(orgId);
  return { ok: true, message: "סוג הפגישה נוסף." };
}

export async function updateMeetingTypeAction(orgId: string, typeId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseType(formData);
  if (!parsed.ok) {
    return parsed.state;
  }
  const { data, error } = await context.supabase
    .from("meeting_types")
    .update(parsed.row)
    .eq("organization_id", orgId)
    .eq("id", typeId)
    .select("id");
  if (error) {
    return fail(saveError(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  refresh(orgId);
  return { ok: true, message: "סוג הפגישה נשמר." };
}

export async function moveMeetingTypeAction(orgId: string, typeId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data: rows, error: readError } = await ordered(context, orgId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = rows.findIndex((row) => row.id === typeId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= rows.length) {
    return ok();
  }
  [rows[index], rows[target]] = [rows[target], rows[index]];
  for (const [position, row] of rows.entries()) {
    if (row.position !== position) {
      const { data, error } = await context.supabase
        .from("meeting_types")
        .update({ position })
        .eq("organization_id", orgId)
        .eq("id", row.id)
        .select("id");
      if (error) {
        return fail(dbErrorMessage(error));
      }
      if (data.length === 0) {
        return fail(NOT_FOUND_OR_FORBIDDEN);
      }
    }
  }
  refresh(orgId);
  return ok();
}

/** Meetings set from the type keep their details; only their link to the type goes (set null). */
export async function deleteMeetingTypeAction(orgId: string, typeId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("meeting_types").delete().eq("organization_id", orgId).eq("id", typeId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  refresh(orgId);
  return ok();
}
