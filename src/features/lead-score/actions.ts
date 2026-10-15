"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, formValues, ok, FORM_INVALID, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import type { createClient } from "@/lib/supabase/server";

import { leadScoreSettingsPath } from "./paths";
import { getScoreLookups } from "./queries";
import { parseRule } from "./rules";

// LEAD-05: owners and admins manage the score rules; RLS refuses everyone else (0 rows / 42501).
// After a change the scores are recomputed: one batch at once (a small business sees them right
// away), the rest by the database's background job.

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function recomputeNow(supabase: Supabase, orgId: string) {
  // a failure here is not the user's problem: the background job does the same within a minute
  const { error } = await supabase.rpc("lead_scores_refresh", { p_org: orgId });
  if (error) {
    console.error("lead score recompute failed", error.message);
  }
}

function revalidateScores(orgId: string) {
  revalidatePath(leadScoreSettingsPath(orgId));
  // the score column on the list and the card of every lead
  revalidatePath(paths.leads(orgId), "layout");
}

export async function addScoreRuleAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  const lookups = await getScoreLookups(orgId);
  const parsed = parseRule({ field: text("field"), op: text("op"), value: text("value"), direction: text("direction"), points: text("points") }, lookups);
  if (!parsed.ok) {
    return fail(FORM_INVALID, { fieldErrors: parsed.fieldErrors, values: formValues(formData) });
  }
  const { count, error: countError } = await context.supabase
    .from("lead_score_rules")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (countError) {
    return fail(dbErrorMessage(countError), { values: formValues(formData) });
  }
  const { error } = await context.supabase.from("lead_score_rules").insert({ organization_id: orgId, ...parsed.rule, position: count ?? 0 });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את הכלל. נסו שוב."), { values: formValues(formData) });
  }
  await recomputeNow(context.supabase, orgId);
  revalidateScores(orgId);
  return ok();
}

/** A hidden rule stays in the list but stops counting. */
export async function setScoreRuleActiveAction(orgId: string, ruleId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, ruleId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("lead_score_rules")
    .update({ is_active: isActive === true })
    .eq("organization_id", orgId)
    .eq("id", ruleId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  await recomputeNow(context.supabase, orgId);
  revalidateScores(orgId);
  return ok();
}

export async function deleteScoreRuleAction(orgId: string, ruleId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, ruleId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("lead_score_rules").delete().eq("organization_id", orgId).eq("id", ruleId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  await recomputeNow(context.supabase, orgId);
  revalidateScores(orgId);
  return ok();
}

/**
 * A business with no rules adds the five suggested ones (owners and admins; the database adds
 * nothing when the business already has a rule). Its existing leads are then rescored.
 */
export async function addSuggestedScoreRulesAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.rpc("lead_score_rules_suggest", { p_org: orgId });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את הכללים. נסו שוב."));
  }
  if (data === 0) {
    revalidateScores(orgId);
    return fail("כבר יש לעסק כללי ניקוד, ולכן הכללים המוצעים לא נוספו.");
  }
  await recomputeNow(context.supabase, orgId);
  revalidateScores(orgId);
  return ok();
}
