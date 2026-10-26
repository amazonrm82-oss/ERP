"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { dbErrorMessage } from "@/lib/errors";

import { RETENTION_MONTHS_MAX, RETENTION_MONTHS_MIN } from "./model";
import { retentionListPath, retentionSettingsPath } from "./paths";
import { retentionPreviewSchema, type RetentionPreview } from "./schema";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת של עסק פעיל יכולים לשנות את מדיניות השמירה.";
const monthsError = `מספר החודשים צריך להיות בין ${RETENTION_MONTHS_MIN} ל-${RETENTION_MONTHS_MAX}.`;
const monthsArg = z.number().int().min(RETENTION_MONTHS_MIN).max(RETENTION_MONTHS_MAX);
const monthsSchema = z.object({
  months: z.coerce.number({ error: monthsError }).int({ error: monthsError }).min(RETENTION_MONTHS_MIN, { error: monthsError }).max(RETENTION_MONTHS_MAX, { error: monthsError }),
});

/** PRV-01: how many leads the policy would take with these months (shown before it is confirmed). */
export async function previewRetentionAction(orgId: string, _prev: FormState<RetentionPreview>, formData: FormData): Promise<FormState<RetentionPreview>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = monthsSchema.safeParse({ months: formData.get("months") });
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase.rpc("lead_retention_preview", { p_org: orgId, p_months: parsed.data.months });
  if (error) return fail(error.code === "42501" ? NOT_ADMIN : dbErrorMessage(error), { values: formValues(formData) });
  return { ok: true, data: retentionPreviewSchema.parse(data) };
}

/** PRV-01: turns the policy on, or changes its months, after the preview (the confirmation is the dialog's button). */
export async function enableRetentionAction(orgId: string, months: number): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  if (!validArg(monthsArg, months)) return fail(INVALID_ARGS);
  const { error } = await context.supabase.rpc("lead_retention_set", { p_org: orgId, p_enabled: true, p_months: months, p_confirm: true });
  if (error) return fail(error.code === "42501" ? NOT_ADMIN : dbErrorMessage(error));
  revalidatePath(retentionSettingsPath(orgId));
  return { ok: true };
}

/** PRV-01: turns the policy off; the open round stops and nothing more moves to the bin. */
export async function disableRetentionAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("lead_retention_set", { p_org: orgId, p_enabled: false, p_months: null, p_confirm: false });
  if (error) return fail(error.code === "42501" ? NOT_ADMIN : dbErrorMessage(error));
  revalidatePath(retentionSettingsPath(orgId));
  return { ok: true };
}

/** PRV-01: "keep" one lead of the open round; its count starts again. */
export async function keepRetentionLeadAction(orgId: string, leadId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, leadId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("lead_retention_keep", { p_org: orgId, p_lead: leadId });
  if (error) return fail(error.code === "42501" ? NOT_ADMIN : dbErrorMessage(error));
  revalidatePath(retentionListPath(orgId));
  revalidatePath(retentionSettingsPath(orgId));
  return { ok: true };
}
