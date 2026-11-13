"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage, GENERIC_ERROR } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { orgDeletionPath } from "./paths";
import { codeSchema, confirmReasonText, typedNameSchema } from "./texts";

const requestAnswer = z.object({ ok: z.literal(true), expires_at: z.string() });
const confirmAnswer = z.object({ ok: z.boolean(), reason: z.string().optional() });

/**
 * ADM-03 (owner's answer (373) ג): the owner asks to delete the business. The database checks the owner, the second step and
 * the typed name and records the request (no secret); then Supabase Auth emails the owner a reauthentication code, asked
 * with the owner's own session (auth.reauthenticate(); no service key). If Auth cannot send it, the request is cancelled.
 */
export async function requestOrgDeletionAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = typedNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const supabase = context.supabase;
  const { data, error } = await supabase.rpc("org_deletion_request", { p_org: orgId, p_typed_name: parsed.data.name });
  if (error) {
    if (error.code === "42501") return fail("רק בעל העסק יכול לבקש למחוק אותו.");
    return fail(dbErrorMessage(error), { values: { name: parsed.data.name } });
  }
  if (!requestAnswer.safeParse(data).success) return fail(GENERIC_ERROR);

  const sent = await supabase.auth.reauthenticate().catch(() => ({ error: { code: "network" } as { code?: string } }));
  if (sent.error) {
    await supabase.rpc("org_deletion_cancel", { p_org: orgId });
    return fail(
      sent.error.code === "over_email_send_rate_limit"
        ? "קוד נשלח לפני רגע. חכו דקה ובקשו שוב. הבקשה בוטלה, והעסק ממשיך לפעול כרגיל."
        : "לא הצלחנו לשלוח את הקוד לאימייל שלכם. הבקשה בוטלה, והעסק ממשיך לפעול כרגיל. נסו שוב בעוד כמה דקות.",
    );
  }
  revalidatePath(orgDeletionPath(orgId));
  return { ok: true, message: "שלחנו קוד לאימייל שלכם. הקלידו אותו כאן כדי לאשר את המחיקה." };
}

/**
 * ADM-03: the owner types the code from the email. The database verifies it itself against what Supabase Auth stored when
 * it sent the code (auth.users), so a caller who never saw the email cannot confirm.
 */
export async function confirmOrgDeletionAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = codeSchema.safeParse(pick(formData, ["code"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("org_deletion_confirm", { p_org: orgId, p_code: parsed.data.code });
  if (error) return fail(dbErrorMessage(error));
  const answer = confirmAnswer.safeParse(data);
  if (!answer.success) return fail(GENERIC_ERROR);
  if (!answer.data.ok) return fail(confirmReasonText(answer.data.reason));
  // the banner and the read-only rule touch every screen of the business
  revalidatePath(`/o/${orgId}`, "layout");
  return { ok: true, message: "המחיקה אושרה. העסק במצב קריאה בלבד עד המחיקה, ואפשר לבטל אותה בדף הזה." };
}

/** ADM-03: the owner cancels the pending deletion (or the open request); the business is writable again at once. */
export async function cancelOrgDeletionAction(orgId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  void _formData;
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("org_deletion_cancel", { p_org: orgId });
  if (error) return fail(error.code === "42501" ? "רק בעל העסק יכול לבטל את המחיקה." : dbErrorMessage(error));
  const done = z.object({ ok: z.boolean() }).safeParse(data);
  if (!done.success) return fail(GENERIC_ERROR);
  if (!done.data.ok) return fail("אין בקשת מחיקה פתוחה לביטול.");
  revalidatePath(`/o/${orgId}`, "layout");
  return { ok: true, message: "מחיקת העסק בוטלה. העסק חזר לפעול כרגיל." };
}
