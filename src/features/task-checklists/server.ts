import "server-only";

import { z } from "zod";

import type { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

import { CHECKLIST_STEPS_PER_TASK, nextPositions } from "./templates";

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

/** The task's current steps (positions), read with the user's session; null when the task is not visible. */
async function currentSteps(supabase: Supabase, orgId: string, taskId: string) {
  const [task, steps] = await Promise.all([
    supabase.from("tasks").select("id").eq("organization_id", orgId).eq("id", taskId).is("deleted_at", null).maybeSingle(),
    supabase.from("task_checklist_items").select("position").eq("organization_id", orgId).eq("task_id", taskId),
  ]);
  if (task.error) return { error: dbErrorMessage(task.error) };
  if (steps.error) return { error: dbErrorMessage(steps.error) };
  if (!task.data) return { error: NOT_FOUND_OR_FORBIDDEN };
  return { steps: steps.data };
}

/** Adds steps at the end of a task's checklist; the database decides who may (whoever may update the task). */
export async function appendSteps(supabase: Supabase, orgId: string, taskId: string, titles: string[]): Promise<ActionResult> {
  const current = await currentSteps(supabase, orgId, taskId);
  if ("error" in current) return fail(current.error ?? NOT_FOUND_OR_FORBIDDEN);
  if (current.steps.length + titles.length > CHECKLIST_STEPS_PER_TASK) {
    return fail(`אפשר עד ${CHECKLIST_STEPS_PER_TASK} שלבים במשימה אחת.`);
  }
  const positions = nextPositions(current.steps, titles.length);
  const { error } = await supabase
    .from("task_checklist_items")
    .insert(titles.map((title, i) => ({ organization_id: orgId, task_id: taskId, title, position: positions[i] })));
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את השלבים. נסו שוב."));
  return ok();
}

/** Used by the new-task form: the picked template's steps go into the new task. */
export async function stepsForNewTask(supabase: Supabase, orgId: string, taskId: string, templateId: string): Promise<ActionResult> {
  if (!z.guid().safeParse(templateId).success) return fail(INVALID_ARGS);
  const template = await supabase.from("checklist_templates").select("steps").eq("organization_id", orgId).eq("id", templateId).maybeSingle();
  if (template.error) return fail(dbErrorMessage(template.error));
  if (!template.data) return fail("התבנית כבר לא קיימת.");
  return appendSteps(supabase, orgId, taskId, template.data.steps);
}

