"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { customFieldsFromForm, customFieldsPatch } from "@/features/custom-fields/server";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { setTrashed } from "@/lib/record-trash";
import { isUuid } from "@/lib/paths";
import { pick } from "@/lib/validation";
import { TIME_ZONE } from "@/lib/app";
import { zoneDate } from "@/lib/format";

import { DEAL_LOSS_FIELD_NAMES, dealLossSchema, type DealLoss } from "@/features/deal-loss-reasons/schema";

import { closedAtFor, ONBOARDING_EXISTS, parseCloseWon } from "./close-window";
import { insertOnboardingTask, openOnboardingTask } from "./onboarding-server";
import { RECURRING_FIELD_NAMES, recurringSchema, typedDealValue, type RecurringPatch } from "./recurring";
import { createDealSchema, DEAL_FIELD_NAMES, moveDealSchema, UPDATE_DEAL_FIELD_NAMES, updateDealSchema } from "./schema";
import { snoozeSchema } from "./snooze";
import {
  COPY_SKIPPED_PARAM,
  copyCloseDate,
  copyCustomFields,
  copyStage,
  DUPLICATE_FIELD_NAMES,
  duplicateDealSchema,
  firstOpenStage,
  FOLLOW_UP_FIELD_NAMES,
  followUpDealSchema,
  skippedParam,
} from "./copy";

function revalidateDeal(orgId: string, dealId?: string) {
  revalidatePath(paths.deals(orgId));
  revalidatePath(paths.org(orgId));
  if (dealId) {
    revalidatePath(paths.deal(orgId, dealId));
  }
}

/**
 * DEAL-07: the deal fields and the recurring fields of a form, parsed together so every
 * field error shows at once. An empty value field is sent as null: the database then
 * fills the first-year value of a recurring deal (trigger deals_amount_auto).
 */
function parseDealForm<T extends { amount: number }>(
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: ZodError } },
  names: readonly string[],
  formData: FormData,
): { ok: true; data: T; recurring: RecurringPatch; amount: number | null } | { ok: false; state: FormState } {
  const base = schema.safeParse(pick(formData, names));
  const recurring = recurringSchema.safeParse(pick(formData, RECURRING_FIELD_NAMES));
  if (!base.success || !recurring.success) {
    const issues = [...(base.success ? [] : base.error.issues), ...(recurring.success ? [] : recurring.error.issues)];
    return { ok: false, state: invalid(new ZodError(issues), formData) };
  }
  return { ok: true, data: base.data, recurring: recurring.data, amount: typedDealValue(formData.get("amount"), base.data.amount) };
}

const SNOOZE_CLOSED = "אפשר לדחות רק עסקה פתוחה.";
const NO_LONGER_OPEN = "העסקה כבר לא פתוחה. רעננו את הדף.";
const STAGE_GONE = "השלב שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.";

export async function createDealAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseDealForm(createDealSchema, DEAL_FIELD_NAMES, formData);
  if (!parsed.ok) {
    return parsed.state;
  }

  const custom = await customFieldsFromForm(orgId, "deal", formData, undefined, ["builtin:stage"]);
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
    amount_agorot: parsed.amount,
    ...parsed.recurring,
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

