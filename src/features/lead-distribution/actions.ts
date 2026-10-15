"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, FORM_INVALID, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { distributionSettingsPath } from "./paths";
import { parseDistributionForm, RULE_FIELD_NAMES, ruleSchema } from "./schema";
import { weightsToSave } from "./settings";

// CAP-08: owners and admins of a writable business change the settings and the rules; RLS
// refuses everyone else (0 rows / 42501), and the database checks the plan key (hint
// feature:lead_distribution), the weights and the 50-rule cap.

const SAVE_FAILED = "לא הצלחנו לשמור את חלוקת הלידים. נסו שוב.";

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

/** Saves the method and the weights (only weights other than 1 are stored). */
export async function saveDistributionAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseDistributionForm(formData);
  if (!parsed.ok) {
    return fail(FORM_INVALID, { fieldErrors: parsed.fieldErrors, values: formValues(formData) });
  }
  const values = { method: parsed.method, weights: weightsToSave(parsed.weights) };
  const update = () => context.supabase.from("lead_distribution_settings").update(values).eq("organization_id", orgId).select("id");

  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("lead_distribution_settings").insert({ organization_id: orgId, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) {
    return fail(dbErrorMessage(error, SAVE_FAILED), { values: formValues(formData) });
  }
  if ((data?.length ?? 0) === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(distributionSettingsPath(orgId));
  return { ok: true, message: "חלוקת הלידים נשמרה." };
}

async function rulesOf(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("lead_routing_rules")
    .select("id, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return { data: data ?? [], error };
}

/** Adds a rule at the end of the list. */
export async function addRuleAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = ruleSchema.safeParse(pick(formData, RULE_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await rulesOf(context, orgId);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const position = existing.data.reduce((max, rule) => Math.max(max, rule.position + 1), 0);
  const { error } = await context.supabase.from("lead_routing_rules").insert({ organization_id: orgId, position: Math.min(position, 10000), ...parsed.data });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את הכלל. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(distributionSettingsPath(orgId));
  return ok();
}

/** A rule switched off is kept but no longer used. */
export async function setRuleActiveAction(orgId: string, ruleId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, ruleId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("lead_routing_rules")
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
  revalidatePath(distributionSettingsPath(orgId));
  return ok();
}

/** Moves a rule one place up or down (the first matching rule wins). */
export async function moveRuleAction(orgId: string, ruleId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, ruleId);
  if (!context.ok) {
    return context;
  }
  const { data: ordered, error: readError } = await rulesOf(context, orgId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = ordered.findIndex((rule) => rule.id === ruleId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, rule] of ordered.entries()) {
    if (rule.position !== position) {
      const { data, error } = await context.supabase
        .from("lead_routing_rules")
        .update({ position })
        .eq("organization_id", orgId)
        .eq("id", rule.id)
        .select("id");
      if (error) {
        return fail(dbErrorMessage(error));
      }
      if (data.length === 0) {
        return fail(NOT_FOUND_OR_FORBIDDEN);
      }
    }
  }
  revalidatePath(distributionSettingsPath(orgId));
  return ok();
}

export async function deleteRuleAction(orgId: string, ruleId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, ruleId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("lead_routing_rules").delete().eq("organization_id", orgId).eq("id", ruleId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(distributionSettingsPath(orgId));
  return ok();
}
