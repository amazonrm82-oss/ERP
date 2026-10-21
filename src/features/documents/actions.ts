"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";
import { readableDealContact } from "@/features/payments/deal-contact";

import { cancelReasonSchema, DOCUMENT_FIELD_NAMES, documentSchema } from "./schema";

// DOC-01: recording and cancelling an external accounting document, with the user's session. RLS and the table's trigger
// decide: owners, admins and managers, or the personal key `documents`; a deal or contact the user reads; the same type and
// number once per business; a record is never deleted, only cancelled with a reason.

const CANNOT = "אין לכם הרשאה לרשום מסמכים כאן. רושמים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום מסמכים.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

const subjectSchema = z.object({ kind: z.enum(["deal", "contact"]), id: z.guid() });
type Subject = z.infer<typeof subjectSchema>;

const pageOf = (orgId: string, subject: Subject) => (subject.kind === "deal" ? paths.deal(orgId, subject.id) : paths.contact(orgId, subject.id));

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
  let contactId: string | null = subject.kind === "contact" ? subject.id : null;
  if (subject.kind === "deal") {
    const found = await readableDealContact(context.supabase, orgId, subject.id);
    if (found.error) return fail(dbErrorMessage(found.error), { values: formValues(formData) });
    contactId = found.contactId;
  }
  const { error } = await context.supabase.from("accounting_documents").insert({
    organization_id: orgId,
    deal_id: subject.kind === "deal" ? subject.id : null,
    contact_id: contactId,
    doc_type: parsed.data.doc_type,
    number: parsed.data.number,
    doc_date: parsed.data.doc_date,
    amount_agorot: parsed.data.amount,
  });
  if (error) return fail(writeError(error), { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return { ok: true, message: "המסמך נרשם." };
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
