"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { applyTemplate } from "@/features/industry-templates/apply";
import { describeApplyResult } from "@/features/industry-templates/schema";
import { industryTemplate } from "@/features/industry-templates/templates";
import { ORG_STATUS_NOTICES } from "@/features/shell/labels";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { SETUP_DETAILS_FIELDS, setupDetailsSchema, setupIndustrySchema, setupStepArg } from "./schema";
import { alreadyPast, progressWrite, stepAfter, WRITABLE_ORG_STATUSES, type SetupStep } from "./steps";

type OrgUpdate = Database["public"]["Tables"]["organizations"]["Update"];
type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

const READ_ONLY = "העסק במצב קריאה בלבד. אפשר לצפות בנתונים, אבל לא להוסיף או לשנות.";
const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/**
 * The database lets admins edit a read-only organization's profile; the wizard
 * follows the general rule instead, like its page: nothing changes while the
 * business is read-only. Returns an error message, or null when writable.
 */
async function refuseReadOnly(supabase: Supabase, orgId: string): Promise<string | null> {
  const { data, error } = await supabase.from("organizations").select("status").eq("id", orgId).maybeSingle();
  if (error) {
    return dbErrorMessage(error);
  }
  if (!data) {
    return NOT_FOUND_OR_FORBIDDEN;
  }
  return WRITABLE_ORG_STATUSES.includes(data.status) ? null : (ORG_STATUS_NOTICES[data.status] ?? READ_ONLY);
}

/**
 * Moves the progress forward in one conditional update (never back; a finished
 * wizard stays finished), with the user's session. Only owners and admins pass
 * the update policy. Returns an error message, or null on success.
 */
async function writeProgress(supabase: Supabase, orgId: string, done: SetupStep): Promise<string | null> {
  const write = progressWrite(done);
  let query = supabase.from("organizations").update({ setup_step: write.setTo }).eq("id", orgId);
  if (write.onlyBelow) {
    // null (finished) is not below anything, so it is left alone too
    query = query.lt("setup_step", write.setTo);
  }
  const { data, error } = await query.select("id");
  if (error) {
    return dbErrorMessage(error, SAVE_FAILED);
  }
  if (data.length > 0 || !write.onlyBelow) {
    return data.length > 0 ? null : NOT_FOUND_OR_FORBIDDEN;
  }
  // 0 rows: already at or past that step (fine), or not permitted. Tell them apart.
  const check = await supabase.from("organizations").select("setup_step").eq("id", orgId).maybeSingle();
  if (check.error) {
    return dbErrorMessage(check.error);
  }
  if (!check.data || !alreadyPast(check.data.setup_step, write.setTo)) {
    return NOT_FOUND_OR_FORBIDDEN;
  }
  // a non-admin can read the row too, so prove the right to write it: a no-op update of the progress
  const proof = await supabase
    .from("organizations")
    .update({ setup_step: check.data.setup_step })
    .eq("id", orgId)
    .select("id");
  if (proof.error) {
    return dbErrorMessage(proof.error, SAVE_FAILED);
  }
  return proof.data.length > 0 ? null : NOT_FOUND_OR_FORBIDDEN;
}

/**
 * Saves the changes of a step (if any), runs `afterSave` (if any), moves the
 * progress forward, and goes on to the next step (or `goTo`). When `afterSave`
 * returns a notice, the step stays on screen to show it (the progress has
 * still moved forward).
 */
async function saveStep(
  orgId: string,
  done: SetupStep,
  changes: OrgUpdate | null,
  formData?: FormData,
  // where to go afterwards; default: the next step, or the home page after the last one
  goTo?: string,
  afterSave?: (supabase: Supabase) => Promise<{ ok: false; message: string } | { ok: true; notice: string | null }>,
): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const values = formData ? formValues(formData) : undefined;
  const readOnly = await refuseReadOnly(context.supabase, orgId);
  if (readOnly) {
    return fail(readOnly, { values });
  }

  if (changes) {
    const { data, error } = await context.supabase.from("organizations").update(changes).eq("id", orgId).select("id");
    if (error) {
      return fail(dbErrorMessage(error, SAVE_FAILED), { values });
    }
    if (data.length === 0) {
      return fail(NOT_FOUND_OR_FORBIDDEN, { values });
    }
  }
  const extra = afterSave ? await afterSave(context.supabase) : null;
  if (extra && !extra.ok) {
    return fail(extra.message, { values });
  }
  const progressError = await writeProgress(context.supabase, orgId, done);
  if (progressError) {
    return fail(progressError, { values });
  }

  // the name shows in the header of every page, and the home page shows the progress
  revalidatePath(paths.org(orgId), "layout");
  if (extra?.notice) {
    return { ok: true, message: extra.notice };
  }
  const next = stepAfter(done);
  redirect(goTo ?? (next ? paths.setup(orgId, next) : paths.org(orgId)));
}

/** Step 1: business details, by the rules of the business details page. */
export async function saveSetupDetailsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = setupDetailsSchema.safeParse(pick(formData, SETUP_DETAILS_FIELDS));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  return saveStep(
    orgId,
    1,
    {
      name: parsed.data.name,
      team_size: parsed.data.team_size || null,
      phone: parsed.data.phone,
      record_visibility: parsed.data.record_visibility,
    },
    formData,
  );
}

/**
 * Step 2: the industry, and with "apply" its template (FLD-05). When a plan
 * limit left part of the template out, the step stays on screen to say so.
 */
export async function saveSetupIndustryAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = setupIndustrySchema.safeParse(pick(formData, ["industry"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const industry = parsed.data.industry || null;
  const template = formData.get("apply") === "1" ? industryTemplate(industry) : null;
  if (formData.get("apply") === "1" && !template) {
    const message = "יש לבחור ענף כדי להחיל את התבנית שלו.";
    return fail(message, { fieldErrors: { industry: message }, values: formValues(formData) });
  }
  const afterSave = template
    ? async (supabase: Supabase) => {
        const result = await applyTemplate(supabase, orgId, template.industry);
        if (!result.ok) {
          return result;
        }
        return { ok: true as const, notice: result.data!.limits.length > 0 ? describeApplyResult(result.data!) : null };
      }
    : undefined;
  return saveStep(orgId, 2, { industry }, formData, undefined, afterSave);
}

/** Skips a step, or moves on from a step that has nothing to save (3, and 4 = finish). */
export async function continueSetupAction(orgId: string, step: number): Promise<FormState> {
  if (!validArg(setupStepArg, step)) {
    return fail(INVALID_ARGS);
  }
  return saveStep(orgId, step as SetupStep, null);
}

/** Step 3: moves the wizard on to step 4 and opens the import wizard (the user comes back from the home page). */
export async function startSetupImportAction(orgId: string): Promise<FormState> {
  return saveStep(orgId, 3, null, undefined, paths.importNew(orgId));
}

/** Closes the wizard from the home page without going through the remaining steps. */
export async function finishSetupAction(orgId: string): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const readOnly = await refuseReadOnly(context.supabase, orgId);
  if (readOnly) {
    return fail(readOnly);
  }
  const { data, error } = await context.supabase.from("organizations").update({ setup_step: null }).eq("id", orgId).select("id");
  if (error) {
    return fail(dbErrorMessage(error, SAVE_FAILED));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.org(orgId));
  return { ok: true };
}
