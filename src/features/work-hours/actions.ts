"use server";

import { revalidatePath } from "next/cache";

import { calendarSettingsFromRow } from "@/features/calendar-days/holidays";
import { parseWorkingHours, type WorkingHours } from "@/features/profile/working-hours";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { DEFAULT_ORG_HOURS, workingDaysOnly } from "./in-hours";
import { parseLeave } from "./leave";
import { memberHoursPath } from "./paths";

const NO_DAY = "יש לסמן לפחות יום עבודה אחד.";

function revalidateMember(orgId: string, userId: string) {
  revalidatePath(paths.settingsAccount(orgId));
  revalidatePath(memberHoursPath(orgId, userId));
  revalidatePath(paths.settingsUsers(orgId));
}

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

// update the organization's row, or create it the first time (as the rest days do); null = no hours limit
async function writeOrgHours(context: Context, orgId: string, hours: WorkingHours | null): Promise<ActionResult> {
  const failed = "לא הצלחנו לשמור את שעות העבודה. נסו שוב.";
  const { data, error } = await context.supabase
    .from("org_calendar_settings")
    .update({ working_hours: hours })
    .eq("organization_id", orgId)
    .select("id");
  if (error) return fail(dbErrorMessage(error, failed));
  // clearing changes an existing row; none changed = not permitted (or nothing set)
  if (data.length === 0 && hours === null) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (data.length === 0) {
    const { error: insertError } = await context.supabase
      .from("org_calendar_settings")
      .insert({ organization_id: orgId, working_hours: hours })
      .select("id")
      .single();
    if (insertError) return fail(dbErrorMessage(insertError, failed));
  }
  revalidatePath(paths.org(orgId), "layout");
  return { ok: true };
}

/** The business's weekly hours (owners and admins; RLS decides). CAP-09. */
export async function saveOrgHoursAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const hours = parseWorkingHours(formData);
  if (!hours.ok) return fail(hours.message, { fieldErrors: { working_hours: hours.message } });
  if (Object.keys(hours.hours).length === 0) return fail(NO_DAY, { fieldErrors: { working_hours: NO_DAY } });
  const result = await writeOrgHours(context, orgId, hours.hours);
  return result.ok ? { ok: true, message: "שעות העבודה של העסק נשמרו." } : result;
}

/** A business with no hours starts limiting: 08:00-18:00 on its working days. CAP-09. */
export async function setDefaultOrgHoursAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("org_calendar_settings")
    .select("rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail(dbErrorMessage(error));
  const hours = workingDaysOnly(DEFAULT_ORG_HOURS, calendarSettingsFromRow(data));
  return writeOrgHours(context, orgId, Object.keys(hours).length > 0 ? hours : DEFAULT_ORG_HOURS);
}

/** Back to no hours limit: leads are handed out at any hour. CAP-09. */
export async function clearOrgHoursAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  return writeOrgHours(context, orgId, null);
}

/**
 * A member's weekly hours (CAP-09). mode "org" = the business's hours apply
 * (null); "own" = the ticked days. The user saves their own profile row; an
 * owner or admin saves a colleague's through set_member_working_hours().
 */
export async function saveMemberHoursAction(orgId: string, userId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, userId);
  if (!context.ok) return context;
  const mode = formData.get("mode");
  if (mode !== "org" && mode !== "own") return fail("יש לבחור אילו שעות עבודה חלות.");
  let hours = null;
  if (mode === "own") {
    const parsed = parseWorkingHours(formData);
    if (!parsed.ok) return fail(parsed.message, { fieldErrors: { working_hours: parsed.message }, values: formValues(formData) });
    if (Object.keys(parsed.hours).length === 0) {
      const message = `${NO_DAY} מי שעובד בשעות העסק בוחר "כמו שעות העסק".`;
      return fail(message, { fieldErrors: { working_hours: message } });
    }
    hours = parsed.hours;
  }

  const failed = "לא הצלחנו לשמור את שעות העבודה. נסו שוב.";
  if (userId === context.user.id) {
    const { data, error } = await context.supabase.from("profiles").update({ working_hours: hours }).eq("id", userId).select("id");
    if (error) return fail(dbErrorMessage(error, failed));
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  } else {
    const { error } = await context.supabase.rpc("set_member_working_hours", { p_org: orgId, p_user: userId, p_hours: hours });
    if (error) return fail(dbErrorMessage(error, failed));
  }
  revalidateMember(orgId, userId);
  return { ok: true, message: "שעות העבודה נשמרו." };
}

/** Adds a leave for a member: their own, or anyone's for owners and admins (RLS decides). CAP-09. */
export async function addLeaveAction(orgId: string, userId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, userId);
  if (!context.ok) return context;
  const leave = parseLeave(formData.get("starts_on"), formData.get("ends_on"));
  if (!leave.ok) return fail(leave.message, { fieldErrors: { [leave.field]: leave.message }, values: formValues(formData) });
  const { error } = await context.supabase
    .from("member_leaves")
    .insert({ organization_id: orgId, user_id: userId, starts_on: leave.startsOn, ends_on: leave.endsOn })
    .select("id")
    .single();
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את החופשה. נסו שוב."), { values: formValues(formData) });
  revalidateMember(orgId, userId);
  return { ok: true, message: "החופשה נשמרה. בימים האלה לא יגיעו לידים בסבב." };
}

/** Removes a leave (RLS: the member's own, or an owner/admin). CAP-09. */
export async function removeLeaveAction(orgId: string, userId: string, leaveId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, userId, leaveId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("member_leaves")
    .delete()
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .eq("id", leaveId)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו למחוק את החופשה. נסו שוב."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateMember(orgId, userId);
  return { ok: true };
}
