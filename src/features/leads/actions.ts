"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { ConvertLeadResult } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { changeStatusSchema, convertLeadSchema, createLeadSchema, LEAD_FIELD_NAMES, updateLeadSchema } from "./schema";

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
  const parsed = createLeadSchema.safeParse(pick(formData, [...LEAD_FIELD_NAMES, "status_id"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // owner_id is left out: the database assigns the lead to its creator.
  const { data, error } = await context.supabase
    .from("leads")
    .insert({ organization_id: orgId, ...parsed.data })
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

  const { data, error } = await context.supabase
    .from("leads")
    .update(parsed.data)
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

  // The status must belong to this organization; its kind decides the rules.
  const { data: status } = await context.supabase
    .from("lead_statuses")
    .select("id, kind")
    .eq("organization_id", orgId)
    .eq("id", parsed.data.status_id)
    .maybeSingle();
  if (!status) {
    return fail("הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.");
  }
  if (status.kind === "converted") {
    return fail('כדי לסמן ליד כ"הומר" יש להשתמש בכפתור ההמרה.');
  }
  if (status.kind === "disqualified" && !parsed.data.disqualify_reason) {
    return fail("יש לציין למה הליד לא רלוונטי.", {
      fieldErrors: { disqualify_reason: "יש לציין סיבה." },
      values: formValues(formData),
    });
  }

  const { data, error } = await context.supabase
    .from("leads")
    .update({
      status_id: status.id,
      disqualify_reason: status.kind === "disqualified" ? parsed.data.disqualify_reason : null,
    })
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את הסטטוס. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }

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
  const { data: lead } = await context.supabase
    .from("leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .is("deleted_at", null)
    .maybeSingle();
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
    return fail(dbErrorMessage(error, "לא הצלחנו להמיר את הליד. נסו שוב."), { values: formValues(formData) });
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

  const { data, error } = await context.supabase
    .from("leads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להעביר את הליד לסל המחזור. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }

  revalidateLead(orgId, leadId);
  redirect(paths.leads(orgId));
}
