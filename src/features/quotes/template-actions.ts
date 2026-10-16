"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick, requiredText } from "@/lib/validation";

import { quotePath, quoteTemplatesPath } from "./paths";
import { readQuote } from "./queries";
import { applyTemplateToQuote } from "./template-server";
import { appliedText, QUOTE_TEMPLATE_NAME_MAX } from "./templates";

// QUO-04. Every write goes with the user's session: templates are written by owners and admins of a
// writable business (RLS), and using one adds lines to a draft the user may edit (RLS on quote_lines).

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשמור ולשנות תבניות.";
const NAME_TAKEN = "כבר יש תבנית בשם הזה. בחרו שם אחר.";

const nameSchema = z.object({
  name: requiredText(QUOTE_TEMPLATE_NAME_MAX, "יש להזין שם לתבנית.", `השם ארוך מדי (עד ${QUOTE_TEMPLATE_NAME_MAX} תווים).`),
});

function templateError(error: { code?: string; message?: string; hint?: string }): string {
  if (error.code === "23505") return NAME_TAKEN;
  if (error.code === "42501") return NOT_ADMIN;
  return dbErrorMessage(error);
}

/** The quote's lines, notes and terms saved as a new template. */
export async function saveQuoteAsTemplateAction(orgId: string, quoteId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const parsed = nameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { error } = await context.supabase.rpc("quote_template_save", { p_org: orgId, p_quote: quoteId, p_name: parsed.data.name });
  if (error) {
    const message = templateError(error);
    return fail(message, { ...(error.code === "23505" ? { fieldErrors: { name: message } } : {}), values: formValues(formData) });
  }
  revalidatePath(quoteTemplatesPath(orgId));
  revalidatePath(quotePath(orgId, quoteId));
  return { ok: true, message: "התבנית נשמרה. אפשר לבחור בה כשיוצרים הצעה חדשה." };
}

export async function renameQuoteTemplateAction(orgId: string, templateId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const parsed = nameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("quote_templates")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", templateId)
    .select("id");
  if (error) {
    const message = templateError(error);
    return fail(message, { ...(error.code === "23505" ? { fieldErrors: { name: message } } : {}), values: formValues(formData) });
  }
  if (data.length === 0) return fail(NOT_ADMIN, { values: formValues(formData) });
  revalidatePath(quoteTemplatesPath(orgId));
  return { ok: true, message: "השם עודכן." };
}

export async function deleteQuoteTemplateAction(orgId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("quote_templates").delete().eq("organization_id", orgId).eq("id", templateId).select("id");
  if (error) return fail(templateError(error));
  if (data.length === 0) return fail(NOT_ADMIN);
  revalidatePath(quoteTemplatesPath(orgId));
  return ok();
}

/** A template's lines added to a draft quote (the editor's "מתבנית"). */
export async function applyQuoteTemplateAction(orgId: string, quoteId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId, templateId);
  if (!context.ok) return context;
  const quote = await readQuote(context.supabase, orgId, quoteId);
  if (!quote) return fail(NOT_FOUND_OR_FORBIDDEN);
  const result = await applyTemplateToQuote(context.supabase, orgId, quote, templateId);
  if (!result.ok) return fail(result.message);
  revalidatePath(quotePath(orgId, quoteId));
  if (quote.dealId) revalidatePath(paths.deal(orgId, quote.dealId));
  if (quote.contactId) revalidatePath(paths.contact(orgId, quote.contactId));
  return { ok: true, message: appliedText(result.added, result.skipped) };
}
