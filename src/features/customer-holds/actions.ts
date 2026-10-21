"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { holdReasonSchema } from "./schema";

// COL-05: setting and lifting a hold, with the user's session; RLS and the table's trigger decide (answer 1 (א)).

const CANNOT = "אין לכם הרשאה לסמן לקוח. מסמנים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים.";
const subjectSchema = z.object({ kind: z.enum(["contact", "company"]), id: z.guid() });
type Subject = z.infer<typeof subjectSchema>;
const pageOf = (orgId: string, s: Subject) => (s.kind === "contact" ? paths.contact(orgId, s.id) : paths.company(orgId, s.id));
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

export async function setHoldAction(orgId: string, subject: Subject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) return context;
  const parsed = z.object({ reason: holdReasonSchema }).safeParse({ reason: formData.get("reason") ?? "" });
  if (!parsed.success) return invalid(parsed.error, formData);
  const { error } = await context.supabase.from("customer_holds").insert({
    organization_id: orgId,
    contact_id: subject.kind === "contact" ? subject.id : null,
    company_id: subject.kind === "company" ? subject.id : null,
    reason: parsed.data.reason,
  });
  if (error) return fail(writeError(error), { values: formValues(formData) });
  revalidatePath(pageOf(orgId, subject));
  return ok();
}

export async function liftHoldAction(orgId: string, subject: Subject, holdId: string): Promise<ActionResult> {
  if (!validArg(subjectSchema, subject)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, subject.id, holdId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("customer_holds")
    .update({ cleared_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", holdId)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT);
  revalidatePath(pageOf(orgId, subject));
  return ok();
}
