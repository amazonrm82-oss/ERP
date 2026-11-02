"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { campaignCostsPath } from "./paths";
import { campaignCostSchema } from "./schema";

function refresh(orgId: string) {
  revalidatePath(campaignCostsPath(orgId));
  revalidatePath(paths.report(orgId, "campaign_roi"));
}

/** SEG-03: a campaign cost entered by hand. Owners, admins and managers of a writable business; the database decides. */
export async function addCampaignCostAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = campaignCostSchema.safeParse(pick(formData, ["source_id", "campaign", "month", "amount", "note", "amount_includes_vat"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { source_id, campaign, month, amount, note, amount_includes_vat } = parsed.data;
  const { error } = await context.supabase
    .from("campaign_costs")
    .insert({ organization_id: orgId, source_id, campaign, month, amount_agorot: amount, amount_includes_vat, note })
    .select("id")
    .single();
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את העלות. נסו שוב."), { values: formValues(formData) });
  refresh(orgId);
  return { ok: true, message: "העלות נשמרה." };
}

/** Changes a cost's amount, month, key or note. */
export async function updateCampaignCostAction(orgId: string, costId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, costId);
  if (!context.ok) return context;
  const parsed = campaignCostSchema.safeParse(pick(formData, ["source_id", "campaign", "month", "amount", "note", "amount_includes_vat"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { source_id, campaign, month, amount, note, amount_includes_vat } = parsed.data;
  const { data, error } = await context.supabase
    .from("campaign_costs")
    .update({ source_id, campaign, month, amount_agorot: amount, amount_includes_vat, note })
    .eq("organization_id", orgId)
    .eq("id", costId)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את העלות. נסו שוב."), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  refresh(orgId);
  return { ok: true, message: "השינוי נשמר." };
}

export async function deleteCampaignCostAction(orgId: string, costId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, costId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("campaign_costs").delete().eq("organization_id", orgId).eq("id", costId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  refresh(orgId);
  return ok();
}
