"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { booleanArg, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid } from "@/lib/paths";

import { isSchedulePeriod, MAX_RECIPIENTS, SCHEDULE_TIMES, scheduleEntry } from "./catalog";
import { reportSchedulesPath } from "./paths";

const SAVE_FAILED = "לא הצלחנו לשמור את הדוח המתוזמן. נסו שוב.";

const scheduleSchema = z
  .object({
    report: z.string().refine((v) => scheduleEntry(v) !== undefined, "בחרו דוח מהרשימה."),
    period: z.string().optional(),
    frequency: z.enum(["daily", "weekly"], { message: "בחרו תדירות." }),
    weekday: z.coerce.number().int().min(0).max(6).optional(),
    send_at: z.string().refine((v) => SCHEDULE_TIMES.includes(v), "בחרו שעה מהרשימה."),
    recipients: z
      .array(z.string().refine(isUuid))
      .min(1, "בחרו לפחות נמען אחד.")
      .max(MAX_RECIPIENTS, `אפשר לבחור עד ${MAX_RECIPIENTS} נמענים.`),
  })
  .superRefine((value, ctx) => {
    const entry = scheduleEntry(value.report);
    if (entry?.hasPeriod && !isSchedulePeriod(value.period)) ctx.addIssue({ code: "custom", path: ["period"], message: "בחרו תקופה." });
    if (value.frequency === "weekly" && value.weekday === undefined) ctx.addIssue({ code: "custom", path: ["weekday"], message: "בחרו יום בשבוע." });
  });

/** RPT-03: a new scheduled report with its recipients, in one call (public.scheduled_report_create, the user's session). */
export async function createReportScheduleAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = scheduleSchema.safeParse({
    report: formData.get("report"),
    period: formData.get("period") ?? undefined,
    frequency: formData.get("frequency"),
    weekday: formData.get("weekday") || undefined,
    send_at: formData.get("send_at"),
    recipients: formData.getAll("recipients").filter((v): v is string => typeof v === "string"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "_form");
      if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
    }
    return fail("יש לתקן את השדות המסומנים.", { fieldErrors });
  }
  const entry = scheduleEntry(parsed.data.report);
  const { error } = await context.supabase.rpc("scheduled_report_create", {
    p_org: orgId,
    p_report: parsed.data.report,
    p_period: entry?.hasPeriod ? (parsed.data.period ?? null) : null,
    p_frequency: parsed.data.frequency,
    p_weekday: parsed.data.frequency === "weekly" ? (parsed.data.weekday ?? null) : null,
    p_send_at: parsed.data.send_at,
    p_recipients: [...new Set(parsed.data.recipients)],
  });
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED));
  revalidatePath(reportSchedulesPath(orgId));
  return { ok: true, message: "הדוח המתוזמן נשמר." };
}

/** Switches a schedule on or off (owners and admins of a writable business; RLS decides). */
export async function setReportScheduleEnabledAction(orgId: string, scheduleId: string, enabled: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, enabled)) return fail(NOT_FOUND_OR_FORBIDDEN);
  const context = await actionContext(orgId, scheduleId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("report_schedules")
    .update({ enabled })
    .eq("organization_id", orgId)
    .eq("id", scheduleId)
    .select("id");
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(reportSchedulesPath(orgId));
  return ok();
}

/** Removes a schedule (owners and admins). */
export async function deleteReportScheduleAction(orgId: string, scheduleId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, scheduleId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("report_schedules").delete().eq("organization_id", orgId).eq("id", scheduleId).select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו למחוק. נסו שוב."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(reportSchedulesPath(orgId));
  return ok();
}

/** The person takes themselves off a schedule they receive. */
export async function leaveReportScheduleAction(orgId: string, scheduleId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, scheduleId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("report_schedule_recipients")
    .delete()
    .eq("organization_id", orgId)
    .eq("schedule_id", scheduleId)
    .eq("user_id", context.user.id)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו להסיר. נסו שוב."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(reportSchedulesPath(orgId));
  return ok();
}
