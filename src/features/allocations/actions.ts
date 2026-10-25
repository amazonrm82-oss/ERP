"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { MONEY_SUBJECT_KINDS, moneySubjectPath } from "@/features/payments/money-subject";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";

import { parseCandidates, type AllocationCandidates } from "./state";

// PAY-02: allocating payments to documents, changing or undoing an allocation, and naming the proforma a tax invoice bills,
// with the user's session. RLS and the triggers decide: whoever records payments allocates (both plan keys); owners and
// admins change the amount or undo; the same customer, never more than either side holds.

const CANNOT = "אין לכם הרשאה לשייך תשלומים כאן. משייכים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים.";
const CANNOT_CHANGE = "שינוי וביטול של שיוך רק לבעלים ולמנהלי מערכת.";
const writeError = (error: { code?: string; message?: string; hint?: string }, cannot = CANNOT) => (error.code === "42501" ? cannot : dbErrorMessage(error));

const pageSchema = z.object({ kind: z.enum(MONEY_SUBJECT_KINDS), id: z.guid() });
type Page = z.infer<typeof pageSchema>;

const rowsSchema = z
  .array(z.object({ paymentId: z.guid(), documentId: z.guid(), amount: z.number().int().positive().max(1_000_000_000_000) }))
  .min(1)
  .max(100);

/** One or more allocations, all or nothing (one insert). */
export async function allocateAction(orgId: string, page: Page, rows: { paymentId: string; documentId: string; amount: number }[]): Promise<ActionResult> {
  if (!validArg(pageSchema, page) || !validArg(rowsSchema, rows)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, page.id);
  if (!context.ok) return context;
  const { error } = await context.supabase.from("payment_allocations").insert(
    rows.map((row) => ({ organization_id: orgId, payment_id: row.paymentId, document_id: row.documentId, amount_agorot: row.amount })),
  );
  if (error) return fail(writeError(error));
  revalidatePath(moneySubjectPath(orgId, page));
  return ok();
}

/** Owners and admins: a new amount for an allocation. */
export async function changeAllocationAction(orgId: string, page: Page, allocationId: string, amount: number): Promise<ActionResult> {
  if (!validArg(pageSchema, page) || !validArg(z.number().int().positive().max(1_000_000_000_000), amount)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, page.id, allocationId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("payment_allocations")
    .update({ amount_agorot: amount })
    .eq("organization_id", orgId)
    .eq("id", allocationId)
    .select("id");
  if (error) return fail(writeError(error, CANNOT_CHANGE));
  if (data.length === 0) return fail(CANNOT_CHANGE);
  revalidatePath(moneySubjectPath(orgId, page));
  return ok();
}

/** Owners and admins: undoes an allocation (it stays in the history, no longer counted). */
export async function undoAllocationAction(orgId: string, page: Page, allocationId: string): Promise<ActionResult> {
  if (!validArg(pageSchema, page)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, page.id, allocationId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("payment_allocations")
    .update({ removed_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", allocationId)
    .select("id");
  if (error) return fail(writeError(error, CANNOT_CHANGE));
  if (data.length === 0) return fail(CANNOT_CHANGE);
  revalidatePath(moneySubjectPath(orgId, page));
  return ok();
}

const CANNOT_LINK = "אין לכם הרשאה לעדכן מסמכים כאן. מעדכנים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום מסמכים.";

/** Answer 2: the tax invoice names the proforma it bills (once). */
export async function linkProformaAction(orgId: string, page: Page, invoiceId: string, proformaId: string): Promise<ActionResult> {
  if (!validArg(pageSchema, page)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, page.id, invoiceId, proformaId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("accounting_documents")
    .update({ proforma_id: proformaId })
    .eq("organization_id", orgId)
    .eq("id", invoiceId)
    .select("id");
  if (error) return fail(error.code === "42501" ? CANNOT_LINK : dbErrorMessage(error));
  if (data.length === 0) return fail(CANNOT_LINK);
  revalidatePath(moneySubjectPath(orgId, page));
  return ok();
}

/** What the window offers, read when it opens (answer 8): one read per window, not one per row of a card. */
export async function allocationOptionsAction(orgId: string, from: { kind: "payment" | "document"; id: string }): Promise<ActionResult<AllocationCandidates>> {
  if (!validArg(z.object({ kind: z.enum(["payment", "document"]), id: z.guid() }), from)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, from.id);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("money_allocation_candidates", {
    p_org: orgId,
    p_payment: from.kind === "payment" ? from.id : null,
    p_document: from.kind === "document" ? from.id : null,
  });
  if (error) return fail(dbErrorMessage(error));
  return ok(parseCandidates(data));
}
