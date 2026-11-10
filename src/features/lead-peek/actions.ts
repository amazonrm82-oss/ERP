"use server";

import { z } from "zod";

import { logCallAction } from "@/features/activities/actions";
import { INVALID_ARGS, optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import type { TaskInsert } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { zonedIso } from "@/lib/format";

import { callBackProblem } from "./model";

// UX-01 (owner's answers 214-218): the side panel's "התקשרתי". Every write goes with the user's session through the
// lead page's own paths: the call is logCallAction's activity (TASK-02), the call-back a task linked to the lead.

const outcomeArg = z.enum(["answered", "no_answer"]);
const nameArg = z.string().max(400);

function callForm(outcome: string, note: string | null | undefined): FormData {
  const form = new FormData();
  form.set("outcome", outcome);
  form.set("body", note ?? "");
  form.set("next", "none");
  return form;
}

/** "ענה" / "לא ענה": one call entry with how it ended and an optional short note. */
export async function peekLogCallAction(
  orgId: string,
  leadId: string,
  leadName: string,
  outcome: "answered" | "no_answer",
  note: string | null,
): Promise<ActionResult> {
  if (!validArg(outcomeArg, outcome) || !validArg(nameArg, leadName) || !validArg(optionalTextArg(5000), note)) {
    return fail(INVALID_ARGS);
  }
  const state = await logCallAction(orgId, { kind: "lead", id: leadId }, leadName, null, callForm(outcome, note));
  return state?.ok ? ok() : fail(state?.message ?? "לא הצלחנו לשמור את השיחה. נסו שוב.");
}

/**
 * "לחזור ב…": the call entry (asked to call back) and a call task "לחזור אל <name>" linked to the lead, due at the
 * picked time in the business's zone, with a reminder at that time (app.send_task_reminders). The task is the
 * caller's (the database assigns it).
 */
export async function peekCallBackAction(
  orgId: string,
  leadId: string,
  leadName: string,
  date: string,
  time: string,
  note: string | null,
): Promise<ActionResult> {
  if (!validArg(z.string().max(10), date) || !validArg(z.string().max(5), time) || !validArg(nameArg, leadName) || !validArg(optionalTextArg(5000), note)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, leadId);
  if (!context.ok) return context;
  const org = await context.supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (org.error) return fail(dbErrorMessage(org.error));
  const timeZone = org.data?.timezone || undefined;
  const due = (day: string, at: string) => zonedIso(day, `${at}:00`, timeZone);
  const problem = callBackProblem(date, time, new Date(), due);
  if (problem) return fail(problem);

  const state = await logCallAction(orgId, { kind: "lead", id: leadId }, leadName, null, callForm("call_back", note));
  if (!state?.ok) return fail(state?.message ?? "לא הצלחנו לשמור את השיחה. נסו שוב.");

  const dueAt = due(date, time);
  const task: TaskInsert = {
    organization_id: orgId,
    lead_id: leadId,
    title: `לחזור אל ${leadName.trim().slice(0, 200)}`,
    task_type: "call",
    due_at: dueAt,
    remind_at: dueAt,
  };
  const { error } = await context.supabase.from("tasks").insert(task);
  if (error) {
    // the call is saved; say so, and that the task is missing
    return fail(`השיחה נשמרה, אבל לא הצלחנו ליצור את משימת "לחזור". אפשר להוסיף אותה ממשימה. (${dbErrorMessage(error)})`);
  }
  return ok();
}
