"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { customFieldsFromForm, customFieldsPatch } from "@/features/custom-fields/server";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, optionalTextArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { must } from "@/lib/db-read";
import type { ConvertLeadResult } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { normalizePhone } from "@/lib/phone";
import { setTrashed } from "@/lib/record-trash";
import { pick } from "@/lib/validation";

import { changeStatusSchema, convertLeadSchema, createLeadSchema, LEAD_FIELD_NAMES, updateLeadSchema } from "./schema";
import { setLeadStatus, validateStatusChoice } from "./status";

function revalidateLead(orgId: string, leadId?: string) {
  revalidatePath(paths.leads(orgId));
  revalidatePath(paths.org(orgId));
  if (leadId) {
    revalidatePath(paths.lead(orgId, leadId));
  }
}

type Existing = { kind: "lead" | "contact"; name: string; href: string };

/** The newest live, unconverted lead, else contact, with this phone (normalized) or email. */
async function findExisting(
  supabase: Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"],
  orgId: string,
  phone: string | null,
  email: string | null,
): Promise<Existing | null> {
  const e164 = normalizePhone(phone);
  // emails are stored lower-cased; quoting keeps "," and ")" in a value harmless
  const filters = [e164 ? `phone_e164.eq."${e164}"` : null, email ? `email.eq."${email.toLowerCase().replace(/"/g, "")}"` : null].filter(Boolean);
  if (filters.length === 0) {
    return null;
  }
  for (const kind of ["lead", "contact"] as const) {
    let query = supabase
      .from(kind === "lead" ? "leads" : "contacts")
      .select("id, full_name, phone, email")
      .eq("organization_id", orgId)
      .is("deleted_at", null);
    // a converted lead lives on as its contact, which is the record to open
    if (kind === "lead") {
      query = query.is("converted_at", null);
    }
    const data = must(await query
      .or(filters.join(","))
      .order("created_at", { ascending: false })
      .limit(1), "duplicate search");
    const row = data?.[0];
    if (row) {
      return {
        kind,
        name: row.full_name || row.email || row.phone || "ללא שם",
        href: kind === "lead" ? paths.lead(orgId, row.id) : paths.contact(orgId, row.id),
      };
    }
  }
  return null;
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

  // RVW-9: the same rules as a status change (no "converted"; "not relevant" needs a reason)
  const choice = await validateStatusChoice(context.supabase, orgId, parsed.data.status_id, parsed.data.disqualify_reason ?? null);
  if (!choice.ok) {
    const field = choice.needsReason ? "disqualify_reason" : "status_id";
    return fail(choice.message, { fieldErrors: { [field]: choice.message }, values: formValues(formData) });
  }

  const custom = await customFieldsFromForm(orgId, "lead", formData);
  if (!custom.ok) {
    return custom;
  }

  // A repeat lead (same phone or email as a lead or contact the user can see)
  // is pointed out first; the user may still create a new one.
  if (formData.get("allow_duplicate") !== "on") {
    const duplicate = await findExisting(context.supabase, orgId, parsed.data.phone, parsed.data.email);
    if (duplicate) {
      return fail(`כבר קיים ${duplicate.kind === "lead" ? "ליד" : "איש קשר"} עם הטלפון או האימייל האלה: ${duplicate.name}.`, {
        fieldErrors: { allow_duplicate: duplicate.href },
        values: formValues(formData),
      });
    }
  }

  // owner_id is left out: the database assigns the lead to its creator.
  const { data, error } = await context.supabase
    .from("leads")
    .insert({ organization_id: orgId, ...parsed.data, disqualify_reason: choice.reason, ...customFieldsPatch(custom.customFields) })
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

  const custom = await customFieldsFromForm(orgId, "lead", formData, leadId);
  if (!custom.ok) {
    return custom;
  }

  const { data, error } = await context.supabase
    .from("leads")
    .update({ ...parsed.data, ...customFieldsPatch(custom.customFields) })
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

/** From the leads board: a card dropped on another status (a reason comes with "not relevant"). */
export async function dropLeadAction(orgId: string, leadId: string, statusId: string, reason: string | null): Promise<ActionResult> {
  if (!validArg(optionalTextArg(500), reason)) return fail(INVALID_ARGS);
  if (!isUuid(statusId)) {
    return fail("הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.");
  }
  const context = await actionContext(orgId, leadId);
  if (!context.ok) {
    return context;
  }
  const trimmed = reason?.trim().slice(0, 500) || null;
  const result = await setLeadStatus(context.supabase, orgId, leadId, statusId, trimmed);
  if (!result.ok) {
    return fail(result.message);
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
  const result = await setTrashed(context.supabase, "leads", orgId, leadId, true);
  if (!result.ok) {
    return result;
  }
  revalidateLead(orgId, leadId);
  redirect(paths.leads(orgId));
}
