"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, FORM_INVALID, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { moneyRowParents } from "./deal-contact";
import { MONEY_SUBJECT_KINDS, moneySubjectPath } from "./money-subject";

import {
  CHEQUE_FIELD_NAMES,
  CHEQUE_SERIES_MAX,
  chequeSchema,
  chequeSeries,
  CHEQUE_STATUSES,
  chequePaymentStatus,
  type ChequeFields,
  unbounceReasonSchema,
} from "./cheques";
import { cancelReasonSchema, newPaymentStatusSchema, PAYMENT_FIELD_NAMES, paymentSchema, paymentStatusSchema } from "./schema";

// PAY-01, PAY-06: recording, moving the status of, correcting and cancelling a payment, with the user's session. RLS and the
// table's trigger decide: owners, admins and managers, or the personal key `record_payments`, record and move the status;
// correcting, cancelling (with a reason; never deleting) and marking refunded are for owners and admins; a deal or contact the user reads.

const CANNOT = "אין לכם הרשאה לרשום תשלומים כאן. רושמים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים.";
const CANNOT_CORRECT = "תיקון וביטול של תשלום רק לבעלים ולמנהלי מערכת.";
const writeError = (error: { code?: string; message?: string; hint?: string }, cannot = CANNOT) => (error.code === "42501" ? cannot : dbErrorMessage(error));

const subjectSchema = z.object({
  kind: z.enum(MONEY_SUBJECT_KINDS),
  id: z.guid(),
});
type Subject = z.infer<typeof subjectSchema>;

const pageOf = (orgId: string, subject: Subject) => moneySubjectPath(orgId, subject);

