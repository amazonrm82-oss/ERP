"use server";

import { revalidatePath } from "next/cache";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";
import { z } from "zod";

import { numberingSettingsPath } from "./paths";
import { SERIES_FIELD_NAMES, seriesSchema } from "./schema";
import { SERIES_KINDS, SERIES_LABELS, START_MAX } from "./series";

const SAVE_FAILED = "לא הצלחנו לשמור את המספור. נסו שוב.";
const kindArg = z.enum(SERIES_KINDS);

/**
 * Saves the prefix and the start of one series (QUO-03). Owners and admins of a writable
 * organization only, enforced by RLS (0 rows = not permitted); audited by the database. The
 * start is sent only while the form showed it (no number handed out yet); the database refuses
 * a start change after the first number anyway (hint number_sequences:start_locked).
 */
export async function saveNumberSeriesAction(orgId: string, kind: unknown, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(kindArg, kind)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = seriesSchema.safeParse(pick(formData, SERIES_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const values = parsed.data.start_number === undefined ? { prefix: parsed.data.prefix } : { prefix: parsed.data.prefix, start_number: parsed.data.start_number };
  const update = () => context.supabase.from("number_sequences").update(values).eq("organization_id", orgId).eq("kind", kind).select("id");

  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("number_sequences").insert({ organization_id: orgId, kind, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) {
    return fail(dbErrorMessage(error, SAVE_FAILED), { values: formValues(formData) });
  }
  if ((data?.length ?? 0) === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(numberingSettingsPath(orgId));
  return { ok: true, message: `המספור של ${SERIES_LABELS[kind].title} נשמר.` };
}

const JUMP_FAILED = "לא הצלחנו לשנות את המספר הבא. נסו שוב.";
const nextArg = z.number().int().min(1).max(START_MAX);

/**
 * Moves the next number of a series forward (owner, 14 October 2026). The database decides:
 * public.number_sequence_jump() checks owner/admin of a writable business, locks the series,
 * refuses a number that is not higher (hint number_sequences:not_forward) and writes the audit entry.
 */
export async function jumpNumberSeriesAction(orgId: string, kind: unknown, next: unknown): Promise<ActionResult> {
  if (!validArg(kindArg, kind) || !validArg(nextArg, next)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { error } = await context.supabase.rpc("number_sequence_jump", { p_org: orgId, p_kind: kind, p_next: next });
  if (error) {
    return fail(error.code === "42501" ? NOT_FOUND_OR_FORBIDDEN : dbErrorMessage(error, JUMP_FAILED));
  }
  revalidatePath(numberingSettingsPath(orgId));
  return { ok: true, message: `המסמך הבא של ${SERIES_LABELS[kind].title} יקבל את המספר ${next}.` };
}
