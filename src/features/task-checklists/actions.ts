"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { checklistTemplatesPath } from "./paths";
import { appendSteps } from "./server";
import { stepTitleSchema, templateSchema } from "./templates";

const TEMPLATE_NAME_TAKEN = "כבר יש תבנית בשם הזה. בחרו שם אחר.";

function revalidateTasks(orgId: string) {
  revalidatePath(paths.org(orgId));
  revalidatePath(paths.tasks(orgId));
}

export async function addStepAction(orgId: string, taskId: string, title: string): Promise<ActionResult> {
  const parsed = stepTitleSchema.safeParse(title);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? INVALID_ARGS);
  const context = await actionContext(orgId, taskId);
  if (!context.ok) return context;
  const result = await appendSteps(context.supabase, orgId, taskId, [parsed.data]);
  if (result.ok) revalidateTasks(orgId);
  return result;
}

export async function toggleStepAction(orgId: string, stepId: string, done: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, done)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, stepId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("task_checklist_items")
    .update({ done })
    .eq("organization_id", orgId)
    .eq("id", stepId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateTasks(orgId);
  return ok();
}

export async function deleteStepAction(orgId: string, stepId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, stepId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("task_checklist_items").delete().eq("organization_id", orgId).eq("id", stepId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateTasks(orgId);
  return ok();
}

/** Copies a template's steps to the end of a task's checklist. A later change to the template changes no task. */
export async function applyTemplateAction(orgId: string, taskId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, taskId, templateId);
  if (!context.ok) return context;
  const template = await context.supabase.from("checklist_templates").select("steps").eq("organization_id", orgId).eq("id", templateId).maybeSingle();
  if (template.error) return fail(dbErrorMessage(template.error));
  if (!template.data) return fail("התבנית כבר לא קיימת. רעננו את הדף.");
  const result = await appendSteps(context.supabase, orgId, taskId, template.data.steps);
  if (result.ok) revalidateTasks(orgId);
  return result;
}

// ----------------------------------------------------------------------------
// Templates (owners and admins; the database decides)
// ----------------------------------------------------------------------------

function templateError(error: { code?: string }, formData: FormData) {
  return fail(error.code === "23505" ? TEMPLATE_NAME_TAKEN : dbErrorMessage(error, "לא הצלחנו לשמור את התבנית. נסו שוב."), {
    values: formValues(formData),
  });
}

export async function createTemplateAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = templateSchema.safeParse(pick(formData, ["name", "steps"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const last = await context.supabase.from("checklist_templates").select("position").eq("organization_id", orgId).order("position", { ascending: false }).limit(1);
  if (last.error) return fail(dbErrorMessage(last.error));
  const { error } = await context.supabase.from("checklist_templates").insert({
    organization_id: orgId,
    name: parsed.data.name,
    steps: parsed.data.steps,
    position: (last.data[0]?.position ?? -1) + 1,
  });
  if (error) return templateError(error, formData);
  revalidatePath(checklistTemplatesPath(orgId));
  return { ok: true, message: "התבנית נוספה." };
}

export async function updateTemplateAction(orgId: string, templateId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const parsed = templateSchema.safeParse(pick(formData, ["name", "steps"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("checklist_templates")
    .update({ name: parsed.data.name, steps: parsed.data.steps })
    .eq("organization_id", orgId)
    .eq("id", templateId)
    .select("id");
  if (error) return templateError(error, formData);
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(checklistTemplatesPath(orgId));
  return { ok: true, message: "התבנית נשמרה." };
}

export async function deleteTemplateAction(orgId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("checklist_templates").delete().eq("organization_id", orgId).eq("id", templateId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(checklistTemplatesPath(orgId));
  return ok();
}
