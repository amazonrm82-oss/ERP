"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import {
  fail,
  formValues,
  invalid,
  ok,
  type ActionResult,
  type FormState,
} from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { collectionPath } from "@/features/payments/paths";
import {
  MONEY_SUBJECT_KINDS,
  moneySubjectPath,
} from "@/features/payments/money-subject";

import { paths } from "@/lib/paths";

import { coverageOf, coveredText, promiseSchema } from "./promise";

// COL-03: a payment promise on one document or on the whole customer (owner's answer (1) ג), saved with the user's session.
// RLS and the table's triggers decide: owners, admins and managers, or the record_payments key, in a writable business with
// the collection key, on a subject the user reads; the date from today up to a year ahead; a customer promise covers the
// customer's documents open right now. One promise per subject: saving changes it (date, note), removing deletes it.

const CANNOT =
  "אין לכם הרשאה לרשום הבטחת תשלום כאן. רושמים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים.";
const writeError = (error: {
  code?: string;
  message?: string;
  hint?: string;
}) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

// where the form was opened: the collection screen, a deal's, contact's or order's card, or (answer (8) ב) a company's card
const backSchema = z.union([
  z.object({ kind: z.literal("collection") }),
  z.object({ kind: z.enum(MONEY_SUBJECT_KINDS), id: z.guid() }),
  z.object({ kind: z.literal("company"), id: z.guid() }),
]);
export type PromiseBack = z.infer<typeof backSchema>;

// what the promise is on: one document, or the whole customer (a contact without a company, or a company)
const targetSchema = z.object({
  kind: z.enum(["document", "contact", "company"]),
  id: z.guid(),
});
export type PromiseTarget = z.infer<typeof targetSchema>;
const COLUMN = {
  document: "document_id",
  contact: "contact_id",
  company: "company_id",
} as const;

const pageOf = (orgId: string, back: PromiseBack) =>
  back.kind === "collection"
    ? collectionPath(orgId)
    : back.kind === "company"
      ? paths.company(orgId, back.id)
      : moneySubjectPath(orgId, back);

export async function savePromiseAction(
  orgId: string,
  target: PromiseTarget,
  back: PromiseBack,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!validArg(backSchema, back) || !validArg(targetSchema, target))
    return fail(INVALID_ARGS);
  const column = COLUMN[target.kind];
  const context = await actionContext(orgId, target.id);
  if (!context.ok) return context;
  const parsed = promiseSchema.safeParse({
    promised_date: formData.get("promised_date") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = {
    promised_date: parsed.data.promised_date,
    note: parsed.data.note || null,
  };
  const existing = await context.supabase
    .from("payment_promises")
    .select("id")
    .eq("organization_id", orgId)
    .eq(column, target.id)
    .maybeSingle();
  if (existing.error)
    return fail(dbErrorMessage(existing.error), {
      values: formValues(formData),
    });
  const update = async () => {
    const { data, error } = await context.supabase
      .from("payment_promises")
      .update(values)
      .eq("organization_id", orgId)
      .eq(column, target.id)
      .select("id");
    if (error) return fail(writeError(error), { values: formValues(formData) });
    if (data.length === 0)
      return fail(CANNOT, { values: formValues(formData) });
    return null;
  };
  if (existing.data) {
    const failed = await update();
    if (failed) return failed;
  } else {
    const { error } = await context.supabase.from("payment_promises").insert({
      organization_id: orgId,
      document_id: target.kind === "document" ? target.id : null,
      contact_id: target.kind === "contact" ? target.id : null,
      company_id: target.kind === "company" ? target.id : null,
      ...values,
    });
    // someone saved a promise on this subject meanwhile (one per subject): update it once instead (one-row rule)
    if (error?.code === "23505") {
      const failed = await update();
      if (failed) return failed;
    } else if (error) {
      return fail(writeError(error), { values: formValues(formData) });
    }
  }
  revalidatePath(pageOf(orgId, back));
  if (target.kind === "document") return ok();
  // answer (6) ב: a customer promise covers every open document of the customer; the person is told how many (a count only)
  const saved = await context.supabase
    .from("payment_promises")
    .select("id")
    .eq("organization_id", orgId)
    .eq(column, target.id)
    .maybeSingle();
  if (saved.error || !saved.data) return ok();
  const coverage = await context.supabase.rpc("payment_promise_coverage", {
    p_org: orgId,
    p_promises: [saved.data.id],
  });
  const covered = coverage.error ? null : coverageOf(coverage.data, saved.data.id);
  return covered === null
    ? ok()
    : { ok: true, message: `ההבטחה נשמרה. ${coveredText(covered)}.` };
}

export async function removePromiseAction(
  orgId: string,
  target: PromiseTarget,
  back: PromiseBack,
): Promise<ActionResult> {
  if (!validArg(backSchema, back) || !validArg(targetSchema, target))
    return fail(INVALID_ARGS);
  const context = await actionContext(orgId, target.id);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("payment_promises")
    .delete()
    .eq("organization_id", orgId)
    .eq(COLUMN[target.kind], target.id)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT);
  revalidatePath(pageOf(orgId, back));
  return ok();
}
