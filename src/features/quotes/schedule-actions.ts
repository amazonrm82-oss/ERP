"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";

import { quoteDocumentPath, quotePath } from "./paths";
import { SCHEDULE_FIELD_NAMES, SCHEDULE_MAX, scheduleStepSchema } from "./schedule";

// GAP-09: the steps of a quote's payment schedule, written with the user's session. RLS lets whoever may edit the draft
// write them; the database keeps the caps (20 steps, never over 100%) and locks them once the quote is sent.

const CANNOT_EDIT = "אי אפשר לשנות את לוח התשלומים. ייתכן שההצעה כבר לא טיוטה, או שאין לכם הרשאה לערוך אותה.";

function writeError(error: { code?: string; message?: string; hint?: string }): string {
  if (error.code === "42501") return CANNOT_EDIT;
  return dbErrorMessage(error);
}

function revalidate(orgId: string, quoteId: string) {
  revalidatePath(quotePath(orgId, quoteId));
  revalidatePath(quoteDocumentPath(orgId, quoteId));
}

function parse(formData: FormData) {
  const raw: Record<string, string> = {};
  for (const name of SCHEDULE_FIELD_NAMES) {
    const value = formData.get(name);
    raw[name] = typeof value === "string" ? value : "";
  }
  return scheduleStepSchema.safeParse(raw);
}

/** A new step at the end of the schedule. */
export async function addScheduleStepAction(orgId: string, quoteId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const parsed = parse(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const { supabase } = context;
  const values = formValues(formData);
  const last = await supabase
    .from("quote_payment_steps")
    .select("position")
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.error) return fail(writeError(last.error), { values });
  const { error } = await supabase.from("quote_payment_steps").insert({
    organization_id: orgId,
    quote_id: quoteId,
    position: (last.data?.position ?? -1) + 1,
    name: parsed.data.name,
    percent_bp: parsed.data.percent,
    due_date: parsed.data.due_date,
    milestone: parsed.data.milestone,
  });
  if (error) {
    if (error.hint === "quote_schedule:max") return fail(`אפשר עד ${SCHEDULE_MAX} תשלומים בלוח אחד.`, { values });
    return fail(writeError(error), { values });
  }
  revalidate(orgId, quoteId);
  return { ok: true, message: "התשלום נוסף ללוח." };
}

/** A step changed in place. */
export async function updateScheduleStepAction(orgId: string, quoteId: string, stepId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, quoteId, stepId);
  if (!context.ok) return context;
  const parsed = parse(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = formValues(formData);
  const { data, error } = await context.supabase
    .from("quote_payment_steps")
    .update({ name: parsed.data.name, percent_bp: parsed.data.percent, due_date: parsed.data.due_date, milestone: parsed.data.milestone })
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    .eq("id", stepId)
    .select("id");
  if (error) return fail(writeError(error), { values });
  if (data.length === 0) return fail(CANNOT_EDIT, { values });
  revalidate(orgId, quoteId);
  return { ok: true, message: "התשלום נשמר." };
}

/** A step removed. */
export async function deleteScheduleStepAction(orgId: string, quoteId: string, stepId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId, stepId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("quote_payment_steps")
    .delete()
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    .eq("id", stepId)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidate(orgId, quoteId);
  return ok();
}
