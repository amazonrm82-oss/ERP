"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";

import { calendarSettingsFromRow } from "@/features/calendar-days/holidays";
import { movesDay, seriesCountSchema, seriesScopeSchema, shiftToTimes, splitStartDate, weeklySeriesTimes, type SeriesSpan } from "@/features/meetings/series";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult } from "@/lib/action-result";
import { TIME_ZONE } from "@/lib/app";
import { longDay } from "@/lib/calendar-grid";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zoneDate, zonedIso } from "@/lib/format";
import { pick } from "@/lib/validation";

import {
  BLOCK_FIELD_NAMES,
  BLOCK_REST_MESSAGE,
  BLOCK_ROW_SHAPE,
  blockRestDays,
  blockSchema,
  blockSeriesFields,
  blockSplitText,
  releaseFollowingText,
  skippedBlockDatesText,
  type BlockFormState,
  type SkippedBlocks,
} from "./blocks";
import { calendarPath } from "./range";

// GAP-07: blocking time in the calendar, with the user's session; RLS and the meetings rules decide (0 rows = not
// permitted or gone). A block belongs to the person who makes it. A weekly series of blocks (owner, 18 October 2026)
// is a CAL-09 series made by public.create_meeting_series (all or nothing); "this and following" goes block by block.

type Client = SupabaseClient<Database>;

async function parseBlock(orgId: string, formData: FormData, supabase: Client) {
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
    zone,
    form: block,
    row: {
      title: block.title,
      starts_at: zonedIso(block.date, `${block.start_time}:00`, zone),
      ends_at: zonedIso(block.date, `${block.end_time}:00`, zone),
    },
  };
}

/** The rest days and holidays the blocks fall on (a warning only; a failed read skips it and logs). */
async function restDaysOf(supabase: Client, orgId: string, spans: SeriesSpan[], zone: string) {
  const { data, error } = await supabase
    .from("org_calendar_settings")
    .select("rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GAP-07 block series] rest-day check skipped, a read failed:", error.code, error.message);
    return [];
  }
  return blockRestDays(spans, calendarSettingsFromRow(data), zone);
}

export async function createBlockAction(orgId: string, _prev: BlockFormState, formData: FormData): Promise<BlockFormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = await parseBlock(orgId, formData, context.supabase);
  if (!parsed.ok) return parsed.state;
  const values = formValues(formData);

  if (formData.get("repeat") === "weekly") {
    const count = seriesCountSchema.safeParse(formData.get("series_count"));
    if (!count.success) {
      const message = count.error.issues[0]?.message ?? "יש לכתוב מספר חסימות.";
      return fail(message, { values, fieldErrors: { series_count: message } });
    }
    const times = weeklySeriesTimes(parsed.form.date, parsed.form.start_time, parsed.form.end_time, parsed.zone, count.data);
    if (formData.get("rest_ok") !== "1") {
      // CAL-09's rule: rest days only warn
      const restDays = await restDaysOf(context.supabase, orgId, times, parsed.zone);
      if (restDays.length > 0) return { ok: false, message: BLOCK_REST_MESSAGE, values, restDays };
    }
    const { error } = await context.supabase.rpc("create_meeting_series", {
      p_org: orgId,
      p_meeting: blockSeriesFields(parsed.row.title),
      p_times: times,
      p_participants: [],
    });
    if (error) {
      return fail(dbErrorMessage(error, "לא הצלחנו לחסום את הזמן. נסו שוב."), { values });
    }
    revalidatePath(calendarPath(orgId));
    return { ok: true, message: `נחסמו ${times.length} שבועות.` };
  }

  const { error } = await context.supabase
    .from("meetings")
    .insert({ organization_id: orgId, ...parsed.row, ...BLOCK_ROW_SHAPE, owner_id: context.user.id });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לחסום את הזמן. נסו שוב."), { values });
  }
  revalidatePath(calendarPath(orgId));
  return { ok: true, message: "הזמן נחסם." };
}

/** The planned blocks after this one in its series that the user can see, in order. */
async function followingBlocks(supabase: Client, orgId: string, seriesId: string, index: number) {
  const { data, error } = await supabase
    .from("meetings")
    .select("id, starts_at, series_index")
    .eq("organization_id", orgId)
    .eq("series_id", seriesId)
    .eq("is_block", true)
    .gt("series_index", index)
    .eq("status", "planned")
    .order("series_index");
  if (error) return { error: dbErrorMessage(error) } as const;
  return { rows: data.map((row) => ({ id: row.id, starts_at: row.starts_at, series_index: row.series_index ?? 0 })) } as const;
}

