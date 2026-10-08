"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { customFieldsFromForm, customFieldsPatch } from "@/features/custom-fields/server";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { setTrashed } from "@/lib/record-trash";
import { isUuid } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { createDealSchema, DEAL_FIELD_NAMES, moveDealSchema, UPDATE_DEAL_FIELD_NAMES, updateDealSchema } from "./schema";

function revalidateDeal(orgId: string, dealId?: string) {
  revalidatePath(paths.deals(orgId));
  revalidatePath(paths.org(orgId));
  if (dealId) {
    revalidatePath(paths.deal(orgId, dealId));
  }
}

const STAGE_GONE = "השלב שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.";

export async function createDealAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createDealSchema.safeParse(pick(formData, DEAL_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const custom = await customFieldsFromForm(orgId, "deal", formData);
  if (!custom.ok) {
    return custom;
  }

  // The pipeline comes from the stage, read from the database, not from the form.
  const { data: stage, error: stageError } = await context.supabase
    .from("stages")
    .select("id, pipeline_id")
    .eq("organization_id", orgId)
    .eq("id", parsed.data.stage_id)
    .maybeSingle();
  if (stageError) return fail(dbErrorMessage(stageError), { values: formValues(formData) });
  if (!stage) {
    return fail(STAGE_GONE, { values: formValues(formData) });
  }

  // status / probability / closed_at are set by the database from the stage;
  // owner_id defaults to the creator.
  const { data, error } = await context.supabase.from("deals").insert({
    organization_id: orgId,
    name: parsed.data.name,
    amount_agorot: parsed.data.amount,
    pipeline_id: stage.pipeline_id,
    stage_id: stage.id,
    contact_id: parsed.data.contact_id,
    company_id: parsed.data.company_id,
    expected_close_date: parsed.data.expected_close_date,
    ...customFieldsPatch(custom.customFields),
  }).select("id").single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את העסקה. נסו שוב."), { values: formValues(formData) });
  }

  revalidateDeal(orgId);
  if (parsed.data.contact_id) {
    revalidatePath(paths.contact(orgId, parsed.data.contact_id));
  }
  if (parsed.data.company_id) {
    revalidatePath(paths.company(orgId, parsed.data.company_id));
  }
  redirect(paths.deal(orgId, data.id));
}

async function moveDeal(orgId: string, dealId: string, stageId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId, stageId);
  if (!context.ok) {
    return context;
  }
  // A stage of another pipeline (or organization) is rejected by the
  // (pipeline_id, stage_id) foreign key: SQLSTATE 23503.
  const { data, error } = await context.supabase
    .from("deals")
    .update({ stage_id: stageId })
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(error.code === "23503" ? STAGE_GONE : dbErrorMessage(error, "לא הצלחנו להעביר את העסקה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDeal(orgId, dealId);
  return ok();
}

/** Moves a deal to another stage of its pipeline (stage menu). The database logs the move on the deal's timeline. */
export async function moveDealAction(
  orgId: string,
  dealId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = moveDealSchema.safeParse(pick(formData, ["stage_id"]));
  if (!parsed.success) {
    return invalid(parsed.error);
  }
  return moveDeal(orgId, dealId, parsed.data.stage_id);
}

/** Same move, from drag and drop on the board. */
export async function dropDealAction(orgId: string, dealId: string, stageId: string): Promise<ActionResult> {
  if (!isUuid(stageId)) {
    return fail(STAGE_GONE);
  }
  return moveDeal(orgId, dealId, stageId);
}

export async function updateDealAction(
  orgId: string,
  dealId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const parsed = updateDealSchema.safeParse(pick(formData, UPDATE_DEAL_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const custom = await customFieldsFromForm(orgId, "deal", formData, dealId);
  if (!custom.ok) {
    return custom;
  }
  const { lost_reason, amount, ...rest } = parsed.data;
  const { data, error } = await context.supabase
    .from("deals")
    .update({ ...rest, amount_agorot: amount, lost_reason, ...customFieldsPatch(custom.customFields) })
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השינויים. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidateDeal(orgId, dealId);
  return { ok: true };
}

export async function trashDealAction(orgId: string, dealId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const result = await setTrashed(context.supabase, "deals", orgId, dealId, true);
  if (!result.ok) {
    return result;
  }
  revalidateDeal(orgId, dealId);
  redirect(paths.deals(orgId));
}