// expectOpen: the move is only for a deal that is still open (the forecast's overdue list, GOL-04)
async function moveDeal(orgId: string, dealId: string, stageId: string, loss?: DealLoss, expectOpen = false): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId, stageId);
  if (!context.ok) {
    return context;
  }
  // A stage of another pipeline (or organization) is rejected by the
  // (pipeline_id, stage_id) foreign key: SQLSTATE 23503. A reason on a stage
  // that is not lost is dropped by the database (deals_sync_stage_loss).
  let update = context.supabase
    .from("deals")
    .update({ stage_id: stageId, ...(loss ?? {}) })
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null);
  if (expectOpen) update = update.eq("status", "open");
  const { data, error } = await update.select("id");
  if (error) {
    return fail(error.code === "23503" ? STAGE_GONE : dbErrorMessage(error, "לא הצלחנו להעביר את העסקה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(expectOpen ? NO_LONGER_OPEN : NOT_FOUND_OR_FORBIDDEN);
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
  return moveFromForm(orgId, dealId, formData, false);
}

/** The same move, only while the deal is still open (GOL-04: the forecast's overdue list; 0 rows otherwise). */
export async function moveOpenDealAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  return moveFromForm(orgId, dealId, formData, true);
}

async function moveFromForm(orgId: string, dealId: string, formData: FormData, expectOpen: boolean): Promise<FormState> {
  const parsed = moveDealSchema.safeParse(pick(formData, ["stage_id"]));
  if (!parsed.success) {
    return invalid(parsed.error);
  }
  const loss = lossFromForm(formData);
  if (!loss.ok) {
    return loss.state;
  }
  return moveDeal(orgId, dealId, parsed.data.stage_id, loss.loss, expectOpen);
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

/** DEAL-04: the close window asks, when it opens, whether to offer the onboarding task at all. */
export async function dealOnboardingTaskAction(orgId: string, dealId: string): Promise<ActionResult<{ open: boolean }>> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const found = await openOnboardingTask(context.supabase, orgId, dealId);
  if ("error" in found) {
    return fail(dbErrorMessage(found.error));
  }
  return ok({ open: found.open });
}

/**
 * DEAL-04, the close window: moves a deal into a won stage with the confirmed
 * amount and close date, then, when asked, adds an onboarding task linked to the
 * deal (and to its contact and company when the user can see them), all with the
 * user's session. The deal is not moved until the form is sent; cancelling leaves it.
 */
export async function closeDealWonAction(orgId: string, dealId: string, stageId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  return closeWon(orgId, dealId, stageId, formData, false);
}

/** The close window for a deal that must still be open (GOL-04: the forecast's overdue list). */
export async function closeOpenDealWonAction(orgId: string, dealId: string, stageId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  return closeWon(orgId, dealId, stageId, formData, true);
}

async function closeWon(orgId: string, dealId: string, stageId: string, formData: FormData, expectOpen: boolean): Promise<FormState> {
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

  let update = supabase
    .from("deals")
    // DEAL-07: an emptied value field is sent as null, so a recurring deal gets its first-year value back
    .update({ stage_id: stageId, amount_agorot: typedDealValue(formData.get("amount"), close.amount), closed_at: closedAtFor(close.closedDate, today, now, timeZone) })
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null);
  if (expectOpen) update = update.eq("status", "open");
  const { data: moved, error } = await update.select("id, contact_id, company_id");
  if (error) {
    return fail(error.code === "23503" ? STAGE_GONE : dbErrorMessage(error, "לא הצלחנו לסגור את העסקה. נסו שוב."), values);
  }
  if (moved.length === 0) {
    return fail(expectOpen ? NO_LONGER_OPEN : NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDeal(orgId, dealId);

  if (close.task) {
    // one open onboarding task per deal: another window may have created one meanwhile
    const existing = await openOnboardingTask(supabase, orgId, dealId);
    if ("error" in existing) {
      return fail(`${CLOSE_TASK_FAILED} (${dbErrorMessage(existing.error)})`, values);
    }
    if (existing.open) {
      return { ok: true, message: ONBOARDING_EXISTS };
    }
    const deal = moved[0];
    // the window offers the deal's owner first; no choice: the task is the user's (database default)
    const taskError = await insertOnboardingTask(
      supabase,
      orgId,
      { dealId, contactId: deal.contact_id, companyId: deal.company_id, title: close.task.title, dueDate: close.task.dueDate, ownerId: close.task.ownerId },
      timeZone,
    );
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
  // the recurring fields travel only with a form that shows them (DEAL-07)
  const withRecurring = formData.has("billing_kind");
  const parsed = withRecurring
    ? parseDealForm(updateDealSchema, UPDATE_DEAL_FIELD_NAMES, formData)
    : (() => {
        const plain = updateDealSchema.safeParse(pick(formData, UPDATE_DEAL_FIELD_NAMES));
        return plain.success
          ? { ok: true as const, data: plain.data, recurring: null, amount: typedDealValue(formData.get("amount"), plain.data.amount) }
          : { ok: false as const, state: invalid(plain.error, formData) };
      })();
  if (!parsed.ok) {
    return parsed.state;
  }
  const custom = await customFieldsFromForm(orgId, "deal", formData, dealId);
  if (!custom.ok) {
    return custom;
  }
  const loss = lossFromForm(formData);
  if (!loss.ok) {
    return loss.state;
  }
  const { name, contact_id, company_id, expected_close_date } = parsed.data;
  const { data, error } = await context.supabase
    .from("deals")
    .update({ name, contact_id, company_id, expected_close_date, amount_agorot: parsed.amount, ...(parsed.recurring ?? {}), ...(loss.loss ?? {}), ...customFieldsPatch(custom.customFields) })
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

/**
 * Postpones a deal to a day (it is not stuck before then), or clears the postponement
 * (field clear = 1). Written with the user's session: whoever may edit the deal.
 */
export async function snoozeDealAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const { data: org, error: orgError } = await context.supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (orgError) return fail(dbErrorMessage(orgError));
  if (!org) return fail(NOT_FOUND_OR_FORBIDDEN);
  // only an open deal is postponed; a closed one is never stuck
  const { data: deal, error: dealError } = await context.supabase
    .from("deals")
    .select("status")
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .maybeSingle();
  if (dealError) return fail(dbErrorMessage(dealError));
  if (!deal) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (deal.status !== "open") return fail(SNOOZE_CLOSED);
  let until: string | null = null;
  if (formData.get("clear") !== "1") {
    const parsed = snoozeSchema(zoneDate(new Date(), org.timezone || TIME_ZONE)).safeParse(pick(formData, ["snoozed_until"]));
    if (!parsed.success) {
      return invalid(parsed.error, formData);
    }
    until = parsed.data.snoozed_until;
  }
  const { data, error } = await context.supabase
    .from("deals")
    .update({ snoozed_until: until })
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .eq("status", "open")
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    // closed in the meantime, deleted, or not permitted
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDeal(orgId, dealId);
  return ok();
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

const COPY_FAILED = "לא הצלחנו ליצור את העסקה. נסו שוב.";
const NO_OPEN_STAGE = "בתהליך המכירה הזה אין שלב פתוח. אפשר להוסיף שלב בהגדרות.";

/**
 * DEAL-11: a copy of a deal, written with the user's session through the ordinary insert,
 * so every deal trigger applies (stage, owner = the user, team, record limit, audit,
 * automations). It carries the name ("עותק של …" by default), pipeline, amount, contact,
 * company, source, a close date that has not passed, tags and custom fields; it starts in
 * the first open stage unless the user keeps the deal's open stage. Never copied: the
 * closed state and its date, loss reason and competitor, time in stage, postponement,
 * timeline, tasks, files, followers and the deal's other contacts.
 */
export async function duplicateDealAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const values = { values: formValues(formData) };
  const parsed = duplicateDealSchema.safeParse(pick(formData, DUPLICATE_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const { data: deal, error: dealError } = await supabase
    .from("deals")
    .select("id, pipeline_id, stage_id, amount_agorot, contact_id, company_id, source_id, expected_close_date, tag_ids, custom_fields, billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date, amount_auto")
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .maybeSingle();
  if (dealError) return fail(dbErrorMessage(dealError), values);
  if (!deal) return fail(NOT_FOUND_OR_FORBIDDEN);

  const [{ data: stages, error: stagesError }, { data: org, error: orgError }, fields] = await Promise.all([
    supabase.from("stages").select("id, kind").eq("organization_id", orgId).eq("pipeline_id", deal.pipeline_id).order("position", { ascending: true }),
    supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
    // a failed read is an answer here, not a thrown error
    listFieldDefinitions(orgId, "deal").then(
      (definitions) => ({ definitions, error: null }),
      (error: unknown) => ({ definitions: [], error }),
    ),
  ]);
  if (fields.error) return fail(dbErrorMessage(fields.error), values);
  if (stagesError) return fail(dbErrorMessage(stagesError), values);
  if (orgError) return fail(dbErrorMessage(orgError), values);
  const stage = copyStage(stages, deal.stage_id, parsed.data.keep_stage);
  if (!stage) return fail(NO_OPEN_STAGE, values);
  const today = zoneDate(new Date(), org?.timezone || TIME_ZONE);

  const row = {
    organization_id: orgId,
    name: parsed.data.name,
    pipeline_id: deal.pipeline_id,
    stage_id: stage.id,
    // DEAL-07: a computed value is sent empty, so the copy is computed and stays automatic
    amount_agorot: deal.amount_auto === true ? null : deal.amount_agorot,
    // DEAL-07: a copy keeps the deal's recurring terms as they are
    billing_kind: deal.billing_kind,
    recurring_amount_agorot: deal.recurring_amount_agorot,
    recurring_start_date: deal.recurring_start_date,
    renewal_date: deal.renewal_date,
    contact_id: deal.contact_id,
    company_id: deal.company_id,
    source_id: deal.source_id,
    expected_close_date: copyCloseDate(deal.expected_close_date, today),
    tag_ids: deal.tag_ids,
  };
  // values a field no longer accepts are left out, and the new deal's page names those fields
  const custom = copyCustomFields(deal.custom_fields, fields.definitions);
  let skipped: string[] | "all" = custom.skipped;
  let { data, error } = await supabase.from("deals").insert({ ...row, custom_fields: custom.values }).select("id").single();
  if (error?.hint === "custom_field:invalid") {
    // the database still refused one (its rule and the form's differ somewhere): the copy goes without custom fields
    skipped = "all";
    ({ data, error } = await supabase.from("deals").insert(row).select("id").single());
  }
  if (error || !data) {
    return fail(error ? dbErrorMessage(error, COPY_FAILED) : COPY_FAILED, values);
  }
  revalidateDeal(orgId);
  const notice = skippedParam(skipped);
  redirect(notice ? `${paths.deal(orgId, data.id)}?${COPY_SKIPPED_PARAM}=${encodeURIComponent(notice)}` : paths.deal(orgId, data.id));
}

/**
 * DEAL-11: a new open deal for the same customer (contact and company), in a pipeline the
 * user picks, with no amount and the name the user typed. When asked it points back at this
 * deal (deals.previous_deal_id; the database lets a person set it only here, once).
 */
export async function followUpDealAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const values = { values: formValues(formData) };
  const parsed = followUpDealSchema.safeParse(pick(formData, FOLLOW_UP_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const [{ data: deal, error: dealError }, { data: pipeline, error: pipelineError }, { data: stages, error: stagesError }] = await Promise.all([
    supabase.from("deals").select("id, contact_id, company_id").eq("organization_id", orgId).eq("id", dealId).is("deleted_at", null).maybeSingle(),
    supabase.from("pipelines").select("id").eq("organization_id", orgId).eq("id", parsed.data.pipeline_id).is("deleted_at", null).maybeSingle(),
    supabase.from("stages").select("id, kind").eq("organization_id", orgId).eq("pipeline_id", parsed.data.pipeline_id).order("position", { ascending: true }),
  ]);
  if (dealError) return fail(dbErrorMessage(dealError), values);
  if (pipelineError) return fail(dbErrorMessage(pipelineError), values);
  if (stagesError) return fail(dbErrorMessage(stagesError), values);
  if (!deal) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (!pipeline) return fail("תהליך המכירה שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.", values);
  const stage = firstOpenStage(stages);
  if (!stage) return fail(NO_OPEN_STAGE, values);

  const { data, error } = await supabase
    .from("deals")
    .insert({
      organization_id: orgId,
      name: parsed.data.name,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      amount_agorot: 0,
      contact_id: deal.contact_id,
      company_id: deal.company_id,
      previous_deal_id: parsed.data.link ? deal.id : null,
    })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, COPY_FAILED), values);
  }
  revalidateDeal(orgId, dealId);
  if (deal.contact_id) revalidatePath(paths.contact(orgId, deal.contact_id));
  if (deal.company_id) revalidatePath(paths.company(orgId, deal.company_id));
  redirect(paths.deal(orgId, data.id));
}