export async function updateBlockAction(orgId: string, blockId: string, _prev: BlockFormState, formData: FormData): Promise<BlockFormState> {
  const context = await actionContext(orgId, blockId);
  if (!context.ok) return context;
  const { supabase } = context;
  const parsed = await parseBlock(orgId, formData, supabase);
  if (!parsed.ok) return parsed.state;
  const values = formValues(formData);

  const { data: current, error: readError } = await supabase
    .from("meetings")
    .select("owner_id, status, starts_at, series_id, series_index")
    .eq("organization_id", orgId)
    .eq("id", blockId)
    .eq("is_block", true)
    .maybeSingle();
  if (readError) return fail(dbErrorMessage(readError), { values });
  if (!current) return fail(NOT_FOUND_OR_FORBIDDEN, { values });

  const following =
    seriesScopeSchema.parse(formData.get("series_scope")) === "following" && current.series_id !== null && current.series_index !== null
      ? await followingBlocks(supabase, orgId, current.series_id, current.series_index)
      : null;
  if (following && "error" in following) return fail(following.error ?? NOT_FOUND_OR_FORBIDDEN, { values });

  if (following && following.rows.length > 0 && movesDay(current.starts_at, parsed.form.date, parsed.zone)) {
    // CAL-09 (owner, 15 October 2026): another weekday makes the following blocks again as a new series
    return splitBlocks(supabase, orgId, context.user.id, blockId, { ...current, series_index: current.series_index! }, following.rows, parsed, formData);
  }

  const { data, error } = await supabase.from("meetings").update(parsed.row).eq("organization_id", orgId).eq("id", blockId).eq("is_block", true).select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values });

  // the following blocks keep their own date and take the new title and hours; RLS decides each (0 rows = not permitted)
  const skipped: SkippedBlocks = { forbidden: [], failed: [] };
  for (const next of following?.rows ?? []) {
    const times = shiftToTimes(next.starts_at, parsed.form.start_time, parsed.form.end_time, parsed.zone);
    const { data: rows, error: nextError } = await supabase
      .from("meetings")
      .update({ title: parsed.row.title, ...times })
      .eq("organization_id", orgId)
      .eq("id", next.id)
      .eq("is_block", true)
      .select("id");
    const day = zoneDate(new Date(next.starts_at), parsed.zone);
    if (nextError) skipped.failed.push(day);
    else if (rows.length === 0) skipped.forbidden.push(day);
  }
  revalidatePath(calendarPath(orgId));
  const skippedText = skippedBlockDatesText(skipped, "change");
  if (skippedText) return { ok: true, message: `הזמן החסום עודכן. ${skippedText}` };
  return { ok: true, message: "הזמן החסום עודכן." };
}

type Parsed = Extract<Awaited<ReturnType<typeof parseBlock>>, { ok: true }>;

/**
 * "This and following" moved to another weekday, as CAL-09 does for meetings: nothing is written until the person
 * confirmed (`split_ok`) and may remove every block that goes (public.meetings_removable); the new series is made first
 * in one transaction, with the same owner (someone else's blocks stay theirs; the database decides who may name them);
 * then the old blocks go in one statement, and if that fails the new series is removed again.
 */
async function splitBlocks(
  supabase: Client,
  orgId: string,
  userId: string,
  blockId: string,
  current: { owner_id: string | null; status: string; starts_at: string; series_index: number },
  following: Array<{ id: string; starts_at: string; series_index: number }>,
  parsed: Parsed,
  formData: FormData,
): Promise<BlockFormState> {
  const values = formValues(formData);
  const now = Date.now();
  if (current.status !== "planned" || Date.parse(current.starts_at) < now) {
    return fail("אפשר להעביר ליום אחר רק מחסימה שעוד לא עברה.", { values });
  }
  // the new series must stay the same person's: only they or an owner/admin may name its organizer (meetings_check_owner),
  // so anyone else (a team manager) is told before the question, not after it
  const own = current.owner_id === userId;
  if (!own) {
    const { data: me, error: roleError } = await supabase
      .from("memberships")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (roleError) return fail(dbErrorMessage(roleError), { values });
    if (!me || (me.role !== "owner" && me.role !== "admin")) {
      return fail("אפשר להעביר ליום אחר רק סדרת חסימות שלך. בעלי העסק ומנהלי המערכת יכולים להעביר גם סדרות של אחרים. אפשר לשנות כל חסימה בנפרד.", { values });
    }
  }
  const old = [{ id: blockId, starts_at: current.starts_at }, ...following.filter((row) => Date.parse(row.starts_at) >= now)];
  const ids = old.map((row) => row.id);
  const { data: removable, error: checkError } = await supabase.rpc("meetings_removable", { p_org: orgId, p_ids: ids });
  if (checkError) return fail(dbErrorMessage(checkError), { values });
  if (new Set(removable ?? []).size < ids.length) {
    return fail("אי אפשר להעביר את הסדרה ליום אחר: אין לך הרשאה למחוק את כל החסימות הבאות בה. אפשר לשנות כל חסימה בנפרד.", { values });
  }

  const startDate = splitStartDate(zoneDate(new Date(current.starts_at), parsed.zone), parsed.form.date);
  const times = weeklySeriesTimes(startDate, parsed.form.start_time, parsed.form.end_time, parsed.zone, old.length);
  if (formData.get("split_ok") !== "1") {
    const text = blockSplitText(old.length, longDay(startDate));
    const restDays = await restDaysOf(supabase, orgId, times, parsed.zone);
    return { ok: false, message: text, values, split: { text }, ...(restDays.length > 0 ? { restDays } : {}) };
  }

  if (times.length === 1) {
    // one block left: no series to make, it simply moves
    const { data, error } = await supabase.from("meetings").update({ title: parsed.row.title, ...times[0] }).eq("organization_id", orgId).eq("id", blockId).eq("is_block", true).select("id");
    if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values });
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
    revalidatePath(calendarPath(orgId));
    return { ok: true, message: "הזמן החסום עודכן." };
  }

  const { data: made, error: makeError } = await supabase.rpc("create_meeting_series", {
    p_org: orgId,
    // the writer is the organizer by default; someone else's series is named theirs (allowed above)
    p_meeting: blockSeriesFields(parsed.row.title, own ? null : current.owner_id),
    p_times: times,
    p_participants: [],
  });
  if (makeError) return fail(dbErrorMessage(makeError, "לא הצלחנו להעביר את הסדרה. דבר לא השתנה, נסו שוב."), { values });

  const { data: removed, error: removeError } = await supabase
    .from("meetings")
    .delete()
    .eq("organization_id", orgId)
    .in("id", ids)
    .eq("is_block", true)
    .eq("status", "planned")
    .select("id");
  revalidatePath(calendarPath(orgId));
  if (removeError) {
    const newIds = ((made as { ids?: string[] } | null)?.ids ?? []).filter((id) => typeof id === "string");
    const { error: undoError } = newIds.length > 0 ? await supabase.from("meetings").delete().eq("organization_id", orgId).in("id", newIds) : { error: null };
    return fail(
      undoError ? "הסדרה החדשה נחסמה, אבל החסימות הקודמות לא נמחקו. בדקו את היומן ושחררו את הכפולות." : "לא הצלחנו להעביר את הסדרה. דבר לא השתנה, נסו שוב.",
      { values },
    );
  }
  const left = ids.length - removed.length;
  if (left > 0) {
    return { ok: true, message: `הסדרה הועברה, אבל ${left === 1 ? "חסימה אחת" : `${left} חסימות`} מהסדרה הקודמת לא נמחקו כי השתנו בינתיים. בדקו את היומן.` };
  }
  return { ok: true, message: "הסדרה הועברה." };
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

