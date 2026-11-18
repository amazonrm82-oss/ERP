"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { MONEY_SUBJECT_KINDS, moneySubjectPath } from "@/features/payments/money-subject";
import { refundSchema } from "@/features/payments/refunds";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { paymentProviderCode } from "./providers/select";

// LNK-07: an owner or admin asks the payment provider to refund all or part of a payment that came from a payment link, with
// the user's session. public.payment_link_refund_begin judges the rights (PAY-08's: owners and admins), the payment and the
// amount; the refund is recorded by the background worker only after the provider answered ok.

const CANNOT = "החזר דרך ספק הסליקה רק לבעלים ולמנהלי מערכת.";
const UNAVAILABLE = "החזר דרך ספק הסליקה לא זמין: לא חובר ספק סליקה.";

const subjectSchema = z.object({ kind: z.enum(MONEY_SUBJECT_KINDS), id: z.guid() });
const keySchema = z.guid();
const providerRefundSchema = refundSchema.pick({ amount: true, note: true });

export async function requestProviderRefundAction(
  orgId: string,
  subject: z.infer<typeof subjectSchema>,
  paymentId: string,
  key: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!validArg(subjectSchema, subject) || !validArg(keySchema, key)) return fail(INVALID_ARGS);
  if (!paymentProviderCode()) return fail(UNAVAILABLE);
  const context = await actionContext(orgId, subject.id, paymentId);
  if (!context.ok) return context;
  const parsed = providerRefundSchema.safeParse(pick(formData, ["amount", "note"] as const));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { error } = await context.supabase.rpc("payment_link_refund_begin", {
    p_org: orgId,
    p_key: key,
    p_payment: paymentId,
    p_amount: parsed.data.amount,
    p_note: parsed.data.note,
  });
  if (error) return fail(error.code === "42501" ? CANNOT : dbErrorMessage(error), { values: formValues(formData) });
  revalidatePath(moneySubjectPath(orgId, subject));
  return { ok: true, message: "בקשת ההחזר נשלחה לספק הסליקה. כשהספק יאשר, ההחזר יירשם כאן. אם לא, תקבלו הודעה." };
}

const OUTCOMES = ["refunded_at_provider", "not_refunded"] as const;

/** Review 4: an owner or admin closes a refund request nobody knows the outcome of, after checking at the provider. */
export async function closeProviderRefundAction(
  orgId: string,
  subject: z.infer<typeof subjectSchema>,
  requestId: string,
  outcome: (typeof OUTCOMES)[number],
): Promise<ActionResult> {
  if (!validArg(subjectSchema, subject) || !validArg(z.enum(OUTCOMES), outcome)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, requestId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("payment_link_refund_close", { p_org: orgId, p_request: requestId, p_outcome: outcome });
  if (error) return fail(error.code === "42501" ? CANNOT : dbErrorMessage(error));
  revalidatePath(moneySubjectPath(orgId, subject));
  return ok();
}
