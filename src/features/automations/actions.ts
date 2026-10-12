"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";

import { toDbRule } from "./convert";
import { readLookups } from "./queries";
import { ruleSchema } from "./schema";
import { TEMPLATES } from "./templates";

const RUN_MESSAGES: Record<string, string> = {
  success: "הבדיקה הסתיימה: כל הפעולות בוצעו.",
  partial: "הבדיקה הסתיימה: חלק מהפעולות נכשלו. הפרטים ביומן.",
  failed: "הבדיקה נכשלה. הפרטים ביומן.",
  skipped: "דולג: האוטומציה כבר רצה 20 פעמים היום על הרשומה הזו.",
};

async function insertRule(orgId: string, raw: unknown, templateKey: string | null): Promise<ActionResult<{ id: string }>> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "יש לבדוק את הפרטים.");
  }
  const lookups = await readLookups(orgId);
  if (lookups.error) {
    return fail(dbErrorMessage(lookups.error));
  }
  const rule = toDbRule(parsed.data, lookups.data);
  if (typeof rule === "string") {
    return fail(rule);
  }
  const { data, error } = await context.supabase
    .from("automations")
    .insert({ organization_id: orgId, template_key: templateKey, ...rule })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את האוטומציה. נסו שוב."));
  }
  revalidatePath(paths.settingsAutomations(orgId));
  return ok({ id: data.id });
}

/** From the builder: the rule arrives as JSON in the "rule" field. */
export async function createAutomationAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("rule") ?? ""));
  } catch {
    return fail("לא הצלחנו לקרוא את האוטומציה. רעננו את הדף ונסו שוב.");
  }
  const result = await insertRule(orgId, raw, null);
  if (!result.ok) {
    return result;
  }
  redirect(paths.settingsAutomation(orgId, result.data!.id));
}

/** Saves changes to an existing rule. Its record type stays (the database does not let it change). */
export async function updateAutomationAction(orgId: string, id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("rule") ?? ""));
  } catch {
    return fail("לא הצלחנו לקרוא את האוטומציה. רעננו את הדף ונסו שוב.");
  }
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "יש לבדוק את הפרטים.");
  }
  const lookups = await readLookups(orgId);
  if (lookups.error) {
    return fail(dbErrorMessage(lookups.error));
  }
  const rule = toDbRule(parsed.data, lookups.data);
  if (typeof rule === "string") {
    return fail(rule);
  }
  const { data: current, error: currentError } = await context.supabase.from("automations").select("entity_type").eq("organization_id", orgId).eq("id", id).maybeSingle();
  if (currentError) return fail(dbErrorMessage(currentError));
  if (!current) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (current.entity_type !== rule.entity_type) {
    return fail("אי אפשר לשנות את סוג הרשומה של אוטומציה קיימת. אפשר ליצור אוטומציה חדשה.");
  }
  const { data, error } = await context.supabase
    .from("automations")
    .update({ name: rule.name, trigger_type: rule.trigger_type, trigger_config: rule.trigger_config, conditions: rule.conditions, actions: rule.actions })
    .eq("organization_id", orgId)
    .eq("id", id)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את האוטומציה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsAutomations(orgId));
  revalidatePath(paths.settingsAutomation(orgId, id));
  redirect(paths.settingsAutomation(orgId, id));
}

export async function createFromTemplateAction(orgId: string, templateKey: string): Promise<ActionResult> {
  const template = TEMPLATES.find((t) => t.key === templateKey);
  if (!template?.build) {
    return fail(NOT_FOUND);
  }
  const lookups = await readLookups(orgId);
  if (lookups.error) {
    return fail(dbErrorMessage(lookups.error));
  }
  const rule = template.build(lookups.data);
  if (!rule) {
    return fail("התבנית צריכה סטטוס שלא קיים אצלכם (למשל \"לא ענה\"). אפשר לבנות אוטומציה דומה בעצמכם.");
  }
  const result = await insertRule(orgId, rule, template.key);
  if (!result.ok) {
    return result;
  }
  redirect(paths.settingsAutomation(orgId, result.data!.id));
}

export async function setAutomationActiveAction(orgId: string, id: string, active: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, active)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("automations")
    .update({ is_active: active === true })
    .eq("organization_id", orgId)
    .eq("id", id)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsAutomations(orgId));
  revalidatePath(paths.settingsAutomation(orgId, id));
  return ok();
}

export async function deleteAutomationAction(orgId: string, id: string): Promise<ActionResult> {
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("automations").delete().eq("organization_id", orgId).eq("id", id).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsAutomations(orgId));
  redirect(paths.settingsAutomations(orgId));
}

/** Runs the rule now on one record (its conditions are not checked). */
export async function testRunAction(orgId: string, id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const entityId = String(formData.get("entity_id") ?? "");
  if (!isUuid(entityId)) {
    return fail("יש לבחור רשומה לבדיקה.");
  }
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.rpc("run_automation_now", { p_automation_id: id, p_entity_id: entityId });
  if (error) {
    return fail(dbErrorMessage(error, "הבדיקה לא הצליחה. נסו שוב."));
  }
  const status = data && typeof data === "object" && !Array.isArray(data) ? String(data.status ?? "") : "";
  revalidatePath(paths.settingsAutomation(orgId, id));
  return { ok: true, message: RUN_MESSAGES[status] ?? "הבדיקה הסתיימה." };
}
