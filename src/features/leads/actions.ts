"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { duplicateMessage, findPersonDuplicate } from "@/features/data-quality/duplicates";
import type { MissingResult } from "@/features/custom-fields/conditions";
import { askedField, missingAfterChange, requiredFieldsMerge } from "@/features/custom-fields/required-server";
import { customFieldsFromForm, customFieldsPatch } from "@/features/custom-fields/server";
import { missingFieldsMessage } from "@/features/custom-fields/conditions";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, optionalTextArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { ConvertLeadResult } from "@/lib/database.types";
import { conversionErrorMessage, dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { setTrashed } from "@/lib/record-trash";
import { pick } from "@/lib/validation";

import {
  campaignInsert,
  campaignUpdate,
  changeStatusSchema,
  convertLeadSchema,
  createLeadSchema,
  LEAD_CAMPAIGN_FIELD_NAMES,
  LEAD_FIELD_NAMES,
  leadCampaignSchema,
  updateLeadSchema,
} from "./schema";
import { requestedProductFromForm } from "@/features/requested-product/schema";

import { setLeadStatus, validateStatusChoice } from "./status";

function revalidateLead(orgId: string, leadId?: string) {
  revalidatePath(paths.leads(orgId));
  revalidatePath(paths.org(orgId));
  if (leadId) {
    revalidatePath(paths.lead(orgId, leadId));
  }
}

export async function createLeadAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createLeadSchema.safeParse(pick(formData, [...LEAD_FIELD_NAMES, "status_id", "disqualify_reason"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  // LEAD-01: campaign, budget and UTM
  const campaign = leadCampaignSchema.safeParse(pick(formData, LEAD_CAMPAIGN_FIELD_NAMES));
  if (!campaign.success) {
    return invalid(campaign.error, formData);
  }

  // RVW-9: the same rules as a status change (no "converted"; "not relevant" needs a reason)
  const choice = await validateStatusChoice(context.supabase, orgId, parsed.data.status_id, parsed.data.disqualify_reason ?? null);
  if (!choice.ok) {
    const field = choice.needsReason ? "disqualify_reason" : "status_id";
    return fail(choice.message, { fieldErrors: { [field]: choice.message }, values: formValues(formData) });
  }

  const custom = await customFieldsFromForm(orgId, "lead", formData, undefined, ["builtin:status", "builtin:source"]);
  if (!custom.ok) {
    return custom;
  }
  // LEAD-04: only when the form has the field (the plan has the product catalog)
  const product = requestedProductFromForm(formData);
  if (!product.ok) {
    return fail(product.message, { fieldErrors: { requested_product_id: product.message }, values: formValues(formData) });
  }

  // A repeat lead (same phone or email as a lead or contact the user can see)
  // is pointed out first; the user may still create a new one.
  if (formData.get("allow_duplicate") !== "on") {
    const duplicate = await findPersonDuplicate(context.supabase, orgId, [parsed.data.phone], [parsed.data.email]);
    if (duplicate) {
      return fail(duplicateMessage(duplicate, "הטלפון או האימייל האלה"), {
        fieldErrors: { allow_duplicate: duplicate.href },
        values: formValues(formData),
      });
    }
  }

  // owner_id is left out: the database assigns the lead to its creator.
  const { data, error } = await context.supabase
    .from("leads")
    .insert({
      organization_id: orgId,
      ...parsed.data,
      ...campaignInsert(campaign.data),
      disqualify_reason: choice.reason,
      ...product.patch,
      ...customFieldsPatch(custom.customFields),
    })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את הליד. נסו שוב."), { values: formValues(formData) });
  }

  revalidateLead(orgId);
  redirect(paths.lead(orgId, data.id));
}

export async function updateLeadAction(
  orgId: string,
  leadId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, leadId);
  if (!context.ok) {
    return context;
  }
  const parsed = updateLeadSchema.safeParse(pick(formData, LEAD_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  // LEAD-01: campaign, budget and UTM (utm is merged in the database, utm.extra stays).
  // Written only when the form carries them, so a form without them never empties them.
  const withCampaign = LEAD_CAMPAIGN_FIELD_NAMES.every((name) => formData.has(name));
  const campaign = leadCampaignSchema.safeParse(pick(formData, LEAD_CAMPAIGN_FIELD_NAMES));
  if (withCampaign && !campaign.success) {
    return invalid(campaign.error, formData);
  }
  const campaignPatch = withCampaign && campaign.success ? campaignUpdate(campaign.data) : {};

  const custom = await customFieldsFromForm(orgId, "lead", formData, leadId, ["builtin:source"]);
  if (!custom.ok) {
    return custom;
  }
  // LEAD-04: only when the form has the field (the plan has the product catalog)
  const product = requestedProductFromForm(formData);
  if (!product.ok) {
    return fail(product.message, { fieldErrors: { requested_product_id: product.message }, values: formValues(formData) });
  }

  const { data, error } = await context.supabase
    .from("leads")
    .update({ ...parsed.data, ...campaignPatch, ...product.patch, ...customFieldsPatch(custom.customFields) })
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השינויים. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  revalidateLead(orgId, leadId);
  return ok();
}

export async function changeLeadStatusAction(
  orgId: string,
  leadId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, leadId);
  if (!context.ok) {
    return context;
  }
  const parsed = changeStatusSchema.safeParse(pick(formData, ["status_id", "disqualify_reason"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const result = await setLeadStatus(context.supabase, orgId, leadId, parsed.data.status_id, parsed.data.disqualify_reason ?? null);
  if (!result.ok) {
    return result.needsReason
      ? fail(result.message, { fieldErrors: { disqualify_reason: result.message }, values: formValues(formData) })
      : fail(result.message);
  }

  revalidateLead(orgId, leadId);
  return ok();
}

/**
 * From the leads board: a card dropped on another status (a reason comes with "not relevant"). FLD-09:
 * when the status would leave conditionally required fields empty, nothing is saved and the answer
 * names them (missing), so the board asks for them and saves with moveLeadWithFieldsAction.
 */
export async function dropLeadAction(orgId: string, leadId: string, statusId: string, reason: string | null): Promise<ActionResult | MissingResult> {
  if (!validArg(optionalTextArg(500), reason)) return fail(INVALID_ARGS);
  if (!isUuid(statusId)) {
    return fail("הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.");
  }
  const context = await actionContext(orgId, leadId);
  if (!context.ok) {
    return context;
  }
  const trimmed = reason?.trim().slice(0, 500) || null;
  const missing = await missingLeadFields(orgId, leadId, statusId);
  if (missing) return missing;
  const result = await setLeadStatus(context.supabase, orgId, leadId, statusId, trimmed);
  if (!result.ok) {
    return fail(result.message);
  }
  revalidateLead(orgId, leadId);
  return ok();
}

/** FLD-09: the fields the new status would leave required and empty, as a refusal; null when none. */
async function missingLeadFields(orgId: string, leadId: string, statusId: string): Promise<MissingResult | ActionResult | null> {
  const found = await missingAfterChange(orgId, "lead", [leadId], { "builtin:status": statusId });
  if (!found.ok) return fail(dbErrorMessage(found.error));
  const fields = found.missing.get(leadId);
  return fields ? { ok: false, message: missingFieldsMessage(fields), missing: fields.map(askedField) } : null;
}

/**
 * FLD-09: the window's answer: the status (and a "not relevant" reason) with the values the status
 * makes required, in one update. Refuses with field errors while a value is still missing or invalid.
 */
export async function moveLeadWithFieldsAction(orgId: string, leadId: string, statusId: string, reason: string | null, formData: FormData): Promise<ActionResult> {
  if (!validArg(optionalTextArg(500), reason)) return fail(INVALID_ARGS);
  if (!isUuid(statusId)) return fail("הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.");
  const context = await actionContext(orgId, leadId);
  if (!context.ok) return context;
  const merge = await requiredFieldsMerge(orgId, "lead", leadId, { "builtin:status": statusId }, formData);
  if (!merge.ok) return fail(merge.message, { fieldErrors: merge.fieldErrors, values: formValues(formData) });
  const result = await setLeadStatus(context.supabase, orgId, leadId, statusId, reason?.trim().slice(0, 500) || null, merge.merge);
  if (!result.ok) return fail(result.message, { values: formValues(formData) });
  revalidateLead(orgId, leadId);
  return ok();
}

function isConvertResult(value: unknown): value is ConvertLeadResult {
  return typeof value === "object" && value !== null && typeof (value as ConvertLeadResult).contact_id === "string";
}

/** Lead -> contact (+ company when the lead has one) (+ deal), in one database transaction. */
export async function convertLeadAction(
  orgId: string,
  leadId: string,
  _prev: FormState<{ contactId: string; dealId: string | null }>,
  formData: FormData,
): Promise<FormState<{ contactId: string; dealId: string | null }>> {
  const context = await actionContext(orgId, leadId);
  if (!context.ok) {
    return context;
  }
  const parsed = convertLeadSchema.safeParse(pick(formData, ["create_deal", "deal_name", "amount"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // convert_lead looks the lead up by id only, so first make sure it belongs
  // to the organization in the URL (RLS hides it otherwise).
  const { data: lead, error: leadError } = await context.supabase
    .from("leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (leadError) return fail(dbErrorMessage(leadError));
  if (!lead) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }

  const { data, error } = await context.supabase.rpc("convert_lead", {
    p_lead_id: leadId,
    p_create_deal: parsed.data.create_deal,
    p_deal_name: parsed.data.deal_name,
    p_amount_agorot: parsed.data.create_deal ? parsed.data.amount : 0,
  });
  if (error || !isConvertResult(data)) {
    return fail(conversionErrorMessage(error, "לא הצלחנו להמיר את הליד. נסו שוב."), { values: formValues(formData) });
  }

  revalidateLead(orgId, leadId);
  revalidatePath(paths.contacts(orgId));
  revalidatePath(paths.deals(orgId));
  return ok({ contactId: data.contact_id, dealId: data.deal_id }, "הליד הומר.");
}

/** Moves the lead to the recycle bin (soft delete). Admins and managers only; the database enforces it. */
export async function trashLeadAction(orgId: string, leadId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, leadId);
  if (!context.ok) {
    return context;
  }
  const result = await setTrashed(context.supabase, "leads", orgId, leadId, true);
  if (!result.ok) {
    return result;
  }
  revalidateLead(orgId, leadId);
  redirect(paths.leads(orgId));
}