/** A new payment on the deal (with the deal's contact, when the user reads it) or on the contact. */
export async function recordPaymentAction(orgId: string, subject: Subject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) return context;
  const parsed = paymentSchema.safeParse(pick(formData, PAYMENT_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const status = newPaymentStatusSchema.safeParse(formData.get("status") ?? "recorded");
  if (!status.success) return fail(INVALID_ARGS, { values: formValues(formData) });
  // PAY-04: a cheque carries its details; its status sets the payment's (the database maps it)
  let cheque: ChequeFields | null = null;
  if (parsed.data.method === "cheque") {
    const fields = chequeSchema.safeParse(pick(formData, CHEQUE_FIELD_NAMES));
    if (!fields.success) return invalid(fields.error, formData);
    cheque = fields.data;
  }

  // a payment on a deal is the deal's contact's too, when the user reads that contact (the insert policy asks for it)
  // ORD-06 part two: on an order, the payment hangs on the order's own deal or contact and names the order
  const parents = await moneyRowParents(context.supabase, orgId, subject);
  if ("error" in parents) return fail(dbErrorMessage(parents.error), { values: formValues(formData) });
  if ("missing" in parents) return fail(CANNOT, { values: formValues(formData) });

  const { error } = await context.supabase.from("payments").insert({
    organization_id: orgId,
    ...parents,
    amount_agorot: parsed.data.amount,
    paid_on: parsed.data.paid_on,
    method: parsed.data.method,
    installments: parsed.data.installments,
    reference: parsed.data.reference,
    note: parsed.data.note,
    status: status.data,
    ...(cheque ?? {}),
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
  // PAY-04: a cheque's details are part of the correction; another method carries none
  type ChequeColumns = { [K in keyof ChequeFields]: ChequeFields[K] | null };
  let cheque: ChequeColumns = { cheque_number: null, cheque_bank: null, cheque_bank_name: null, cheque_branch: null, cheque_due_date: null, cheque_status: null };
  if (parsed.data.method === "cheque") {
    const fields = chequeSchema.safeParse(pick(formData, CHEQUE_FIELD_NAMES));
    if (!fields.success) return invalid(fields.error, formData);
    cheque = fields.data;
  }
  const { data, error } = await context.supabase
    .from("payments")
    .update({
      amount_agorot: parsed.data.amount,
      paid_on: parsed.data.paid_on,
      method: parsed.data.method,
      installments: parsed.data.installments,
      reference: parsed.data.reference,
      note: parsed.data.note,
      ...cheque,
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

/** PAY-04 answers 2-4: moves a cheque's status (its payment follows); out of "bounced" only owners and admins, with a reason. */
export async function setChequeStatusAction(orgId: string, subject: Subject, paymentId: string, status: string, reason: string | null): Promise<ActionResult> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const next = z.enum(CHEQUE_STATUSES).safeParse(status);
  if (!next.success) return fail(INVALID_ARGS);
  const why = reason === null ? null : unbounceReasonSchema.safeParse(reason);
  if (why && !why.success) return fail(why.error.issues[0]?.message ?? INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, paymentId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("payments")
    // the status goes along (the database derives it from the cheque's anyway), so every "update of status" trigger sees it
    .update({ cheque_status: next.data, status: chequePaymentStatus(next.data), ...(why ? { cheque_unbounce_reason: why.data } : {}) })
    .eq("organization_id", orgId)
    .eq("id", paymentId)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT);
  revalidatePath(pageOf(orgId, subject));
  return ok();
}

const seriesSchema = z.object({
  count: z.coerce.number().int().min(2, { error: "בסדרה לפחות 2 צ'קים." }).max(CHEQUE_SERIES_MAX, { error: `בסדרה עד ${CHEQUE_SERIES_MAX} צ'קים.` }),
  step: z.enum(["month", "days"]),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/** PAY-04 answer 1: a series of N cheques, each its own payment, in one insert (all or nothing). */
export async function recordChequeSeriesAction(orgId: string, subject: Subject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) return context;
  // the series' shared fields: the amount of each cheque, the method is a cheque, the date it was received
  const parsed = paymentSchema.safeParse({ ...pick(formData, PAYMENT_FIELD_NAMES), method: "cheque", installments: "" });
  if (!parsed.success) return invalid(parsed.error, formData);
  const first = chequeSchema.safeParse(pick(formData, CHEQUE_FIELD_NAMES));
  if (!first.success) return invalid(first.error, formData);
  const series = seriesSchema.safeParse({
    count: formData.get("count") ?? "",
    step: formData.get("step") ?? "month",
    days: formData.get("step") === "days" ? (formData.get("days") ?? "") : undefined,
  });
  if (!series.success) {
    return fail(FORM_INVALID, {
      fieldErrors: Object.fromEntries(series.error.issues.map((issue) => [String(issue.path[0] ?? "count"), issue.message])),
      values: formValues(formData),
    });
  }
  if (series.data.step === "days" && !series.data.days) return fail(FORM_INVALID, { fieldErrors: { days: "כמה ימים בין צ'ק לצ'ק." }, values: formValues(formData) });
  const cheques = chequeSeries(
    { number: first.data.cheque_number, dueDate: first.data.cheque_due_date },
    series.data.count,
    series.data.step === "month" ? { kind: "month" } : { kind: "days", days: series.data.days ?? 30 },
  );
  if (!cheques) return fail(FORM_INVALID, { fieldErrors: { cheque_number: "מספרי הצ'קים בסדרה עוברים 20 ספרות." }, values: formValues(formData) });

  const parents = await moneyRowParents(context.supabase, orgId, subject);
  if ("error" in parents) return fail(dbErrorMessage(parents.error), { values: formValues(formData) });
  if ("missing" in parents) return fail(CANNOT, { values: formValues(formData) });
  const { error } = await context.supabase.from("payments").insert(
    cheques.map((cheque) => ({
      organization_id: orgId,
      ...parents,
      amount_agorot: parsed.data.amount,
      paid_on: parsed.data.paid_on,
      method: "cheque",
      reference: parsed.data.reference,
      note: parsed.data.note,
      ...first.data,
      cheque_number: cheque.number,
      cheque_due_date: cheque.dueDate,
    })),
  );
  if (error) return fail(writeError(error), { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return { ok: true, message: `נרשמו ${cheques.length} צ'קים.` };
}
