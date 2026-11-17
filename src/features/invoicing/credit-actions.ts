"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { CREDIT_FIELD_NAMES, creditAmount, creditFormSchema } from "./credit";
import { beginCredit } from "./issue-server";
import { creditDocumentPath, issueRequestPath } from "./paths";

// DOC-14: a credit invoice through the business's invoice provider, with the user's own session (owners, admins and the
// `issue_credits` grant; the database decides, and judges what is left of the original under its own lock).

const documentSchema = z.guid();

export async function creditDocumentAction(orgId: string, documentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(documentSchema, documentId)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, documentId);
  if (!context.ok) return context;
  const parsed = creditFormSchema.safeParse(pick(formData, [...CREDIT_FIELD_NAMES]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = formValues(formData);
  const amount = creditAmount(parsed.data.mode, parsed.data.amount, null);
  if (!amount.ok) return fail(amount.message, { values, fieldErrors: { amount: amount.message } });
  const outcome = await beginCredit(context.supabase, orgId, {
    key: parsed.data.key,
    documentId,
    reason: parsed.data.reason,
    amountAgorot: amount.agorot,
  });
  switch (outcome.status) {
    case "error":
      return fail(dbErrorMessage(outcome.error), { values });
    case "failed":
      return fail("תשובה לא צפויה. נסו שוב.", { values });
    case "queued":
      break;
  }
  // the provider is asked in the background (owner (398) א); the request's page shows it waiting, then the credit invoice
  revalidatePath(creditDocumentPath(orgId, documentId));
  redirect(issueRequestPath(orgId, outcome.requestId));
}
