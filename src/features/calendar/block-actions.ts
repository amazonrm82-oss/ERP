"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { TIME_ZONE } from "@/lib/app";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zonedIso } from "@/lib/format";
import { pick } from "@/lib/validation";

import { BLOCK_FIELD_NAMES, BLOCK_ROW_SHAPE, blockSchema } from "./blocks";
import { calendarPath } from "./range";

// GAP-07: blocking time in the calendar, with the user's session; RLS and the meetings rules decide (0 rows = not
// permitted or gone). A block belongs to the person who makes it.

async function parseBlock(orgId: string, formData: FormData, supabase: SupabaseClient<Database>) {
  const parsed = blockSchema.safeParse(pick(formData, BLOCK_FIELD_NAMES));
  if (!parsed.success) {
    return { ok: false as const, state: invalid(parsed.error, formData) };
  }
  const { data, error } = await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (error || !data) {
    return { ok: false as const, state: fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) }) };
  }
  const zone = data.timezone || TIME_ZONE;
  const block = parsed.data;
  return {
    ok: true as const,
    row: {
      title: block.title,
      starts_at: zonedIso(block.date, `${block.start_time}:00`, zone),
      ends_at: zonedIso(block.date, `${block.end_time}:00`, zone),
    },
  };
}

export async function createBlockAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = await parseBlock(orgId, formData, context.supabase);
  if (!parsed.ok) return parsed.state;
  const { error } = await context.supabase
    .from("meetings")
    .insert({ organization_id: orgId, ...parsed.row, ...BLOCK_ROW_SHAPE, owner_id: context.user.id });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לחסום את הזמן. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(calendarPath(orgId));
  return { ok: true, message: "הזמן נחסם." };
}

export async function updateBlockAction(orgId: string, blockId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, blockId);
  if (!context.ok) return context;
  const parsed = await parseBlock(orgId, formData, context.supabase);
  if (!parsed.ok) return parsed.state;
  const { data, error } = await context.supabase.from("meetings").update(parsed.row).eq("organization_id", orgId).eq("id", blockId).eq("is_block", true).select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(calendarPath(orgId));
  return { ok: true, message: "הזמן החסום עודכן." };
}

/** Removes the block (its creator, the organizer's manager or an admin may; RLS decides). */
export async function deleteBlockAction(orgId: string, blockId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, blockId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("meetings").delete().eq("organization_id", orgId).eq("id", blockId).eq("is_block", true).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(calendarPath(orgId));
  return ok();
}
