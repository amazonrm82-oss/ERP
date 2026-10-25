"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";
import { moneyRowParents } from "@/features/payments/deal-contact";
import { parseAppliedCredit, recordedMessage, type AppliedCredit } from "@/features/allocations/credit";
import { MONEY_SUBJECT_KINDS, moneySubjectPath } from "@/features/payments/money-subject";

import { cancelReasonSchema, DOCUMENT_FIELD_NAMES, documentSchema, dueDateSchema, takesDueDate } from "./schema";

// DOC-01: recording and cancelling an external accounting document, with the user's session. RLS and the table's trigger
// decide: owners, admins and managers, or the personal key `documents`; a deal or contact the user reads; the same type and
// number once per business; a record is never deleted, only cancelled with a reason.

const CANNOT = "אין לכם הרשאה לרשום מסמכים כאן. רושמים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום מסמכים.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

const subjectSchema = z.object({ kind: z.enum(MONEY_SUBJECT_KINDS), id: z.guid() });
type Subject = z.infer<typeof subjectSchema>;

const pageOf = (orgId: string, subject: Subject) => moneySubjectPath(orgId, subject);

/**
 * A new document on the deal or the contact. RVW-45: a document on a deal is also the deal's contact's when the user reads
 * that contact, like a payment, so a privacy erasure of the contact reaches it directly.
 */
export async function recordDocumentAction(orgId: string, subject: Subject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) return context;
  const parsed = documentSchema.safeParse(pick(formData, DOCUMENT_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  // ORD-06 part two: on an order, the document hangs on the order's own deal or contact and names the order
  const parents = await moneyRowParents(context.supabase, orgId, subject);
  if ("error" in parents) return fail(dbErrorMessage(parents.error), { values: formValues(formData) });
  if ("missing" in parents) return fail(CANNOT, { values: formValues(formData) });
  const { data: created, error } = await context.supabase
    .from("accounting_documents")
    .insert({
      organization_id: orgId,
      ...parents,
      doc_type: parsed.data.doc_type,
      number: parsed.data.number,
      doc_date: parsed.data.doc_date,
      amount_agorot: parsed.data.amount,
      // PAY-02 answer 7: empty = from the customer's payment terms
      ...(parsed.data.due_date ? { due_date: parsed.data.due_date } : {}),
    })
    .select("id")
    .single();
  if (error) return fail(writeError(error), { values: formValues(formData) });
  // PAY-03: "לקזז מיתרת הזכות" allocates the customer's credit to the new tax invoice or proforma, with the user's session
  // (the allocation rules and RLS decide). The document stays recorded whatever happens here.
  let applied: AppliedCredit | null = null;
  let creditFailed = false;
  if (formData.get("apply_credit") === "on" && takesDueDate(parsed.data.doc_type)) {
    const result = await context.supabase.rpc("money_apply_credit", { p_org: orgId, p_document: created.id });
    if (result.error) creditFailed = true;
    else applied = parseAppliedCredit(result.data);
  }
  revalidatePath(pageOf(orgId, subject));
  return { ok: true, message: recordedMessage(applied, creditFailed) };
}

/** Cancels a recorded document, with a reason (it is never deleted). */
export async function cancelDocumentAction(orgId: string, subject: Subject, documentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, documentId);
  if (!context.ok) return context;
  const reason = z.object({ reason: cancelReasonSchema }).safeParse({ reason: formData.get("reason") ?? "" });
  if (!reason.success) return invalid(reason.error, formData);
  const { data, error } = await context.supabase
    .from("accounting_documents")
    .update({ status: "cancelled", cancel_reason: reason.data.reason })
    .eq("organization_id", orgId)
    .eq("id", documentId)
    .select("id");
  if (error) return fail(writeError(error), { values: formValues(formData) });
  if (data.length === 0) return fail(CANNOT, { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return ok();
}

/** PAY-02 answer 7: a new due date for an active tax invoice or proforma (empty clears it). */
export async function setDocumentDueDateAction(orgId: string, subject: Subject, documentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, documentId);
  if (!context.ok) return context;
  const due = z.object({ due_date: dueDateSchema }).safeParse({ due_date: formData.get("due_date") ?? "" });
  if (!due.success) return invalid(due.error, formData);
  const { data, error } = await context.supabase
    .from("accounting_documents")
    .update({ due_date: due.data.due_date || null })
    .eq("organization_id", orgId)
    .eq("id", documentId)
    .select("id");
  if (error) return fail(writeError(error), { values: formValues(formData) });
  if (data.length === 0) return fail(CANNOT, { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return ok();
}