/** The blocks "free this and following" would remove: this one and the later ones of its series, not yet started. */
async function releasableFollowing(supabase: Client, orgId: string, blockId: string) {
  const { data: current, error } = await supabase
    .from("meetings")
    .select("series_id, series_index")
    .eq("organization_id", orgId)
    .eq("id", blockId)
    .eq("is_block", true)
    .maybeSingle();
  if (error) return { error: dbErrorMessage(error) } as const;
  if (!current?.series_id || current.series_index === null) return { error: NOT_FOUND_OR_FORBIDDEN } as const;
  const { data: rows, error: readError } = await supabase
    .from("meetings")
    .select("id, starts_at, series_index")
    .eq("organization_id", orgId)
    .eq("series_id", current.series_id)
    .eq("is_block", true)
    .gte("series_index", current.series_index)
    .order("series_index");
  if (readError) return { error: dbErrorMessage(readError) } as const;
  const now = Date.now();
  return { rows: rows.filter((row) => Date.parse(row.starts_at) >= now) } as const;
}

/** How many blocks "free this and following" would remove, and the window's text. */
export async function releaseFollowingCountAction(orgId: string, blockId: string): Promise<ActionResult<{ count: number; text: string }>> {
  const context = await actionContext(orgId, blockId);
  if (!context.ok) return context;
  const found = await releasableFollowing(context.supabase, orgId, blockId);
  if ("error" in found) return fail(found.error ?? NOT_FOUND_OR_FORBIDDEN);
  return ok({ count: found.rows.length, text: releaseFollowingText(found.rows.length) });
}

/** Frees this block and the following ones of its series, one by one by each block's own rights; the dates left are named. */
export async function releaseFollowingBlocksAction(orgId: string, blockId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, blockId);
  if (!context.ok) return context;
  const { supabase } = context;
  const found = await releasableFollowing(supabase, orgId, blockId);
  if ("error" in found) return fail(found.error ?? NOT_FOUND_OR_FORBIDDEN);
  const { data: org, error: zoneError } = await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (zoneError) return fail(dbErrorMessage(zoneError));
  const zone = org?.timezone || TIME_ZONE;
  const skipped: SkippedBlocks = { forbidden: [], failed: [] };
  let gone = 0;
  for (const row of found.rows) {
    const { data, error } = await supabase.from("meetings").delete().eq("organization_id", orgId).eq("id", row.id).eq("is_block", true).select("id");
    const day = zoneDate(new Date(row.starts_at), zone);
    if (error) skipped.failed.push(day);
    else if (data.length === 0) skipped.forbidden.push(day);
    else gone += 1;
  }
  revalidatePath(calendarPath(orgId));
  const skippedText = skippedBlockDatesText(skipped, "release");
  if (gone === 0 && skippedText) return fail(`לא שוחררה אף חסימה. ${skippedText}`);
  return skippedText ? { ok: true, message: `${gone === 1 ? "חסימה אחת שוחררה" : `${gone} חסימות שוחררו`}. ${skippedText}` } : ok();
}
