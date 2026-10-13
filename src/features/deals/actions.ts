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
import { TIME_ZONE } from "@/lib/app";
import { zoneDate, zonedIso } from "@/lib/format";

import { DEAL_LOSS_FIELD_NAMES, dealLossSchema, type DealLoss } from "@/features/deal-loss-reasons/schema";

import { closedAtFor, parseCloseWon } from "./close-window";
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

/**
 * DEAL-03: the reason and competitor sent with a form, only when the form shows
 * them (a move to a lost stage, the edit form of a lost deal). Absent: undefined.
 */
function lossFromForm(formData: FormData): { ok: true; loss: DealLoss | undefined } | { ok: false; state: FormState } {
  if (!formData.has("lost_reason_id") && !formData.has("competitor")) {
    return { ok: true, loss: undefined };
  }
  const parsed = dealLossSchema.safeParse(pick(formData, DEAL_LOSS_FIELD_NAMES));
  return parsed.success ? { ok: true, loss: parsed.data } : { ok: false, state: invalid(parsed.error, formData) };
}

async function moveDeal(orgId: string, dealId: string, stageId: string, loss?: DealLoss): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId, stageId);
  if (!context.ok) {
    return context;
  }
  // A stage of another pipeline (or organization) is rejected by the
  // (pipeline_id, stage_id) foreign key: SQLSTATE 23503. A reason on a stage
  // that is not lost is dropped by the database (deals_sync_stage_loss).
  const { data, error } = await context.supabase
    .from("deals")
    .update({ stage_id: stageId, ...(loss ?? {}) })
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
  const loss = lossFromForm(formData);
  if (!loss.ok) {
    return loss.state;
  }
  return moveDeal(orgId, dealId, parsed.data.stage_id, loss.loss);
}

/** DEAL-03: the reason and competitor of a deal that was just dropped on a lost stage. */
export async function setDealLossAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const parsed = dealLossSchema.safeParse(pick(formData, DEAL_LOSS_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("deals")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הסיבה. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDeal(orgId, dealId);
  return ok();
}

const CLOSE_TASK_FAILED = "העסקה סומנה כזכייה, אבל משימת הקליטה לא נוצרה. אפשר לנסות שוב, או לסגור ולהוסיף משימה מדף העסקה.";

/**
 * DEAL-04, the close window: moves a deal into a won stage with the confirmed
 * amount and close date, then, when asked, adds an onboarding task linked to the
 * deal (and to its contact and company when the user can see them), all with the
 * user's session. The deal is not moved until the form is sent; cancelling leaves it.
 */
export async function closeDealWonAction(orgId: string, dealId: string, stageId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId, stageId);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const values = { values: formValues(formData) };

  const [{ data: org, error: orgError }, { data: stage, error: stageError }] = await Promise.all([
    supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
    supabase.from("stages").select("id, kind").eq("organization_id", orgId).eq("id", stageId).maybeSingle(),
  ]);
  if (orgError) return fail(dbErrorMessage(orgError), values);
  if (stageError) return fail(dbErrorMessage(stageError), values);
  if (!org) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (!stage || stage.kind !== "won") return fail(STAGE_GONE, values);

  const timeZone = org.timezone || TIME_ZONE;
  const now = new Date();
  const today = zoneDate(now, timeZone);
  const parsed = parseCloseWon(formData, today);
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const close = parsed.data;

  const { data: moved, error } = await supabase
    .from("deals")
    .update({ stage_id: stageId, amount_agorot: close.amount, closed_at: closedAtFor(close.closedDate, today, now, timeZone) })
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .select("id, contact_id, company_id");
  if (error) {
    return fail(error.code === "23503" ? STAGE_GONE : dbErrorMessage(error, "לא הצלחנו לסגור את העסקה. נסו שוב."), values);
  }
  if (moved.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDeal(orgId, dealId);

  if (close.task) {
    const deal = moved[0];
    // a task may link only records the user can see (tasks_insert, migration 0074): link the
    // deal's contact and company only when they can be read with this session
    const [contact, company] = await Promise.all([
      deal.contact_id
        ? supabase.from("contacts").select("id").eq("organization_id", orgId).eq("id", deal.contact_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      deal.company_id
        ? supabase.from("companies").select("id").eq("organization_id", orgId).eq("id", deal.company_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    // the window offers the deal's owner first; no choice: the task is the user's (database default)
    const owner = close.task.ownerId;
    const { error: taskError } = await supabase.from("tasks").insert({
      organization_id: orgId,
      title: close.task.title,
      task_type: "todo",
      priority: 2,
      // a day without a time is due at the start of the working day, like the task form
      due_at: close.task.dueDate ? zonedIso(close.task.dueDate, "09:00:00", timeZone) : null,
      deal_id: dealId,
      contact_id: !contact.error && contact.data ? contact.data.id : null,
      company_id: !company.error && company.data ? company.data.id : null,
      ...(owner ? { owner_id: owner } : {}),
    });
    if (taskError) {
      return fail(`${CLOSE_TASK_FAILED} (${dbErrorMessage(taskError)})`, values);
    }
    revalidatePath(paths.tasks(orgId));
  }
  return ok();
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
  const loss = lossFromForm(formData);
  if (!loss.ok) {
    return loss.state;
  }
  const { amount, ...rest } = parsed.data;
  const { data, error } = await context.supabase
    .from("deals")
    .update({ ...rest, amount_agorot: amount, ...(loss.loss ?? {}), ...customFieldsPatch(custom.customFields) })
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
