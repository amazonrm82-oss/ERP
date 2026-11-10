"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { messageSendingSettingsPath } from "./paths";
import {
  MEETING_MESSAGE_FIELD_NAMES,
  meetingMessagesSchema,
  MESSAGE_CAP_FIELD_NAMES,
  messageCapsSchema,
  SENDING_HOURS_FIELD_NAMES,
  sendingHoursSchema,
  SMS_SENDER_FIELD_NAMES,
  smsSenderSchema,
} from "./schema";
import { MESSAGE_CHANNELS } from "./usage";
import { senderCheckMessage } from "@/features/messaging/sms-sender";

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

type Values = {
  window_from?: string;
  window_until?: string;
  skip_rest_days?: boolean;
  monthly_cap_email?: number | null;
  monthly_cap_sms?: number | null;
  monthly_cap_whatsapp?: number | null;
  meeting_confirm?: boolean;
  meeting_remind_day?: boolean;
  meeting_remind_hour?: boolean;
  sms_sender_name?: string | null;
};

/**
 * One row per business (org_message_settings): update it, or insert it the first time; a first save racing another hits the
 * unique key and updates. The user's session decides (owners and admins of a writable business; 0 rows = not permitted).
 */
async function saveSettings(orgId: string, values: Values, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const update = () => context.supabase.from("org_message_settings").update(values).eq("organization_id", orgId).select("id");

  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("org_message_settings").insert({ organization_id: orgId, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED), { values: formValues(formData) });
  if ((data?.length ?? 0) === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  revalidatePath(messageSendingSettingsPath(orgId));
  return { ok: true, message: "ההגדרה נשמרה." };
}

/** MSG-06: the sending window of messages to customers. */
export async function saveSendingHoursAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = sendingHoursSchema.safeParse(pick(formData, SENDING_HOURS_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  return saveSettings(orgId, parsed.data, formData);
}

/** MSG-05: the monthly caps of marketing messages (empty = no cap of the business). */
export async function saveMessageCapsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = messageCapsSchema.safeParse(pick(formData, MESSAGE_CAP_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  return saveSettings(orgId, parsed.data, formData);
}

/** CAL-12: which meeting messages go to the customer (a confirmation, 24 hours and an hour before). */
export async function saveMeetingMessagesAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = meetingMessagesSchema.safeParse(pick(formData, MEETING_MESSAGE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  return saveSettings(orgId, parsed.data, formData);
}

/** SMS-01: the business's SMS sender name (empty = the platform account's default); the database checks the rule again. */
export async function saveSmsSenderAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = smsSenderSchema.safeParse(pick(formData, SMS_SENDER_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  return saveSettings(orgId, parsed.data, formData);
}

/** SMS-01b: sends a code to the business's own phone through the queue (public.sms_sender_verify_start, owners/admins). */
export async function startSenderCheckAction(orgId: string): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("sms_sender_verify_start", { p_org: orgId });
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED));
  const answer = senderCheckMessage(data);
  if (!answer.ok) return fail(answer.message);
  return { ok: true, message: "שלחנו קוד ב-SMS למספר של העסק. הקוד בתוקף עשר דקות. עד שספק ה-SMS יחובר, הקוד ממתין בתור." };
}

/** SMS-01b: checks the code the business typed (public.sms_sender_verify; 5 wrong codes, then a 30-minute cool-down). */
export async function verifySenderCodeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const code = String(formData.get("code") ?? "").replace(/[^0-9]/g, "");
  if (!/^[0-9]{6}$/.test(code)) return fail("הקוד הוא שש ספרות.", { fieldErrors: { code: "הקוד הוא שש ספרות." } });
  const { data, error } = await context.supabase.rpc("sms_sender_verify", { p_org: orgId, p_code: code });
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED));
  const answer = senderCheckMessage(data);
  if (!answer.ok) return fail(answer.message);
  revalidatePath(messageSendingSettingsPath(orgId));
  return { ok: true, message: "המספר אומת. הודעות SMS ייצאו ממנו." };
}

/**
 * MSG-05 (135) ב: cancels a channel's marketing messages waiting for the cap (public.message_cancel_waiting: owners and admins,
 * the queue's own cancellation count, one audit entry). The user's session decides.
 */
export async function cancelWaitingMessagesAction(orgId: string, channel: unknown): Promise<ActionResult> {
  if (!validArg(z.enum(MESSAGE_CHANNELS), channel)) return { ok: false, message: INVALID_ARGS };
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("message_cancel_waiting", { p_org: orgId, p_channel: channel });
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לבטל. נסו שוב."));
  revalidatePath(messageSendingSettingsPath(orgId));
  const n = typeof data === "number" ? data : 0;
  return { ok: true, message: n === 1 ? "הודעה אחת בוטלה." : `${n} הודעות בוטלו.` };
}
