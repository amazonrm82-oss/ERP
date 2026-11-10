"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getOrgContext } from "@/features/shell/queries";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";

import { queuedSmsMessage, RECORD_SMS_KINDS, SMS_TOO_LONG, smsPreview } from "./logic";
import { getRecordSmsSetup } from "./queries";

/**
 * SMS-02: queues the SMS with the user's session through public.record_sms_send, which reads the record and the template
 * with the user's rights and judges everything again (no service key). Before that, the SMS as it would go out (the
 * marketing envelope, the record's values) is checked against the channel's cap after filling (SMS-03,
 * app.message_filled_problem's rule), so a message the sender would refuse as too long is not queued. The message itself is
 * judged by the queue's send check (consent, blocklist, pause, hours, caps) when it is its turn.
 */
export async function sendRecordSmsAction(orgId: string, kind: string, recordId: string, templateId: string): Promise<ActionResult> {
  if (!validArg(z.enum(RECORD_SMS_KINDS), kind)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, recordId, templateId);
  if (!context.ok) {
    return context;
  }
  const [setup, org] = await Promise.all([getRecordSmsSetup(orgId, kind, recordId), getOrgContext(orgId)]);
  const template = setup?.templates.find((t) => t.id === templateId);
  if (setup && template && smsPreview(template, { ...setup.values, userName: org.user.displayName, businessName: org.org.name }).tooLong) {
    return fail(SMS_TOO_LONG);
  }
  const { data, error } = await context.supabase.rpc("record_sms_send", { p_org: orgId, p_kind: kind, p_record: recordId, p_template: templateId });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשלוח את ה-SMS. נסו שוב."));
  }
  const paused = Boolean(data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).paused === true);
  revalidatePath(recordPage(kind, orgId, recordId));
  return { ok: true, message: queuedSmsMessage(paused) };
}
