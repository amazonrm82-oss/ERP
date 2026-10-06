"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { createDealSchema, DEAL_FIELD_NAMES, moveDealSchema } from "./schema";

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

  // The pipeline comes from the stage, read from the database, not from the form.
  const { data: stage } = await context.supabase
    .from("stages")
    .select("id, pipeline_id")
    .eq("organization_id", orgId)
    .eq("id", parsed.data.stage_id)
    .maybeSingle();
  if (!stage) {
    return fail(STAGE_GONE, { values: formValues(formData) });
  }

  // status / probability / closed_at are set by the database from the stage;
  // owner_id defaults to the creator.
  const { error } = await context.supabase.from("deals").insert({
    organization_id: orgId,
    name: parsed.data.name,
    amount_agorot: parsed.data.amount,
    pipeline_id: stage.pipeline_id,
    stage_id: stage.id,
    contact_id: parsed.data.contact_id,
    expected_close_date: parsed.data.expected_close_date,
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את העסקה. נסו שוב."), { values: formValues(formData) });
  }

  revalidatePath(paths.deals(orgId));
  revalidatePath(paths.org(orgId));
  if (parsed.data.contact_id) {
    revalidatePath(paths.contact(orgId, parsed.data.contact_id));
  }
  redirect(paths.deals(orgId));
}

/** Moves a deal to another stage of its pipeline. The database logs the move on the deal's timeline. */
export async function moveDealAction(
  orgId: string,
  dealId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const parsed = moveDealSchema.safeParse(pick(formData, ["stage_id"]));
  if (!parsed.success) {
    return invalid(parsed.error);
  }

  // A stage of another pipeline (or organization) is rejected by the
  // (pipeline_id, stage_id) foreign key: SQLSTATE 23503.
  const { data, error } = await context.supabase
    .from("deals")
    .update({ stage_id: parsed.data.stage_id })
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

  revalidatePath(paths.deals(orgId));
  revalidatePath(paths.org(orgId));
  return ok();
}
