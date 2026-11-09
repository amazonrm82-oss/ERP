"use server";

import { revalidatePath } from "next/cache";

import { subjectSchema, type TimelineSubject } from "@/features/activities/schema";
import { calendarPath } from "@/features/calendar/range";
import { meetingTypesPath } from "@/features/meeting-types/paths";
import { ordersPath } from "@/features/orders/paths";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";
import { pick } from "@/lib/validation";

import { meetingOrderDraftModeSchema, meetingOrderDraftReasonText, parseDraftAnswer } from "./rules";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשנות את ההגדרה.";
const subjectOrNone = subjectSchema.nullable();

/**
 * CAL-13: "יצירת טיוטת הזמנה" on a held meeting, with the user's session. The database judges everything (the rule, the
 * caller's right to edit the meeting's contact, once per meeting) and answers the order's id, or a reason.
 */
export async function createMeetingOrderDraftAction(
  orgId: string,
  meetingId: string,
  subject: TimelineSubject | null,
): Promise<ActionResult<{ orderId: string }>> {
  if (!validArg(subjectOrNone, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, meetingId, ...(subject ? [subject.id] : []));
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("meeting_order_draft_create", { p_org: orgId, p_meeting: meetingId });
  if (error) return fail(dbErrorMessage(error));
  const answer = parseDraftAnswer(data);
  if (!answer.ok) return fail(meetingOrderDraftReasonText(answer.reason));
  if (subject) revalidatePath(recordPage(subject.kind, orgId, subject.id));
  revalidatePath(calendarPath(orgId));
  revalidatePath(ordersPath(orgId));
  return ok({ orderId: answer.orderId }, "טיוטת ההזמנה נוצרה.");
}

/**
 * CAL-13: automatic or by the button. Saved on the business's one documents-settings row with the user's session: updated
 * first, inserted only when there is none, updated once more when the insert lost a race (no upsert: its DO UPDATE names
 * organization_id, which has no UPDATE grant).
 */
export async function saveMeetingOrderDraftModeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = meetingOrderDraftModeSchema.safeParse(pick(formData, ["meeting_order_draft"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = { values: formValues(formData) };
  const table = () => context.supabase.from("org_document_settings");
  const update = () => table().update(parsed.data).eq("organization_id", orgId).select("id");
  let result = await update();
  if (!result.error && result.data.length === 0) {
    const inserted = await table()
      .insert({ organization_id: orgId, ...parsed.data })
      .select("id");
    result = inserted.error?.code === "23505" ? await update() : inserted;
  }
  if (result.error) return fail(result.error.code === "42501" ? NOT_ADMIN : dbErrorMessage(result.error), values);
  if (result.data.length === 0) return fail(NOT_ADMIN, values);
  revalidatePath(meetingTypesPath(orgId));
  return { ok: true, message: "ההגדרה נשמרה. היא חלה על פגישות שיסומנו מעכשיו." };
}
