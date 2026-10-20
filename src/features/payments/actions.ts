"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { cancelReasonSchema, newPaymentStatusSchema, PAYMENT_FIELD_NAMES, paymentSchema, paymentStatusSchema } from "./schema";

// PAY-01, PAY-06: recording, moving the status of, correcting and cancelling a payment, with the user's session. RLS and the
// table's trigger decide: owners, admins and managers, or the personal key `record_payments`, record and move the status;
// correcting, cancelling (with a reason; never deleting) and marking refunded are for owners and admins; a deal or contact the user reads.

const CANNOT = "אין לכם הרשאה לרשום תשלומים כאן. רושמים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים.";
const CANNOT_CORRECT = "תיקון וביטול של תשלום רק לבעלים ולמנהלי מערכת.";
const writeError = (error: { code?: string; message?: string; hint?: string }, cannot = CANNOT) => (error.code === "42501" ? cannot : dbErrorMessage(error));

const subjectSchema = z.object({
  kind: z.enum(["deal", "contact"]),
  id: z.guid(),
});
type Subject = z.infer<typeof subjectSchema>;

const pageOf = (orgId: string, subject: Subject) => (subject.kind === "deal" ? paths.deal(orgId, subject.id) : paths.contact(orgId, subject.id));

/** A new payment on the deal (with the deal's contact, when the user reads it) or on the contact. */
export async function recordPaymentAction(orgId: string, subject: Subject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) return context;
  const parsed = paymentSchema.safeParse(pick(formData, PAYMENT_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const status = newPaymentStatusSchema.safeParse(formData.get("status") ?? "recorded");
  if (!status.success) return fail(INVALID_ARGS, { values: formValues(formData) });

  // a payment on a deal is the deal's contact's too, when the user reads that contact (the insert policy asks for it)
  let contactId: string | null = subject.kind === "contact" ? subject.id : null;
  if (subject.kind === "deal") {
    const deal = await context.supabase.from("deals").select("contact_id").eq("organization_id", orgId).eq("id", subject.id).maybeSingle();
    if (deal.error) return fail(dbErrorMessage(deal.error), { values: formValues(formData) });
    if (deal.data?.contact_id) {
      const contact = await context.supabase
        .from("contacts")
        .select("id")
        .eq("organization_id", orgId)
        .eq("id", deal.data.contact_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (contact.error)
        return fail(dbErrorMessage(contact.error), {
          values: formValues(formData),
        });
      contactId = contact.data?.id ?? null;
    }
  }

  const { error } = await context.supabase.from("payments").insert({
    organization_id: orgId,
    deal_id: subject.kind === "deal" ? subject.id : null,
    contact_id: contactId,
    amount_agorot: parsed.data.amount,
    paid_on: parsed.data.paid_on,
    method: parsed.data.method,
    installments: parsed.data.installments,
    reference: parsed.data.reference,
    note: parsed.data.note,
    status: status.data,
  });
  if (error) return fail(writeError(error), { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return { ok: true, message: "התשלום נרשם." };
}

/** PAY-06: a correction of a payment's details (owners and admins). */
export async function correctPaymentAction(orgId: string, subject: Subject, paymentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, paymentId);
  if (!context.ok) return context;
  const parsed = paymentSchema.safeParse(pick(formData, PAYMENT_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("payments")
    .update({
      amount_agorot: parsed.data.amount,
      paid_on: parsed.data.paid_on,
      method: parsed.data.method,
      installments: parsed.data.installments,
      reference: parsed.data.reference,
      note: parsed.data.note,
    })
    .eq("organization_id", orgId)
    .eq("id", paymentId)
    .select("id");
  if (error)
    return fail(writeError(error, CANNOT_CORRECT), {
      values: formValues(formData),
    });
  if (data.length === 0) return fail(CANNOT_CORRECT, { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return { ok: true, message: "התשלום עודכן." };
}

/** Moves a payment's status (recorded, confirmed, failed; refunded for owners and admins). */
export async function setPaymentStatusAction(orgId: string, subject: Subject, paymentId: string, status: string): Promise<ActionResult> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const next = paymentStatusSchema.safeParse(status);
  if (!next.success) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, paymentId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("payments").update({ status: next.data }).eq("organization_id", orgId).eq("id", paymentId).select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT);
  revalidatePath(pageOf(orgId, subject));
  return ok();
}

/** PAY-06 (owner, 20 October 2026): cancels a payment with a reason (owners and admins); a payment is never deleted. */
export async function cancelPaymentAction(orgId: string, subject: Subject, paymentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, paymentId);
  if (!context.ok) return context;
  const reason = z.object({ reason: cancelReasonSchema }).safeParse({ reason: formData.get("reason") ?? "" });
  if (!reason.success) return invalid(reason.error, formData);
  const { data, error } = await context.supabase
    .from("payments")
    .update({ status: "cancelled", cancel_reason: reason.data.reason })
    .eq("organization_id", orgId)
    .eq("id", paymentId)
    .select("id");
  if (error) return fail(writeError(error, CANNOT_CORRECT), { values: formValues(formData) });
  if (data.length === 0) return fail(CANNOT_CORRECT, { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return ok();
}
