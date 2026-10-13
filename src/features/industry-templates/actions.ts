"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, type FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { applyTemplate } from "./apply";
import { describeApplyResult, templateKeyArg } from "./schema";

/** Business details page: applies the chosen industry template. */
export async function applyIndustryTemplateAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData);
  const parsed = templateKeyArg.safeParse(formData.get("template"));
  if (!parsed.success) {
    return fail("יש לבחור תבנית מהרשימה.", { fieldErrors: { template: "יש לבחור תבנית מהרשימה." }, values });
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const result = await applyTemplate(context.supabase, orgId, parsed.data);
  if (!result.ok) {
    return fail(result.message, { values });
  }
  // the lists show on many pages (settings, boards, forms, the record cards)
  revalidatePath(paths.org(orgId), "layout");
  return { ok: true, message: describeApplyResult(result.data!) };
}
